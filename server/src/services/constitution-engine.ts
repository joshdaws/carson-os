/**
 * Constitution Engine -- the core orchestration layer for CarsonOS v3.
 *
 * Processes every message through the constitution pipeline:
 *   1. Load clauses (cached)
 *   2. Pre-execution hard clause evaluation
 *   3. Compile prompt with soft clauses
 *   4. Execute via pluggable adapter
 *   5. Post-execution response scan
 *   6. Record conversation, broadcast events
 */

import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import {
  constitutions,
  constitutionClauses,
  staffAgents,
  familyMembers,
  conversations,
  messages,
  policyEvents,
} from "@carsonos/db";
import type {
  Channel,
  MemberRole,
  EnforcementLevel,
  EvaluationType,
  PolicyEventType,
} from "@carsonos/shared";

import type { MemoryProvider } from "@carsonos/shared";
import type { Adapter } from "./subprocess-adapter.js";
import type { BroadcastFn } from "./event-bus.js";
import {
  evaluateKeywordBlock,
  evaluateAgeGate,
  evaluateRoleRestrict,
  compileSoftRules,
  scanResponse,
  type EvaluationResult,
} from "./evaluators.js";
import { compileSystemPrompt, buildDelegationInstructions } from "./prompt-compiler.js";
import { delegationEdges, activityLog } from "@carsonos/db";
import {
  buildMemorySchemaInstructions,
  DEFAULT_MEMORY_SCHEMA,
} from "./memory/index.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { GoogleCalendarProvider } from "./google/index.js";
import { createCalendarToolHandler, createGmailToolHandler, createDriveToolHandler } from "./google/index.js";

// -- Types -----------------------------------------------------------

interface PolicyEvent {
  clauseId: string;
  eventType: PolicyEventType;
  reason: string;
}

export interface ProcessMessageParams {
  agentId: string;
  memberId: string;
  householdId: string;
  message: string;
  channel: Channel;
  /** Streaming callback — forwarded to the adapter for real-time text deltas */
  onTextDelta?: (text: string) => void;
}

export interface ProcessMessageResult {
  response: string;
  blocked: boolean;
  policyEvents: PolicyEvent[];
}

export interface EngineConfig {
  db: Db;
  broadcast: BroadcastFn;
  adapter: Adapter;
  memoryProvider?: MemoryProvider;
  toolRegistry?: ToolRegistry;
  calendarProvider?: GoogleCalendarProvider;
  /** Feature flags — v1.0 ships with hardEvaluators OFF */
  featureFlags?: {
    hardEvaluators?: boolean;
  };
}

interface CachedConstitution {
  clauses: Array<{
    id: string;
    category: string;
    clauseText: string;
    enforcementLevel: EnforcementLevel;
    evaluationType: EvaluationType;
    evaluationConfig: unknown;
    appliesToRoles: MemberRole[] | null;
    appliesToAgents: string[] | null;
    appliesToMinAge: number | null;
    appliesToMaxAge: number | null;
    sortOrder: number;
  }>;
  constitutionId: string;
  constitutionDocument: string;
  timestamp: number;
}

// -- Constants -------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_HISTORY_MESSAGES = 50;
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours — session expires, falls back to text replay

const FRIENDLY_BLOCK_MESSAGE =
  "I'm not able to help with that. If you think this is a mistake, ask a parent to review the family rules.";

const FRIENDLY_ERROR_MESSAGE =
  "Something went wrong on my end. Please try again in a moment.";

const FRIENDLY_SCAN_REPLACEMENT =
  "I generated a response that didn't meet the family's content rules, so I've held it back. Try rephrasing your question.";

// -- Engine ----------------------------------------------------------

interface SessionCacheEntry {
  sessionId: string;
  lastActivity: number;
  toolCallNames: string[];
}

export class ConstitutionEngine {
  private cache = new Map<string, CachedConstitution>();
  private cachedMemorySchema: string | null = null;
  private sessionCache = new Map<string, SessionCacheEntry>();
  private db: Db;
  private broadcast: BroadcastFn;
  private adapter: Adapter;
  private memoryProvider: MemoryProvider | null;
  private toolRegistry: ToolRegistry | null;
  private calendarProvider: GoogleCalendarProvider | null;
  private hardEvaluatorsEnabled: boolean;

