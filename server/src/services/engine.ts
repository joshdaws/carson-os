/**
 * Constitution Engine -- the core orchestration layer for CarsonOS.
 *
 * Processes every message through the constitution pipeline:
 *   1. Load rules (cached)
 *   2. Pre-execution hard rule evaluation
 *   3. Budget check
 *   4. Compile prompt with soft rules
 *   5. Execute via pluggable agent executor
 *   6. Post-execution response scan
 *   7. Record conversation, update budget, broadcast events
 */

import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import {
  constitutions,
  constitutionRules,
  agents,
  familyMembers,
  conversations,
  messages,
  policyEvents,
  budgetLedger,
} from "@carsonos/db";
import type {
  Channel,
  MemberRole,
  EnforcementLevel,
  EvaluationType,
  PolicyEventType,
} from "@carsonos/shared";

import {
  evaluateKeywordBlock,
  evaluateAgeGate,
  evaluateBudgetCap,
  evaluateRoleRestrict,
  compileSoftRules,
  scanResponse,
  type EvaluationResult,
} from "./evaluators.js";

// ── Types ───────────────────────────────────────────────────────────

export type AgentExecutor = (params: {
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
  model: string;
}) => Promise<{
  content: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}>;

interface PolicyEvent {
  ruleId: string;
  eventType: PolicyEventType;
  reason: string;
}

export interface ProcessMessageParams {
  agentId: string;
  memberId: string;
  familyId: string;
  message: string;
  channel: Channel;
}

export interface ProcessMessageResult {
  response: string;
  blocked: boolean;
  policyEvents: PolicyEvent[];
  costCents: number;
}

export interface EngineConfig {
  db: Db;
  broadcast: (event: { type: string; data: unknown }) => void;
  executor: AgentExecutor;
}

interface CachedConstitution {
  rules: Array<{
    id: string;
    category: string;
    ruleText: string;
    enforcementLevel: EnforcementLevel;
    evaluationType: EvaluationType;
    evaluationConfig: unknown;
    appliesToRoles: MemberRole[] | null;
    appliesToMinAge: number | null;
    appliesToMaxAge: number | null;
    sortOrder: number;
  }>;
  constitutionId: string;
  timestamp: number;
}

// ── Constants ───────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_HISTORY_MESSAGES = 50;
const DB_RETRY_COUNT = 3;
const DB_RETRY_BASE_MS = 100;

const FRIENDLY_BLOCK_MESSAGE =
  "I'm not able to help with that. If you think this is a mistake, ask a parent to review the family rules.";

const FRIENDLY_BUDGET_MESSAGE =
  "I've reached my usage limit for this month. A parent can adjust the budget if needed.";

const FRIENDLY_ERROR_MESSAGE =
  "Something went wrong on my end. Please try again in a moment.";

const FRIENDLY_SCAN_REPLACEMENT =
  "I generated a response that didn't meet the family's content rules, so I've held it back. Try rephrasing your question.";

// ── Engine ──────────────────────────────────────────────────────────

export class ConstitutionEngine {
  private cache = new Map<string, CachedConstitution>();
  private db: Db;
  private broadcast: EngineConfig["broadcast"];
  private executor: AgentExecutor;

  constructor(config: EngineConfig) {
    this.db = config.db;
    this.broadcast = config.broadcast;
    this.executor = config.executor;
  }

  /** Invalidate the rule cache for a family (call after rule edits). */
  invalidateCache(familyId: string): void {
    this.cache.delete(familyId);
  }

