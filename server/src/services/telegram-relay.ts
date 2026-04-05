/**
 * Telegram relay -- Grammy bot with per-agent serialization,
 * debouncing, and rate limiting.
 *
 * Each family member maps to an agent. Messages are buffered
 * for 500ms of silence, then processed through the ConstitutionEngine.
 * Within a single agent, messages are serialized to prevent
 * race conditions on conversation state.
 */

import { Bot } from "grammy";
import type { Context } from "grammy";
import type { Db } from "@carsonos/db";
import { familyMembers, agents } from "@carsonos/db";
import { eq } from "drizzle-orm";
import type { ConstitutionEngine } from "./engine.js";

// ── Types ───────────────────────────────────────────────────────────

interface TelegramRelayConfig {
  token: string;
  db: Db;
  engine: ConstitutionEngine;
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

  // Per-agent serialization queue: each agent's messages process one at a time
  const agentQueues = new Map<string, Promise<void>>();

  // Rate limiting per member
  const rateLimits = new Map<string, RateWindow>();

  // Debounce buffers per agent: collapse rapid-fire messages
  const debounceBuffers = new Map<string, DebounceBuffer>();

  // ── Message handler ─────────────────────────────────────────────

  bot.on("message:text", async (ctx) => {
    const telegramUserId = String(ctx.from.id);
    const text = ctx.message.text;

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

    // Get agent for this member
    const [agent] = await config.db
      .select()
      .from(agents)
      .where(eq(agents.memberId, member.id))
      .limit(1);

    if (!agent || agent.status !== "active") {
      await ctx.reply(
        "Your agent is currently paused. Ask your parents to activate it.",
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

    // Debounce: buffer messages, process after DEBOUNCE_MS of silence
    const existing = debounceBuffers.get(agent.id);
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(text);
      existing.timer = setTimeout(
        () => processBuffered(agent.id, member, ctx),
        DEBOUNCE_MS,
      );
    } else {
      debounceBuffers.set(agent.id, {
        messages: [text],
        timer: setTimeout(
          () => processBuffered(agent.id, member, ctx),
          DEBOUNCE_MS,
        ),
      });
    }
  });

  // ── Debounce flush + serialized processing ──────────────────────

  async function processBuffered(
    agentId: string,
    member: typeof familyMembers.$inferSelect,
    ctx: Context,
  ) {
    const buffer = debounceBuffers.get(agentId);
    if (!buffer) return;
    debounceBuffers.delete(agentId);

    const combinedMessage = buffer.messages.join("\n");

    // Per-agent serialization: wait for any in-flight work to finish
    const previousWork = agentQueues.get(agentId) ?? Promise.resolve();
    const currentWork = previousWork.then(async () => {
      try {
        const result = await config.engine.processMessage({
          agentId,
          memberId: member.id,
          familyId: member.familyId,
          message: combinedMessage,
          channel: "telegram",
        });
        await ctx.reply(result.response);
      } catch (err) {
        console.error("[telegram] Error processing message:", err);
        await ctx.reply(
          "I'm having trouble right now. Try again in a minute.",
        );
      }
    });
    agentQueues.set(agentId, currentWork);
    await currentWork;
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
