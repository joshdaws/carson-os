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
  households,
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
import { compileSystemPrompt } from "./prompt-compiler.js";
import { activityLog, toolSecrets } from "@carsonos/db";
import { decryptSecret, redactSecrets } from "./custom-tools/secrets.js";
import {
  buildMemorySchemaInstructions,
  DEFAULT_MEMORY_SCHEMA,
} from "./memory/index.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { GoogleCalendarProvider } from "./google/index.js";
import { createCalendarToolHandler, createGmailToolHandler, createDriveToolHandler } from "./google/index.js";
import type { CalDavProvider } from "./caldav/index.js";
import { createCalDavCalendarToolHandler } from "./caldav/index.js";
import type { ImapProvider } from "./imap/index.js";
import { createImapEmailToolHandler } from "./imap/index.js";

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
  /**
   * Optional multimodal attachments (images, etc) to merge into this turn.
   * Used by the Telegram relay for photos so the agent's actual model sees
   * the image inline — no Haiku pre-describe round-trip.
   */
  attachments?: import("@carsonos/shared").MediaAttachment[];
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
  caldavProvider?: CalDavProvider;
  imapProvider?: ImapProvider;
  multiRelay?: import("./multi-relay-manager.js").MultiRelayManager;
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

function redactToolLogInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (name !== "store_secret") return input;
  return {
    ...input,
    ...(Object.prototype.hasOwnProperty.call(input, "value") ? { value: "[REDACTED]" } : {}),
  };
}

/**
 * Scrub a logged tool-call record against every known household secret.
 * Prevents HTTP tool responses that reflect auth headers, script tool results
 * that include ctx.getSecret() values, and error messages with embedded tokens
 * from landing in activity_log in plaintext.
 *
 * Walks the structured object and redacts raw string leaves before
 * serialization. Earlier implementation stringified first and ran
 * raw-substring redaction against the JSON output — that misses any secret
 * containing characters JSON has to escape (`"`, `\`, newlines, control
 * chars), because the literal bytes in the JSON differ from the raw secret.
 */
function redactToolCallAgainstSecrets(
  record: { input: unknown; result: unknown },
  secrets: Array<{ keyName: string; value: string }>,
): { input: unknown; result: unknown } {
  if (secrets.length === 0) return record;
  return {
    input: redactValue(record.input, secrets),
    result: redactValue(record.result, secrets),
  };
}

function redactValue(
  value: unknown,
  secrets: Array<{ keyName: string; value: string }>,
): unknown {
  if (typeof value === "string") {
    return redactSecrets(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, secrets));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, secrets);
    }
    return out;
  }
  return value;
}

/**
 * Load and decrypt all tool_secrets for a household. Runs at most once per
 * message, only if a custom tool was actually invoked. Return value is kept
 * in memory for the log-scrub pass then discarded.
 */