  /** Main entry point: process a user message through the full pipeline. */
  async processMessage(
    params: ProcessMessageParams,
  ): Promise<ProcessMessageResult> {
    const { agentId, memberId, familyId, message, channel } = params;
    const collectedEvents: PolicyEvent[] = [];

    // ── 1. Load agent + member info ───────────────────────────────
    const [agent, member] = await Promise.all([
      this.db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
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
        costCents: 0,
      };
    }

    // ── 2. Load constitution rules (cached) ───────────────────────
    let cached: CachedConstitution;
    try {
      cached = await this.loadRules(familyId);
    } catch (err) {
      // Fail closed: if we can't load rules, block the message
      console.error("[engine] Failed to load constitution rules:", err);
      return {
        response: FRIENDLY_ERROR_MESSAGE,
        blocked: true,
        policyEvents: [],
        costCents: 0,
      };
    }

    const hardRules = cached.rules.filter(
      (r) => r.enforcementLevel === "hard",
    );
    const softRules = cached.rules.filter(
      (r) => r.enforcementLevel === "soft" || r.enforcementLevel === "advisory",
    );

    // ── 3. Pre-execution: evaluate hard rules ─────────────────────
    try {
      for (const rule of hardRules) {
        const result = this.evaluateHardRule(
          rule,
          message,
          member.age,
          member.role as MemberRole,
        );

        if (result && !result.allowed) {
          const event: PolicyEvent = {
            ruleId: rule.id,
            eventType: "enforced",
            reason: result.reason ?? "Hard rule violation",
          };
          collectedEvents.push(event);

          // Log the policy event
          await this.logPolicyEvent(
            familyId,
            agentId,
            null,
            rule.id,
            event.eventType,
            { message, result },
          );

          // Broadcast the block
          this.broadcast({
            type: "policy.enforced",
            data: {
              familyId,
              agentId,
              memberId,
              ruleId: rule.id,
              reason: result.reason,
            },
          });

          return {
            response: FRIENDLY_BLOCK_MESSAGE,
            blocked: true,
            policyEvents: collectedEvents,
            costCents: 0,
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
        costCents: 0,
      };
    }

    // ── 4. Budget check ───────────────────────────────────────────
    const budgetResult = evaluateBudgetCap(
      agent.spentMonthlyCents,
      agent.budgetMonthlyCents,
      "budget-check",
    );

    if (!budgetResult.allowed) {
      const event: PolicyEvent = {
        ruleId: "budget-check",
        eventType: "budget_exceeded",
        reason: budgetResult.reason ?? "Budget exceeded",
      };
      collectedEvents.push(event);

      await this.logPolicyEvent(
        familyId,
        agentId,
        null,
        null,
        "budget_exceeded",
        { spent: agent.spentMonthlyCents, budget: agent.budgetMonthlyCents },
      );

      this.broadcast({
        type: "policy.budget_exceeded",
        data: { familyId, agentId, memberId },
      });

      return {
        response: FRIENDLY_BUDGET_MESSAGE,
        blocked: true,
        policyEvents: collectedEvents,
        costCents: 0,
      };
    }

    // ── 5. Compile system prompt ──────────────────────────────────
    const softRulePrompt = compileSoftRules(
      softRules.map((r) => ({
        ruleText: r.ruleText,
        category: r.category,
        appliesToRoles: r.appliesToRoles,
        appliesToMinAge: r.appliesToMinAge,
        appliesToMaxAge: r.appliesToMaxAge,
      })),
      member.role as MemberRole,
      member.age,
    );

    const systemPrompt = this.buildSystemPrompt(
      agent.soulContent ?? "",
      softRulePrompt,
      member.name,
      member.role as MemberRole,
      member.age,
    );

    // ── 6. Load conversation history + execute ────────────────────
    const conversationId = await this.getOrCreateConversation(
      agentId,
      familyId,
      channel,
    );

    const history = await this.getConversationHistory(
      conversationId,
    );

    // Add the current user message to history for the LLM call
    const messagesForLlm = [
      ...history,
      { role: "user", content: message },
    ];

    let llmResponse: string;
    let costCents = 0;

    try {
      const result = await this.executor({
        systemPrompt,
        messages: messagesForLlm,
        model: agent.model,
      });
      llmResponse = result.content;
      costCents = result.costCents;
    } catch (err) {
      // Executor failed -- return error, don't charge budget
      console.error("[engine] Executor error:", err);
      return {
        response: FRIENDLY_ERROR_MESSAGE,
        blocked: false,
        policyEvents: collectedEvents,
        costCents: 0,
      };
    }

    // ── 7. Post-execution scan ────────────────────────────────────
    const scanResult = scanResponse(
      llmResponse,
      hardRules.map((r) => ({
        ruleId: r.id,
        evaluationType: r.evaluationType,
        evaluationConfig: r.evaluationConfig,
      })),
    );

    if (scanResult && !scanResult.allowed) {
      const event: PolicyEvent = {
        ruleId: scanResult.ruleId ?? "response-scan",
        eventType: "escalated",
        reason: scanResult.reason ?? "Response contained blocked content",
      };
      collectedEvents.push(event);

      await this.logPolicyEvent(
        familyId,
        agentId,
        conversationId,
        scanResult.ruleId ?? null,
        "escalated",
        { originalResponse: llmResponse, scanResult },
      );

      this.broadcast({
        type: "policy.escalated",
        data: {
          familyId,
          agentId,
          memberId,
          ruleId: scanResult.ruleId,
          reason: scanResult.reason,
        },
      });

      llmResponse = FRIENDLY_SCAN_REPLACEMENT;
    }

    // ── 8. Record conversation + update budget ────────────────────
    await this.recordMessages(conversationId, message, llmResponse, costCents);
    await this.chargeBudget(familyId, agentId, costCents);

    // Broadcast the new message
    this.broadcast({
      type: "conversation.message",
      data: {
        familyId,
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
      costCents,
    };
  }

  // ── Private: rule loading ───────────────────────────────────────

  private async loadRules(familyId: string): Promise<CachedConstitution> {
    const existing = this.cache.get(familyId);
    if (existing && Date.now() - existing.timestamp < CACHE_TTL_MS) {
      return existing;
    }

    // Find the active constitution for this family
    const [constitution] = await this.db
      .select()
      .from(constitutions)
      .where(
        and(
          eq(constitutions.familyId, familyId),
          eq(constitutions.isActive, true),
        ),
      )
      .limit(1);

    if (!constitution) {
      const empty: CachedConstitution = {
        rules: [],
        constitutionId: "",
        timestamp: Date.now(),
      };
      this.cache.set(familyId, empty);
      return empty;
    }

    // Load all rules for this constitution
    const rules = await this.db
      .select()
      .from(constitutionRules)
      .where(eq(constitutionRules.constitutionId, constitution.id))
      .orderBy(constitutionRules.sortOrder);

    const cached: CachedConstitution = {
      rules: rules.map((r) => ({
        id: r.id,
        category: r.category,
        ruleText: r.ruleText,
        enforcementLevel: r.enforcementLevel as EnforcementLevel,
        evaluationType: r.evaluationType as EvaluationType,
        evaluationConfig: r.evaluationConfig,
        appliesToRoles: r.appliesToRoles as MemberRole[] | null,
        appliesToMinAge: r.appliesToMinAge,
        appliesToMaxAge: r.appliesToMaxAge,
        sortOrder: r.sortOrder,
      })),
      constitutionId: constitution.id,
      timestamp: Date.now(),
    };

    this.cache.set(familyId, cached);
    return cached;
  }

  // ── Private: hard rule dispatch ─────────────────────────────────

  private evaluateHardRule(
    rule: CachedConstitution["rules"][number],
    message: string,
    memberAge: number,
    memberRole: MemberRole,
  ): EvaluationResult | null {
    const config = rule.evaluationConfig as Record<string, unknown> | null;

    switch (rule.evaluationType) {
      case "keyword_block":
        return evaluateKeywordBlock(
          message,
          rule.id,
          (config as unknown as Parameters<typeof evaluateKeywordBlock>[2]) ?? { blockedTerms: [] },
        );

      case "age_gate":
        return evaluateAgeGate(
          message,
          memberAge,
          rule.id,
          (config as unknown as Parameters<typeof evaluateAgeGate>[3]) ?? { minAge: 0 },
        );

      case "role_restrict":
        return evaluateRoleRestrict(
          memberRole,
          rule.id,
          (config as unknown as Parameters<typeof evaluateRoleRestrict>[2]) ?? { allowedRoles: [] },
        );

      case "budget_cap":
        // Budget is handled separately in the pipeline
        return null;

      case "behavioral":
        // Behavioral rules are soft -- handled in prompt compilation
        return null;

      default:
        return null;
    }
  }

  // ── Private: system prompt construction ─────────────────────────

  private buildSystemPrompt(
    soulContent: string,
    softRulePrompt: string,
    memberName: string,
    memberRole: MemberRole,
    memberAge: number,
  ): string {
    const parts: string[] = [];

    if (soulContent) {
      parts.push(soulContent);
    }

    parts.push(
      `\nYou are speaking with ${memberName} (role: ${memberRole}, age: ${memberAge}).`,
    );

    if (softRulePrompt) {
      parts.push(`\n# Family Rules\n\n${softRulePrompt}`);
    }

    return parts.join("\n");
  }

  // ── Private: conversation management ────────────────────────────

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
    familyId: string,
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
          eq(conversations.familyId, familyId),
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
      familyId,
      channel,
      startedAt: now,
      lastMessageAt: now,
    });

    return id;
  }

  // ── Private: recording ──────────────────────────────────────────

  private async recordMessages(
    conversationId: string,
    userMessage: string,
    assistantMessage: string,
    costCents: number,
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
        costCents,
      },
    ]);

    // Update lastMessageAt on the conversation
    await this.db
      .update(conversations)
      .set({ lastMessageAt: now })
      .where(eq(conversations.id, conversationId));
  }

  private async chargeBudget(
    familyId: string,
    agentId: string,
    costCents: number,
  ): Promise<void> {
    if (costCents <= 0) return;

    let retries = 0;
    while (retries < DB_RETRY_COUNT) {
      try {
        // Get current spent amount
        const [agent] = await this.db
          .select({ spentMonthlyCents: agents.spentMonthlyCents })
          .from(agents)
          .where(eq(agents.id, agentId));

        if (!agent) return;

        const newSpent = agent.spentMonthlyCents + costCents;

        // Update the agent's spent amount
        await this.db
          .update(agents)
          .set({ spentMonthlyCents: newSpent })
          .where(eq(agents.id, agentId));

        // Record in the budget ledger
        await this.db.insert(budgetLedger).values({
          id: crypto.randomUUID(),
          familyId,
          agentId,
          amountCents: costCents,
          balanceAfterCents: newSpent,
          eventType: "charge",
          description: "Message processing charge",
        });

        return;
      } catch (err) {
        retries++;
        if (retries >= DB_RETRY_COUNT) {
          console.error(
            `[engine] Budget charge failed after ${DB_RETRY_COUNT} retries. ` +
              `Pending charge: ${costCents}c for agent ${agentId}`,
            err,
          );
          return;
        }
        // Exponential backoff
        await new Promise((resolve) =>
          setTimeout(resolve, DB_RETRY_BASE_MS * 2 ** (retries - 1)),
        );
      }
    }
  }

  // ── Private: policy event logging ───────────────────────────────

  private async logPolicyEvent(
    familyId: string,
    agentId: string,
    conversationId: string | null,
    ruleId: string | null,
    eventType: PolicyEventType,
    context: unknown,
  ): Promise<void> {
    try {
      await this.db.insert(policyEvents).values({
        id: crypto.randomUUID(),
        familyId,
        agentId,
        conversationId,
        ruleId,
        eventType,
        context,
      });
    } catch (err) {
      // Don't let logging failures break the pipeline
      console.error("[engine] Failed to log policy event:", err);
    }
  }
}
