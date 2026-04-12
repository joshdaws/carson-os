/**
 * Telegram relay v3 -- @mention routing with staff assignments.
 *
 * Routing logic:
 *   1. Identify family member by Telegram user ID
 *   2. If message starts with @agentname, route to that staff agent
 *   3. If one agent assigned, route directly
 *   4. If multiple agents, route to Carson (head butler) who delegates
 *   5. If no assignment, route to Carson as default
 *
 * Preserves v2 patterns: debouncing, rate limiting, per-agent serialization.
 */

import { Bot } from "grammy";
import type { Context } from "grammy";
import type { Db } from "@carsonos/db";
import { familyMembers, staffAgents, staffAssignments } from "@carsonos/db";
import { eq, and } from "drizzle-orm";
import type { ConstitutionEngine } from "./constitution-engine.js";
import type { TaskEngine } from "./task-engine.js";

// ── Types ───────────────────────────────────────────────────────────

interface TelegramRelayConfig {
  token: string;
  db: Db;
  engine: ConstitutionEngine;
  taskEngine: TaskEngine;
}

interface RateWindow {
  count: number;
  windowStart: number;
}

interface DebounceBuffer {
  messages: string[];
  timer: ReturnType<typeof setTimeout>;
}

// ── Constants ───────────────────────────────────────────────────────

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const DEBOUNCE_MS = 500;
const MAX_MESSAGE_LENGTH = 2000;

// ── Factory ─────────────────────────────────────────────────────────