  constructor(config: EngineConfig) {
    this.db = config.db;
    this.broadcast = config.broadcast;
    this.adapter = config.adapter;
    this.memoryProvider = config.memoryProvider ?? null;
    this.toolRegistry = config.toolRegistry ?? null;
    this.calendarProvider = config.calendarProvider ?? null;
    this.hardEvaluatorsEnabled = config.featureFlags?.hardEvaluators ?? false;
  }

  /** Invalidate the clause cache for a household (call after clause edits). */
  invalidateCache(householdId: string): void {
    this.cache.delete(householdId);
  }

  /** Main entry point: process a user message through the full pipeline. */
  async processMessage(
    params: ProcessMessageParams,
  ): Promise<ProcessMessageResult> {
    const { agentId, memberId, householdId, message, channel } = params;
    const collectedEvents: PolicyEvent[] = [];

    // -- 1. Load agent + member info ---------------------------------
    const [agent, member] = await Promise.all([
      this.db
        .select()
        .from(staffAgents)
        .where(eq(staffAgents.id, agentId))
        .then((rows) => rows[0]),
      this.db
        .select()
        .from(familyMembers)
        .where(eq(familyMembers.id, memberId))
        .then((rows) => rows[0]),
    ]);

    if (!agent || !member) {
      return {
        response: FRIENDLY_ERROR_MESSAGE,
        blocked: true,
        policyEvents: [],
      };
    }

    // -- 2. Load constitution clauses (cached) -----------------------
    let cached: CachedConstitution;
    try {
      cached = await this.loadClauses(householdId);
    } catch (err) {
      // Fail closed: if we can't load clauses, block the message
      console.error("[engine] Failed to load constitution clauses:", err);
      return {
        response: FRIENDLY_ERROR_MESSAGE,
        blocked: true,
        policyEvents: [],
      };
    }

    const hardClauses = cached.clauses.filter(
      (c) => c.enforcementLevel === "hard",
    );
    const softClauses = cached.clauses.filter(
      (c) => c.enforcementLevel === "soft" || c.enforcementLevel === "advisory",
    );

    // -- 3. Pre-execution: evaluate hard clauses ---------------------
    // Feature-flagged OFF for v1.0 — constitution enforcement is prompt-based only
    if (this.hardEvaluatorsEnabled) {
      try {
        for (const clause of hardClauses) {
          const result = this.evaluateHardClause(
            clause,
            message,
            member.age,
            member.role as MemberRole,
          );

          if (result && !result.allowed) {
            const event: PolicyEvent = {
              clauseId: clause.id,
              eventType: "enforced",
              reason: result.reason ?? "Hard clause violation",
            };
            collectedEvents.push(event);

            // Log the policy event
            await this.logPolicyEvent(
              householdId,
              agentId,
              null,
              null,
              clause.id,
              event.eventType,
              { message, result },
            );

            // Broadcast the block
            this.broadcast({
              type: "policy.enforced",
              data: {
                householdId,
                agentId,
                memberId,
                clauseId: clause.id,
                reason: result.reason,
              },
            });

            return {
              response: FRIENDLY_BLOCK_MESSAGE,
              blocked: true,
              policyEvents: collectedEvents,
            };
          }
        }
      } catch (err) {
        // Fail closed: evaluator threw -- block the message
        console.error("[engine] Evaluator error, failing closed:", err);
        return {
          response: FRIENDLY_ERROR_MESSAGE,
          blocked: true,
          policyEvents: collectedEvents,
        };
      }
    }

    // -- 4. Compile system prompt ------------------------------------
    const softRulePrompt = compileSoftRules(
      softClauses.map((c) => ({
        ruleText: c.clauseText,
        category: c.category,
        appliesToRoles: c.appliesToRoles,
        appliesToAgents: c.appliesToAgents,
        appliesToMinAge: c.appliesToMinAge,
        appliesToMaxAge: c.appliesToMaxAge,
      })),
      member.role as MemberRole,
      member.age,
      agentId,
    );

    // Load delegation instructions for personal agents
    let delegationInstr: string | null = null;
    if (agent.staffRole === "personal") {
      const edges = await this.db
        .select({
          agentId: staffAgents.id,
          agentName: staffAgents.name,
          staffRole: staffAgents.staffRole,
          specialty: staffAgents.specialty,
        })
        .from(delegationEdges)
        .innerJoin(staffAgents, eq(staffAgents.id, delegationEdges.toAgentId))
        .where(eq(delegationEdges.fromAgentId, agentId));

      if (edges.length > 0) {
        delegationInstr = buildDelegationInstructions(edges);
      }
    }

    // -- 5. Load conversation history + session state -----------------
    const conversationId = await this.getOrCreateConversation(
      agentId,
      memberId,
      householdId,
      channel,
    );

    // Try to resume existing Agent SDK session (check cache first, then DB)
    let resumeSessionId = this.getSessionId(conversationId);
    if (!resumeSessionId) {
      resumeSessionId = await this.loadSessionFromDb(conversationId);
    }

    const history = await this.getConversationHistory(conversationId);

    // Detect first-contact onboarding: no profile + member is not a parent
    const hasProfile = !!(member.profileContent && member.profileContent.trim());
    const assistantTurnCount = history.filter((m) => m.role === "assistant").length;
    const isFirstContact = !hasProfile && member.role !== "parent";

    // -- M1: Memory schema instructions (no ambient injection) ------
    let memorySchemaInstructions: string | null = null;

    if (this.memoryProvider) {
      memorySchemaInstructions = this.cachedMemorySchema ??= buildMemorySchemaInstructions(DEFAULT_MEMORY_SCHEMA);
    }

    // Resolve trust level builtins + enabled skills (needed for both prompt and adapter)
    let builtinTools: string[] | undefined;
    let enabledSkills: string[] | undefined;
    if (this.toolRegistry) {
      builtinTools = await this.toolRegistry.getAgentBuiltins(agentId);
      const skills = await this.toolRegistry.getAgentSkills(agentId);
      enabledSkills = skills.length > 0 ? skills : undefined;
    }

    const systemPrompt = compileSystemPrompt({
      mode: "chat",
      roleContent: agent.roleContent ?? "",
      soulContent: agent.soulContent ?? null,
      softRules: softRulePrompt,
      constitutionDocument: cached.constitutionDocument,
      memberName: member.name,
      memberRole: member.role,
      memberAge: member.age,
      memberProfile: member.profileContent ?? null,
      firstContact: isFirstContact,
      conversationTurnCount: assistantTurnCount,
      delegationInstructions: delegationInstr,
      operatingInstructions: agent.operatingInstructions ?? null,
      ambientMemory: null,
      memorySchemaInstructions,
      trustLevel: agent.trustLevel,
      enabledSkills: enabledSkills ?? null,
    });

    // -- Build tools for the adapter (registry-based) ----------------
    let tools = undefined;
    let toolExecutor = undefined;
    let toolCallLog: Array<{ name: string; input: Record<string, unknown>; result: { content: string; is_error?: boolean } }> | undefined;

    if (this.toolRegistry) {
      const memberSlug = member.name.toLowerCase().replace(/\s+/g, "-");

      // Bind per-member Google handlers for this conversation
      if (this.calendarProvider) {
        const calHandler = createCalendarToolHandler(this.calendarProvider, memberSlug);
        for (const toolName of ["list_calendar_events", "create_calendar_event", "get_calendar_event"]) {
          if (this.toolRegistry.get(toolName)) {
            this.toolRegistry.handlers.set(toolName, calHandler);
          }
        }

        const gmailHandler = createGmailToolHandler(this.calendarProvider, memberSlug);
        for (const toolName of ["gmail_triage", "gmail_read", "gmail_compose", "gmail_reply", "gmail_update_draft", "gmail_send_draft", "gmail_search"]) {
          if (this.toolRegistry.get(toolName)) {
            this.toolRegistry.handlers.set(toolName, gmailHandler);
          }
        }

        const driveHandler = createDriveToolHandler(this.calendarProvider, memberSlug);
        for (const toolName of ["drive_search", "drive_list"]) {
          if (this.toolRegistry.get(toolName)) {
            this.toolRegistry.handlers.set(toolName, driveHandler);
          }
        }
      }

      const built = await this.toolRegistry.buildExecutor({
        db: this.db,
        memoryProvider: this.memoryProvider,
        agentId,
        memberId,
        memberName: member.name,
        householdId,
        memberCollection: memberSlug,
        householdCollection: "household",
      });

      if (built) {
        tools = built.tools;
        toolExecutor = built.executor;
        toolCallLog = built.calls;
      }
    }

    // Add the current user message to history for the LLM call
    const messagesForLlm = [
      ...history,
      { role: "user", content: message },
    ];

    let llmResponse: string;

    try {
      const result = await this.adapter.execute({
        systemPrompt,
        messages: messagesForLlm,
        model: agent.model,
        tools,
        toolExecutor,
        builtinTools,
        enabledSkills,
        onTextDelta: params.onTextDelta,
        resumeSessionId: resumeSessionId ?? undefined,
      });
      llmResponse = result.content;

      // Save session ID for resume on next message
      if (result.sessionId) {
        await this.saveSessionId(conversationId, result.sessionId, toolCallLog);
        console.log(`[engine] Session saved for conversation ${conversationId}: ${result.sessionId}`);
      }

      // Log tool calls to activity log
      if (toolCallLog && toolCallLog.length > 0) {
        for (const call of toolCallLog) {
          try {
            await this.db.insert(activityLog).values({
              id: crypto.randomUUID(),
              householdId,
              agentId,
              action: `tool:${call.name}`,
              details: { input: call.input, result: call.result },
            });
          } catch {
            // Don't let logging failures break the pipeline
          }
        }
      }
    } catch (err) {
      // Adapter failed -- return error
      console.error("[engine] Adapter error:", err);
      return {
        response: FRIENDLY_ERROR_MESSAGE,
        blocked: false,
        policyEvents: collectedEvents,
      };
    }

    // -- 6. Post-execution scan --------------------------------------
    const scanResult = scanResponse(
      llmResponse,
      hardClauses.map((c) => ({
        ruleId: c.id,
        evaluationType: c.evaluationType,
        evaluationConfig: c.evaluationConfig,
      })),
    );

    if (scanResult && !scanResult.allowed) {
      const event: PolicyEvent = {
        clauseId: scanResult.ruleId ?? "response-scan",
        eventType: "escalated",
        reason: scanResult.reason ?? "Response contained blocked content",
      };
      collectedEvents.push(event);

      await this.logPolicyEvent(
        householdId,
        agentId,
        conversationId,
        null,
        scanResult.ruleId ?? null,
        "escalated",
        { originalResponse: llmResponse, scanResult },
      );

      this.broadcast({
        type: "policy.escalated",
        data: {
          householdId,
          agentId,
          memberId,
          clauseId: scanResult.ruleId,
          reason: scanResult.reason,
        },
      });

      llmResponse = FRIENDLY_SCAN_REPLACEMENT;
    }

    // -- 7. Extract onboarding profile if present ---------------------
    const profileMatch = llmResponse.match(
      /\[PROFILE_START\]([\s\S]*?)\[PROFILE_END\]/,
    );
    if (profileMatch) {
      const profileDoc = profileMatch[1].trim();
      if (profileDoc) {
        await this.db
          .update(familyMembers)
          .set({
            profileContent: profileDoc,
            profileUpdatedAt: new Date(),
          })
          .where(eq(familyMembers.id, memberId));

        console.log(
          `[engine] First-contact profile saved for ${member.name} (${memberId})`,
        );
      }
      // Strip the profile markers from the response the user sees
      llmResponse = llmResponse
        .replace(/\[PROFILE_START\][\s\S]*?\[PROFILE_END\]/, "")
        .trim();
    }

    // -- 8. Record conversation --------------------------------------
    await this.recordMessages(conversationId, message, llmResponse);

    // Broadcast the new message
    this.broadcast({
      type: "conversation.message",
      data: {
        householdId,
        agentId,
        memberId,
        conversationId,
        channel,
      },
    });

    return {
      response: llmResponse,
      blocked: false,
      policyEvents: collectedEvents,
    };
  }