async function loadHouseholdSecrets(
  db: Db,
  householdId: string,
): Promise<Array<{ keyName: string; value: string }>> {
  const rows = await db
    .select()
    .from(toolSecrets)
    .where(eq(toolSecrets.householdId, householdId));
  const decoded: Array<{ keyName: string; value: string }> = [];
  for (const row of rows) {
    try {
      decoded.push({ keyName: row.keyName, value: decryptSecret(row.encryptedValue) });
    } catch {
      // Single corrupted row shouldn't stop redaction for other keys
    }
  }
  return decoded;
}

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
  private caldavProvider: CalDavProvider | null;
  private imapProvider: ImapProvider | null;
  private hardEvaluatorsEnabled: boolean;
  private multiRelay: import("./multi-relay-manager.js").MultiRelayManager | null;

  constructor(config: EngineConfig) {
    this.db = config.db;
    this.broadcast = config.broadcast;
    this.adapter = config.adapter;
    this.memoryProvider = config.memoryProvider ?? null;
    this.toolRegistry = config.toolRegistry ?? null;
    this.calendarProvider = config.calendarProvider ?? null;
    this.caldavProvider = config.caldavProvider ?? null;
    this.imapProvider = config.imapProvider ?? null;
    this.multiRelay = config.multiRelay ?? null;
    this.hardEvaluatorsEnabled = config.featureFlags?.hardEvaluators ?? false;
  }

  /** Set the multi-relay manager (called after construction because of circular dependency). */
  setMultiRelay(relay: import("./multi-relay-manager.js").MultiRelayManager): void {
    this.multiRelay = relay;
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

    // -- 1. Load agent + member + household info ----------------------
    const [agent, member, household, allMembers] = await Promise.all([
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
      this.db
        .select({ name: households.name })
        .from(households)
        .where(eq(households.id, householdId))
        .then((rows) => rows[0]),
      this.db
        .select({ name: familyMembers.name, role: familyMembers.role, age: familyMembers.age })
        .from(familyMembers)
        .where(eq(familyMembers.householdId, householdId)),
    ]);

    if (!agent || !member) {
      return {
        response: FRIENDLY_ERROR_MESSAGE,
        blocked: true,
        policyEvents: [],
      };
    }

    // Reject messages for paused or deleted agents
    if (agent.status !== "active") {
      return {
        response: "This agent is currently unavailable.",
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

    // Delegation is not active in v0.1 — will be enabled in a future version.
    // When re-enabled, filter delegation targets by status === "active".
    const delegationInstr: string | null = null;

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

    // Persist the user message BEFORE loading history so:
    //   (a) tools invoked during this turn (e.g. redact_recent_user_message)
    //       can find it in the DB
    //   (b) `history` includes the current message exactly once, so
    //       `messagesForLlm = history` doesn't double-append it
    await this.db.insert(messages).values({
      id: crypto.randomUUID(),
      conversationId,
      role: "user",
      content: message,
    });
    await this.db
      .update(conversations)
      .set({ lastMessageAt: new Date().toISOString() })
      .where(eq(conversations.id, conversationId));

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
      householdName: household?.name ?? null,
      householdMembers: allMembers ?? null,
    });

    // -- Build tools for the adapter (registry-based) ----------------
    let tools = undefined;
    let toolExecutor = undefined;
    let toolCallLog: Array<{ name: string; input: Record<string, unknown>; result: { content: string; is_error?: boolean } }> | undefined;
    let refreshToolsForAdapter: (() => Promise<{ tools: import("@carsonos/shared").ToolDefinition[]; toolExecutor: import("@carsonos/shared").ToolExecutor }>) | undefined;

    if (this.toolRegistry) {
      const memberSlug = member.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

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

      // -- Memory scoping based on agent role ---
      const isChiefOfStaff = agent.isHeadButler || agent.staffRole === "head_butler";

      // Load all member slugs for Chief of Staff "all" scope
      let allMemberCollections: string[] | undefined;
      let allowedCollections: string[];

      if (isChiefOfStaff) {
        // Chief of Staff can access all member collections + household
        const allMembers = await this.db
          .select({ name: familyMembers.name })
          .from(familyMembers)
          .where(eq(familyMembers.householdId, householdId));
        allMemberCollections = allMembers.map(
          (m) => m.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
        );
        allowedCollections = [...allMemberCollections, "household"];
      } else {
        // Personal agents can only access their assigned member + household
        allowedCollections = [memberSlug, "household"];
      }

      const executorCtx = {
        db: this.db,
        memoryProvider: this.memoryProvider,
        agentId,
        memberId,
        memberName: member.name,
        householdId,
        memberCollection: memberSlug,
        householdCollection: "household",
        isChiefOfStaff,
        allMemberCollections,
        allowedCollections,
        multiRelay: this.multiRelay ?? undefined,
      };

      const built = await this.toolRegistry.buildExecutor(executorCtx);

      if (built) {
        tools = built.tools;
        toolExecutor = built.executor;
        toolCallLog = built.calls;

        // Wrap executor to resolve CalDAV credentials per-member at dispatch
        // time — avoids mutating the shared ToolRegistry handler map.
        if (this.caldavProvider && this.caldavProvider.getAuthStatus(memberSlug).authenticated) {
          const caldavHandler = createCalDavCalendarToolHandler(this.caldavProvider, memberSlug);
          const caldavToolNames = new Set(["list_calendar_events", "create_calendar_event", "get_calendar_event"]);
          const base = toolExecutor;
          toolExecutor = async (name: string, input: Record<string, unknown>) => {
            if (caldavToolNames.has(name)) return caldavHandler(name, input);
            return base(name, input);
          };
        }

        // Same pattern for IMAP email tools.
        if (this.imapProvider && this.imapProvider.getAuthStatus(memberSlug).authenticated) {
          const imapHandler = createImapEmailToolHandler(this.imapProvider, memberSlug);
          const imapToolNames = new Set(["imap_triage", "imap_read", "imap_search"]);
          const base = toolExecutor;
          toolExecutor = async (name: string, input: Record<string, unknown>) => {
            if (imapToolNames.has(name)) return imapHandler(name, input);
            return base(name, input);
          };
        }
      }

      // Expose a refresh callback to the adapter so mid-session custom tool
      // registrations get re-pushed into the model's tool list via setMcpServers.
      refreshToolsForAdapter = async () => {
        const rebuilt = await this.toolRegistry!.buildExecutor(executorCtx);
        if (!rebuilt) return { tools: [], toolExecutor: async () => ({ content: "no tools", is_error: true }) };
        let refreshedExecutor = rebuilt.executor;
        if (this.caldavProvider && this.caldavProvider.getAuthStatus(memberSlug).authenticated) {
          const caldavHandler = createCalDavCalendarToolHandler(this.caldavProvider, memberSlug);
          const caldavToolNames = new Set(["list_calendar_events", "create_calendar_event", "get_calendar_event"]);
          const base = refreshedExecutor;
          refreshedExecutor = async (name: string, input: Record<string, unknown>) => {
            if (caldavToolNames.has(name)) return caldavHandler(name, input);
            return base(name, input);
          };
        }
        if (this.imapProvider && this.imapProvider.getAuthStatus(memberSlug).authenticated) {
          const imapHandler = createImapEmailToolHandler(this.imapProvider, memberSlug);
          const imapToolNames = new Set(["imap_triage", "imap_read", "imap_search"]);
          const base = refreshedExecutor;
          refreshedExecutor = async (name: string, input: Record<string, unknown>) => {
            if (imapToolNames.has(name)) return imapHandler(name, input);
            return base(name, input);
          };
        }
        return { tools: rebuilt.tools, toolExecutor: refreshedExecutor };
      };
    }

    // Add the current user message to history for the LLM call
    const messagesForLlm = history;

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
        attachments: params.attachments,
        // Mid-session tool refresh: re-run buildExecutor after a custom tool
        // is created/updated/disabled. The adapter uses this to call
        // setMcpServers so the new tool is immediately usable in this conv.
        refreshTools: refreshToolsForAdapter,
      });
      llmResponse = result.content;

      // Save session ID for resume on next message
      if (result.sessionId) {
        await this.saveSessionId(conversationId, result.sessionId, toolCallLog);
        console.log(`[engine] Session saved for conversation ${conversationId}: ${result.sessionId}`);
      }

      // Log tool calls to activity log
      if (toolCallLog && toolCallLog.length > 0) {
        // Load household secrets once per message so we can scrub any leaked
        // value from tool inputs or results. A custom HTTP tool pointing at a
        // reflector endpoint would otherwise persist its Bearer token into
        // activity_log verbatim.
        const secrets = await loadHouseholdSecrets(this.db, householdId);
        for (const call of toolCallLog) {
          try {
            const scrubbed = redactToolCallAgainstSecrets(
              { input: redactToolLogInput(call.name, call.input), result: call.result },
              secrets,
            );
            await this.db.insert(activityLog).values({
              id: crypto.randomUUID(),
              householdId,
              agentId,
              action: `tool:${call.name}`,
              details: scrubbed,
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

    // Reuse if started today (but never reuse for scheduled tasks — they're stateless)
    if (existing.length > 0 && existing[0].startedAt.startsWith(today) && channel !== "scheduled") {
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
    _userMessage: string,
    assistantMessage: string,
  ): Promise<void> {
    const now = new Date().toISOString();

    // User message is persisted earlier in processMessage so MCP tools called
    // during the agent run can reference it (e.g. redact_recent_user_message).
    // Here we only write the assistant response.
    await this.db.insert(messages).values({
      id: crypto.randomUUID(),
      conversationId,
      role: "assistant",
      content: assistantMessage,
    });

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