export function createTelegramRelay(config: TelegramRelayConfig) {
  const bot = new Bot(config.token);

  // Per-agent serialization queue
  const agentQueues = new Map<string, Promise<void>>();

  // Rate limiting per member
  const rateLimits = new Map<string, RateWindow>();

  // Debounce buffers per agent
  const debounceBuffers = new Map<string, DebounceBuffer>();

  // ── Message handler ─────────────────────────────────────────────

  // Catch-all error handler so Grammy doesn't swallow exceptions
  bot.catch((err) => {
    console.error("[telegram] Bot error:", err.message || err);
  });

  // Debug: log ALL updates
  bot.use((ctx, next) => {
    console.log(`[telegram] Update received: from=${ctx.from?.first_name || "unknown"}`);
    return next();
  });

  bot.on("message:text", async (ctx) => {
    const telegramUserId = String(ctx.from.id);
    const text = ctx.message.text;
    console.log(`[telegram] Message from ${ctx.from.first_name} (${telegramUserId}): ${text.slice(0, 50)}`);

    // Input validation
    if (text.length > MAX_MESSAGE_LENGTH) {
      await ctx.reply(
        "That message is too long. Try breaking it into shorter messages.",
      );
      return;
    }

    // Look up member by Telegram user ID
    const [member] = await config.db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.telegramUserId, telegramUserId))
      .limit(1);

    if (!member) {
      await ctx.reply(
        "I don't recognize your account. Ask your family admin to add you in the CarsonOS dashboard.",
      );
      return;
    }

    // Rate limiting
    const now = Date.now();
    let rateData = rateLimits.get(member.id);
    if (!rateData || now - rateData.windowStart > RATE_WINDOW_MS) {
      rateData = { count: 0, windowStart: now };
      rateLimits.set(member.id, rateData);
    }
    rateData.count++;
    if (rateData.count > RATE_LIMIT) {
      await ctx.reply(
        "You've sent a lot of messages. Take a short break and try again in a few minutes.",
      );
      return;
    }

    // Find the target staff agent via @mention routing
    const targetAgent = await resolveTargetAgent(config.db, member, text);

    if (!targetAgent) {
      await ctx.reply(
        "No staff agents are available right now. Ask your parents to set up staff in the CarsonOS dashboard.",
      );
      return;
    }

    if (targetAgent.status !== "active") {
      await ctx.reply(
        `${targetAgent.name} is currently paused. Try another staff member or ask your parents.`,
      );
      return;
    }

    // Strip the @mention from the message if present
    const cleanMessage = stripMention(text);

    // Debounce: buffer messages, process after DEBOUNCE_MS of silence
    const bufferKey = `${targetAgent.id}:${member.id}`;
    const existing = debounceBuffers.get(bufferKey);
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(cleanMessage);
      existing.timer = setTimeout(
        () => processBuffered(bufferKey, targetAgent, member, ctx),
        DEBOUNCE_MS,
      );
    } else {
      debounceBuffers.set(bufferKey, {
        messages: [cleanMessage],
        timer: setTimeout(
          () => processBuffered(bufferKey, targetAgent, member, ctx),
          DEBOUNCE_MS,
        ),
      });
    }
  });

  // ── @mention routing ────────────────────────────────────────────

  async function resolveTargetAgent(
    db: Db,
    member: typeof familyMembers.$inferSelect,
    message: string,
  ): Promise<typeof staffAgents.$inferSelect | null> {
    const householdId = member.householdId;

    // Check for @mention at start of message
    const mentionMatch = message.match(/^@(\w+)\s/);
    if (mentionMatch) {
      const mentionName = mentionMatch[1].toLowerCase();

      // Find staff agent matching the mention by role or name
      const allStaff = await db
        .select()
        .from(staffAgents)
        .where(eq(staffAgents.householdId, householdId));

      const matched = allStaff.find(
        (s) =>
          s.staffRole.toLowerCase() === mentionName ||
          s.name.toLowerCase().includes(mentionName) ||
          s.name.toLowerCase().replace(/\s+/g, "").includes(mentionName),
      );

      if (matched) return matched;
      // If @mention didn't match, fall through to default routing
    }

    // Get staff assigned to this member
    const assignments = await db
      .select({ agentId: staffAssignments.agentId })
      .from(staffAssignments)
      .where(eq(staffAssignments.memberId, member.id));

    if (assignments.length === 0) {
      // No assignments: route to Carson (head butler)
      return getHeadButler(db, householdId);
    }

    if (assignments.length === 1) {
      // One agent assigned: route directly
      const [agent] = await db
        .select()
        .from(staffAgents)
        .where(eq(staffAgents.id, assignments[0].agentId))
        .limit(1);
      return agent || getHeadButler(db, householdId);
    }

    // Multiple agents assigned, no @mention: route to Carson
    return getHeadButler(db, householdId);
  }

  async function getHeadButler(
    db: Db,
    householdId: string,
  ): Promise<typeof staffAgents.$inferSelect | null> {
    const [butler] = await db
      .select()
      .from(staffAgents)
      .where(
        and(
          eq(staffAgents.householdId, householdId),
          eq(staffAgents.isHeadButler, true),
        ),
      )
      .limit(1);
    return butler || null;
  }

  function stripMention(text: string): string {
    return text.replace(/^@\w+\s+/, "").trim() || text;
  }

  // ── Debounce flush + serialized processing ──────────────────────

  async function processBuffered(
    bufferKey: string,
    agent: typeof staffAgents.$inferSelect,
    member: typeof familyMembers.$inferSelect,
    ctx: Context,
  ) {
    const buffer = debounceBuffers.get(bufferKey);
    if (!buffer) return;
    debounceBuffers.delete(bufferKey);

    const combinedMessage = buffer.messages.join("\n");

    // Per-agent serialization: wait for any in-flight work to finish
    const previousWork = agentQueues.get(agent.id) ?? Promise.resolve();
    const currentWork = previousWork.then(async () => {
      try {
        // Check if this looks like a task request
        const isTaskRequest = detectTaskRequest(combinedMessage);

        if (isTaskRequest && !agent.isHeadButler) {
          // Create a task for this agent
          await config.taskEngine.createTask({
            householdId: member.householdId,
            agentId: agent.id,
            requestedBy: member.id,
            assignedToMembers: [member.id],
            title: extractTaskTitle(combinedMessage),
            description: combinedMessage,
            requiresApproval: agent.autonomyLevel === "supervised",
          });
          await ctx.reply(
            `Got it. I've assigned that to ${agent.name}. ${agent.autonomyLevel === "supervised" ? "It needs approval before they can start." : "They're on it."}`,
          );
        } else {
          // Regular conversation
          const result = await config.engine.processMessage({
            agentId: agent.id,
            memberId: member.id,
            householdId: member.householdId,
            message: combinedMessage,
            channel: "telegram",
          });
          await ctx.reply(result.response);
        }
      } catch (err) {
        console.error("[telegram] Error processing message:", err);
        await ctx.reply(
          "I'm having trouble right now. Try again in a minute.",
        );
      }
    });
    agentQueues.set(agent.id, currentWork);
    await currentWork;
  }

  // ── Task request detection ──────────────────────────────────────

  function detectTaskRequest(message: string): boolean {
    const taskPatterns = [
      /^can (?:you|the \w+) (?:make|create|build|write|plan|design|schedule)/i,
      /^(?:make|create|build|write|plan|design|schedule) (?:me |a |an )/i,
      /^i need (?:a |an )?(?:study plan|workout|schedule|practice)/i,
      /^(?:please )?(?:put together|come up with|prepare)/i,
    ];
    return taskPatterns.some((p) => p.test(message.trim()));
  }

  function extractTaskTitle(message: string): string {
    // Take the first sentence or first 80 characters
    const firstSentence = message.split(/[.!?\n]/)[0].trim();
    if (firstSentence.length <= 80) return firstSentence;
    return firstSentence.slice(0, 77) + "...";
  }

  // ── Public interface ────────────────────────────────────────────

  return {
    bot,
    start: () => {
      console.log("[telegram] Starting bot...");
      bot.start({
        onStart: () => console.log("[telegram] Bot is running"),
      });
    },
    stop: () => bot.stop(),
  };
}