  // -- Private: clause loading ---------------------------------------

  private async loadClauses(householdId: string): Promise<CachedConstitution> {
    const existing = this.cache.get(householdId);
    if (existing && Date.now() - existing.timestamp < CACHE_TTL_MS) {
      return existing;
    }

    // Find the active constitution for this household
    const [constitution] = await this.db
      .select()
      .from(constitutions)
      .where(
        and(
          eq(constitutions.householdId, householdId),
          eq(constitutions.isActive, true),
        ),
      )
      .limit(1);

    if (!constitution) {
      const empty: CachedConstitution = {
        clauses: [],
        constitutionId: "",
        constitutionDocument: "",
        timestamp: Date.now(),
      };
      this.cache.set(householdId, empty);
      return empty;
    }

    // Load all clauses for this constitution
    const clauses = await this.db
      .select()
      .from(constitutionClauses)
      .where(eq(constitutionClauses.constitutionId, constitution.id))
      .orderBy(constitutionClauses.sortOrder);

    const cached: CachedConstitution = {
      clauses: clauses.map((c) => ({
        id: c.id,
        category: c.category,
        clauseText: c.clauseText,
        enforcementLevel: c.enforcementLevel as EnforcementLevel,
        evaluationType: c.evaluationType as EvaluationType,
        evaluationConfig: c.evaluationConfig,
        appliesToRoles: c.appliesToRoles as MemberRole[] | null,
        appliesToAgents: c.appliesToAgents as string[] | null,
        appliesToMinAge: c.appliesToMinAge,
        appliesToMaxAge: c.appliesToMaxAge,
        sortOrder: c.sortOrder,
      })),
      constitutionId: constitution.id,
      constitutionDocument: constitution.document || "",
      timestamp: Date.now(),
    };

    this.cache.set(householdId, cached);
    return cached;
  }

  // -- Private: hard clause dispatch ---------------------------------

  private evaluateHardClause(
    clause: CachedConstitution["clauses"][number],
    message: string,
    memberAge: number,
    memberRole: MemberRole,
  ): EvaluationResult | null {
    const config = clause.evaluationConfig as Record<string, unknown> | null;

    switch (clause.evaluationType) {
      case "keyword_block":
        return evaluateKeywordBlock(
          message,
          clause.id,
          (config as unknown as Parameters<typeof evaluateKeywordBlock>[2]) ?? {
            blockedTerms: [],
          },
        );

      case "age_gate":
        return evaluateAgeGate(
          message,
          memberAge,
          clause.id,
          (config as unknown as Parameters<typeof evaluateAgeGate>[3]) ?? {
            minAge: 0,
          },
        );

      case "role_restrict":
        return evaluateRoleRestrict(
          memberRole,
          clause.id,
          (config as unknown as Parameters<typeof evaluateRoleRestrict>[2]) ?? {
            allowedRoles: [],
          },
        );

      case "behavioral":
        // Behavioral clauses are soft -- handled in prompt compilation
        return null;

      default:
        return null;
    }
  }

  // -- Private: conversation management ------------------------------

  private async getConversationHistory(
    conversationId: string,
  ): Promise<Array<{ role: string; content: string }>> {
    const rows = await this.db
      .select({
        role: messages.role,
        content: messages.content,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt)
      .limit(MAX_HISTORY_MESSAGES);

    return rows;
  }

  private async getOrCreateConversation(
    agentId: string,
    memberId: string,
    householdId: string,
    channel: string,
  ): Promise<string> {
    // Look for an existing conversation from today
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const existing = await this.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.agentId, agentId),
          eq(conversations.memberId, memberId),
          eq(conversations.householdId, householdId),
          eq(conversations.channel, channel),
        ),
      )
      .orderBy(desc(conversations.startedAt))
      .limit(1);

    // Reuse if started today
    if (existing.length > 0 && existing[0].startedAt.startsWith(today)) {
      return existing[0].id;
    }

    // Create new conversation
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db.insert(conversations).values({
      id,
      agentId,
      memberId,
      householdId,
      channel,
      startedAt: now,
      lastMessageAt: now,
    });

    return id;
  }

  // -- Private: recording --------------------------------------------

  private async recordMessages(
    conversationId: string,
    userMessage: string,
    assistantMessage: string,
  ): Promise<void> {
    const now = new Date().toISOString();

    await this.db.insert(messages).values([
      {
        id: crypto.randomUUID(),
        conversationId,
        role: "user",
        content: userMessage,
      },
      {
        id: crypto.randomUUID(),
        conversationId,
        role: "assistant",
        content: assistantMessage,
      },
    ]);

    // Update lastMessageAt on the conversation
    await this.db
      .update(conversations)
      .set({ lastMessageAt: now })
      .where(eq(conversations.id, conversationId));
  }

  // -- Private: session management -----------------------------------

  /**
   * Get the Agent SDK session ID for a conversation, if it's still valid.
   * Returns null if no session exists or it's expired.
   */
  private getSessionId(conversationId: string): string | null {
    const ctx = this.sessionCache.get(conversationId);
    if (!ctx) return null;

    const elapsed = Date.now() - ctx.lastActivity;
    if (elapsed > SESSION_TIMEOUT_MS) {
      // Session expired — will be cleaned up and noted
      return null;
    }

    return ctx.sessionId;
  }

  /**
   * Save the Agent SDK session ID after a successful query.
   * Also persists to the conversation's sessionContext field in the DB.
   */
  private async saveSessionId(
    conversationId: string,
    sessionId: string,
    toolCalls?: Array<{ name: string; input: Record<string, unknown> }>,
  ): Promise<void> {
    this.sessionCache.set(conversationId, {
      sessionId,
      lastActivity: Date.now(),
      toolCallNames: toolCalls?.map((t) => t.name) ?? [],
    });

    // Persist to DB for durability across restarts
    await this.db
      .update(conversations)
      .set({
        sessionContext: {
          sessionId,
          lastActivity: new Date().toISOString(),
          toolCallNames: toolCalls?.map((t) => t.name) ?? [],
        },
      })
      .where(eq(conversations.id, conversationId));
  }

  /**
   * Load session state from DB (on server restart, cache is empty).
   */
  private async loadSessionFromDb(conversationId: string): Promise<string | null> {
    const row = await this.db
      .select({ sessionContext: conversations.sessionContext })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!row?.sessionContext) return null;

    const ctx = row.sessionContext as { sessionId?: string; lastActivity?: string };
    if (!ctx.sessionId || !ctx.lastActivity) return null;

    const elapsed = Date.now() - new Date(ctx.lastActivity).getTime();
    if (elapsed > SESSION_TIMEOUT_MS) return null;

    // Restore to in-memory cache
    this.sessionCache.set(conversationId, {
      sessionId: ctx.sessionId,
      lastActivity: new Date(ctx.lastActivity).getTime(),
      toolCallNames: (ctx as { toolCallNames?: string[] }).toolCallNames ?? [],
    });

    return ctx.sessionId;
  }

  // -- Private: policy event logging ---------------------------------

  async logPolicyEvent(
    householdId: string,
    agentId: string,
    conversationId: string | null,
    taskId: string | null,
    clauseId: string | null,
    eventType: PolicyEventType,
    context: unknown,
  ): Promise<void> {
    try {
      await this.db.insert(policyEvents).values({
        id: crypto.randomUUID(),
        householdId,
        agentId,
        conversationId,
        taskId,
        clauseId,
        eventType,
        context,
      });
    } catch (err) {
      // Don't let logging failures break the pipeline
      console.error("[engine] Failed to log policy event:", err);
    }
  }
}
