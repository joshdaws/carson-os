/**
 * Multi-Relay Manager -- one Telegram bot per family-visible agent.
 *
 * Uses @grammyjs/runner for non-blocking polling, update deduplication,
 * offset persistence, 409 conflict recovery, API throttling, markdown
 * formatting, thinking block filtering, and paste buffering.
 *
 * OpenClaw-informed patterns: runner over bot.start(), deleteWebhook
 * before polling, per-chat sequentialization, stall watchdog.
 */

import { Bot } from "grammy";
import type { Context } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import type { RunnerHandle } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { EventEmitter } from "node:events";
import type { Db } from "@carsonos/db";
import { staffAgents, familyMembers, staffAssignments } from "@carsonos/db";
import { eq, and } from "drizzle-orm";
import type { ConstitutionEngine } from "./constitution-engine.js";
import type { DelegationService } from "./delegation-service.js";
import type { Adapter } from "./subprocess-adapter.js";
import { createTelegramStream } from "./telegram-streaming.js";
import { markdownToTelegramHtml, stripThinkingBlocks } from "./telegram-format.js";

// ── Types ───────────────────────────────────────────────────────────

interface MultiRelayConfig {
  db: Db;
  adapter: Adapter;
  engine: ConstitutionEngine;
  orchestrator: DelegationService;
}

interface ManagedBot {
  bot: Bot;
  runner: RunnerHandle | null;
  agentId: string;
  agentName: string;
  running: boolean;
  lastActivity: number;
  recentUpdateIds: Set<number>;
  highestUpdateId: number;
}

interface DebounceBuffer {
  messages: string[];
  timer: ReturnType<typeof setTimeout>;
  ctx: Context;
  /** Multimodal attachments collected from any buffered photo turns. */
  attachments: import("@carsonos/shared").MediaAttachment[];
  createdAt: number;
}

interface TelegramAccessCacheEntry {
  member: typeof familyMembers.$inferSelect;
  expiresAt: number;
}

// ── Constants ───────────────────────────────────────────────────────

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const QUICK_DEBOUNCE_MS = 150;
const PASTE_DEBOUNCE_MS = 1500;
const TELEGRAM_ACCESS_CACHE_TTL_MS = 60_000;
const MAX_DEBOUNCE_PARTS = 12;
const MAX_DEBOUNCE_CHARS = 50_000;
const MEMORY_LOG_INTERVAL_MS = 5 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 4096;
const DEDUP_MAX_SIZE = 2000;
const STALL_CHECK_INTERVAL_MS = 60_000;
const STALL_THRESHOLD_MS = 300_000; // 5 min — SDK calls can take 30-60s with tool loops
// Conflict backoff: short enough that hot-reload restarts don't sit silent for
// long, long enough that the prior process has time to release its long-poll.
const CONFLICT_BACKOFF_MS = 1_500;
// Long-poll timeout — kept short so runner.stop() returns quickly during a
// hot reload. Telegram still pushes updates instantly when present; this only
// caps how long an idle poll blocks waiting for new messages.
const POLL_TIMEOUT_S = 3;
// Shutdown grace per bot — must be > POLL_TIMEOUT_S so an in-flight poll can
// finish cleanly. With Promise.all stopping all bots in parallel, the whole
// shutdown completes in this window.
const SHUTDOWN_TIMEOUT_MS = 3_500;

// ── Shared Rate Limiter ─────────────────────────────────────────────

export class SharedRateLimiter {
  private windows = new Map<string, { count: number; windowStart: number }>();

  check(memberId: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const existing = this.windows.get(memberId);

    if (!existing || now - existing.windowStart > windowMs) {
      this.windows.set(memberId, { count: 1, windowStart: now });
      return true;
    }

    if (existing.count >= limit) return false;
    existing.count++;
    return true;
  }
}

// ── Transient-error detection ──────────────────────────────────────

/**
 * Network codes we retry on. Telegram API failures wrapped by grammy
 * surface these in the error message chain — `ETIMEDOUT` (slow route),
 * `ECONNRESET` (TCP drop), `EAI_AGAIN` (DNS flake), `ENETUNREACH`
 * (offline), `ECONNREFUSED` (Telegram edge down). All resolve on their
 * own given enough time.
 *
 * Explicitly NOT in this set: 401/403/"unauthorized" (auth failure — bot
 * token is wrong, retrying won't help).
 */
const TRANSIENT_ERROR_MARKERS = [
  "ETIMEDOUT",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ECONNREFUSED",
  "socket hang up",
  "fetch failed",
];

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isTransientNetworkError(err: unknown): boolean {
  const chain: string[] = [];
  let cursor: unknown = err;
  // Walk up to 5 levels of nested `cause` so grammy's wrapped node-fetch
  // errors still match (HttpError → FetchError → node:net Error).
  for (let i = 0; i < 5 && cursor; i++) {
    if (cursor instanceof Error) {
      chain.push(cursor.message);
      cursor = (cursor as Error & { cause?: unknown }).cause;
    } else {
      chain.push(String(cursor));
      break;
    }
  }
  const joined = chain.join(" | ");
  return TRANSIENT_ERROR_MARKERS.some((m) => joined.includes(m));
}

// ── Multi-Relay Manager ─────────────────────────────────────────────

export class MultiRelayManager {
  private db: Db;
  private adapter: Adapter;
  private engine: ConstitutionEngine;
  private orchestrator: DelegationService;
  private bots = new Map<string, ManagedBot>();
  private rateLimiter = new SharedRateLimiter();
  private debounceBuffers = new Map<string, DebounceBuffer>();
  private telegramAccessCache = new Map<string, TelegramAccessCacheEntry>();
  private agentQueues = new Map<string, Promise<void>>();
  private events = new EventEmitter();
  private memoryLogInterval: ReturnType<typeof setInterval> | null = null;
  private stallCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: MultiRelayConfig) {
    this.db = config.db;
    this.adapter = config.adapter;
    this.engine = config.engine;
    this.orchestrator = config.orchestrator;

    this.events.on("delegation.result", (data: {
      memberId: string | null;
      agentId: string;
      conversationId: string | null;
      response: string;
    }) => {
      this.deliverDelegationResult(data);
    });
  }

  get eventBus(): EventEmitter {
    return this.events;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async startAll(): Promise<void> {
    const agents = await this.db
      .select()
      .from(staffAgents)
      .where(
        and(
          eq(staffAgents.visibility, "family"),
          eq(staffAgents.status, "active"),
        ),
      );

    const agentsWithTokens = agents.filter((a) => a.telegramBotToken);

    if (agentsWithTokens.length === 0) {
      console.log("[multi-relay] No family-visible agents with bot tokens found");
      return;
    }

    console.log(`[multi-relay] Starting ${agentsWithTokens.length} bot(s)...`);

    for (const agent of agentsWithTokens) {
      await this.startBot(agent.id);
    }

    // Memory monitoring
    this.logMemory();
    this.memoryLogInterval = setInterval(() => this.logMemory(), MEMORY_LOG_INTERVAL_MS);

    // Stall watchdog
    this.stallCheckInterval = setInterval(() => this.checkStalls(), STALL_CHECK_INTERVAL_MS);
  }

  async stopAll(): Promise<void> {
    if (this.memoryLogInterval) {
      clearInterval(this.memoryLogInterval);
      this.memoryLogInterval = null;
    }
    if (this.stallCheckInterval) {
      clearInterval(this.stallCheckInterval);
      this.stallCheckInterval = null;
    }

    const stopPromises: Promise<void>[] = [];
    for (const [agentId, managed] of this.bots) {
      if (managed.running) {
        stopPromises.push(
          this.stopBot(agentId).catch((err) => {
            console.error(`[multi-relay] Error stopping bot for ${managed.agentName}:`, err);
          }),
        );
      }
    }

    await Promise.all(stopPromises);
    this.bots.clear();
    console.log("[multi-relay] All bots stopped");
  }

  async startBot(agentId: string): Promise<void> {
    const existing = this.bots.get(agentId);
    if (existing?.running) {
      console.log(`[multi-relay] Bot for ${existing.agentName} already running`);
      return;
    }

    const [agent] = await this.db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, agentId));

    if (!agent || !agent.telegramBotToken) {
      console.error(`[multi-relay] Agent ${agentId} not found or no token`);
      return;
    }

    const bot = new Bot(agent.telegramBotToken);

    // API throttler (outbound rate limiting)
    bot.api.config.use(apiThrottler());

    // Error handler with 409 detection
    bot.catch((err) => {
      const msg = String(err.message || err);
      if (msg.includes("409") || msg.includes("terminated by other")) {
        console.warn(`[multi-relay:${agent.name}] 409 conflict detected. Restarting in ${CONFLICT_BACKOFF_MS / 1000}s...`);
        this.handle409(agentId, agent.name);
        return;
      }
      console.error(`[multi-relay:${agent.name}] Bot error:`, msg);
    });

    // Per-chat sequentialization: same chat processes in order, different chats run parallel
    bot.use(sequentialize((ctx) => String(ctx.chat?.id ?? "unknown")));

    // Update dedup middleware
    const managed: ManagedBot = {
      bot,
      runner: null,
      agentId,
      agentName: agent.name,
      running: false,
      lastActivity: Date.now(),
      recentUpdateIds: new Set(),
      highestUpdateId: 0,
    };

    bot.on("message:text", async (ctx) => {
      // Dedup check
      const updateId = ctx.update.update_id;
      if (managed.recentUpdateIds.has(updateId)) {
        return; // Already processed
      }
      managed.recentUpdateIds.add(updateId);
      if (updateId > managed.highestUpdateId) {
        managed.highestUpdateId = updateId;
      }
      managed.lastActivity = Date.now();

      // Prune old dedup entries
      if (managed.recentUpdateIds.size > DEDUP_MAX_SIZE) {
        const cutoff = managed.highestUpdateId - DEDUP_MAX_SIZE;
        for (const id of managed.recentUpdateIds) {
          if (id < cutoff) managed.recentUpdateIds.delete(id);
        }
      }

      try {
        await this.handleMessage(ctx, agentId, agent.name);
      } catch (err) {
        console.error(`[multi-relay:${agent.name}] Unhandled error:`, err);
        try {
          await ctx.reply("Something went wrong. Please try again in a moment.");
        } catch {
          // swallow
        }
      }
    });

    // Voice and audio handlers — dedicated, not in the generic media loop.
    // Key reasons:
    //   1. Sends "typing" immediately so the user knows transcription is running
    //   2. Uses real ctx (not a spread fake) — spreading a Grammy Context loses all
    //      prototype methods (reply, replyWithChatAction, api getters), which was the
    //      root cause of the "I had trouble processing that" error
    //   3. Labels real transcripts clearly so the LLM understands the source
    for (const voiceType of ["message:voice", "message:audio"] as const) {
      bot.on(voiceType, async (ctx) => {
        const updateId = ctx.update.update_id;
        if (managed.recentUpdateIds.has(updateId)) return;
        managed.recentUpdateIds.add(updateId);
        managed.lastActivity = Date.now();

        try {
          // Typing indicator right away — transcription takes a moment
          try { await ctx.replyWithChatAction("typing"); } catch { /* swallow */ }

          const { extractMediaText } = await import("./telegram-media.js");
          const extraction = await extractMediaText(ctx, agent.telegramBotToken!);

          if (extraction) {
            // Real transcript vs. "could not be transcribed" fallback
            const isRealTranscript = !extraction.text.startsWith("[Voice message");
            const fullText = isRealTranscript
              ? `[Voice transcript]\n\n${extraction.text}`
              : extraction.text;
            await this.handleMessage(ctx, agentId, agent.name, fullText);
          } else {
            await ctx.reply("I couldn't process that voice message. Please try again or send it as text.");
          }
        } catch (err) {
          console.error(`[multi-relay:${agent.name}] Voice error:`, err);
          await ctx.reply("I had trouble with that voice message. Try sending it as text.");
        }
      });
    }

    // Generic media handlers (photos, documents, stickers, video).
    // Voice/audio are handled above. Pass real ctx + textOverride to handleMessage
    // — same fix as above to avoid the Grammy prototype-loss bug.
    //
    // Photos in particular trigger a vision pre-describe (Haiku via Agent SDK)
    // before the main agent call, which adds a few seconds. Send "typing"
    // immediately and keep refreshing it so the user doesn't think the relay
    // is dead.
    const mediaTypes = ["message:photo", "message:document", "message:sticker", "message:video"] as const;
    for (const mediaType of mediaTypes) {
      bot.on(mediaType, async (ctx) => {
        const updateId = ctx.update.update_id;
        if (managed.recentUpdateIds.has(updateId)) return;
        managed.recentUpdateIds.add(updateId);
        managed.lastActivity = Date.now();

        // Keep typing visible for the entire extraction window. Telegram's
        // chat action expires after ~5s, so refresh every 4s.
        let typingInterval: ReturnType<typeof setInterval> | null = null;
        try { await ctx.replyWithChatAction("typing"); } catch { /* swallow */ }
        typingInterval = setInterval(() => {
          ctx.replyWithChatAction("typing").catch(() => { /* swallow */ });
        }, 4000);

        try {
          const { extractMediaText } = await import("./telegram-media.js");
          const extraction = await extractMediaText(ctx, agent.telegramBotToken!);
          if (extraction) {
            const fullText = extraction.caption
              ? `${extraction.caption}\n\n${extraction.text}`
              : extraction.text;
            const attachments = extraction.image
              ? [{
                  type: "image" as const,
                  mediaType: extraction.image.mediaType,
                  base64: extraction.image.base64,
                }]
              : undefined;
            await this.handleMessage(ctx, agentId, agent.name, fullText, attachments);
          } else {
            await ctx.reply("I received your message but couldn't process that type of content yet.");
          }
        } catch (err) {
          console.error(`[multi-relay:${agent.name}] Media error:`, err);
          await ctx.reply("I had trouble processing that. Try sending it as text.");
        } finally {
          if (typingInterval) clearInterval(typingInterval);
        }
      });
    }

    // v0.4: inline-button handler for hire / delegation approval cards.
    // callback_data format: "<action>:<taskId>" where action is
    // "approve" | "reject". Grammy only emits callback_query:data when
    // the payload carries data (filters out non-data callbacks).
    bot.on("callback_query:data", async (ctx) => {
      try {
        const raw = ctx.callbackQuery.data;
        const [action, taskId] = raw.split(":", 2);
        if (!taskId || (action !== "approve" && action !== "reject")) {
          await ctx.answerCallbackQuery({ text: "Unknown action" }).catch(() => {});
          return;
        }
        const telegramUserId = String(ctx.from?.id ?? "");
        if (!telegramUserId) {
          await ctx.answerCallbackQuery({ text: "No Telegram user id" }).catch(() => {});
          return;
        }

        // Authorization: only family members with role='parent' can approve
        // hires. Resolving via telegramUserId prevents a kid (or a stranger
        // added to the bot chat) from tapping Approve on a message they
        // shouldn't decide on. Forwarded/shared messages hit the same gate.
        const [approver] = await this.db
          .select()
          .from(familyMembers)
          .where(eq(familyMembers.telegramUserId, telegramUserId))
          .limit(1);
        if (!approver) {
          await ctx
            .answerCallbackQuery({ text: "Not a recognized family member" })
            .catch(() => {});
          return;
        }
        if (approver.role !== "parent") {
          await ctx
            .answerCallbackQuery({ text: "Only a parent can approve hires" })
            .catch(() => {});
          return;
        }
        const approvedBy = approver.id;

        const result =
          action === "approve"
            ? await this.orchestrator.handleHireApproval(taskId, approvedBy)
            : await this.orchestrator.handleHireRejection(taskId, approvedBy);

        if (!result.ok) {
          await ctx.answerCallbackQuery({ text: result.error.slice(0, 200) }).catch(() => {});
          return;
        }

        if (result.alreadyResolved) {
          await ctx.answerCallbackQuery({ text: "Already handled" }).catch(() => {});
          return;
        }

        await ctx
          .answerCallbackQuery({ text: action === "approve" ? "Approved" : "Rejected" })
          .catch(() => {});

        // Strip the buttons and stamp the card so the user can see what they chose.
        try {
          const original = ctx.callbackQuery.message?.text ?? "";
          const stamp = action === "approve" ? "✅ Approved" : "❌ Rejected";
          await ctx.editMessageText(`${stamp}\n\n${original}`, { reply_markup: undefined });
        } catch {
          // Telegram refuses edits after ~48h or on certain modifications —
          // not load-bearing for correctness, swallow.
        }
      } catch (err) {
        console.error(`[multi-relay:${agent.name}] callback_query error:`, err);
        try { await ctx.answerCallbackQuery({ text: "Error handling action" }); } catch { /* swallow */ }
      }
    });

    // Clear any stale webhook, then start with runner. Transient network
    // errors (ETIMEDOUT on deleteWebhook is the common one — WiFi/DNS blips)
    // used to leave the bot in a zombie state forever: error caught, no
    // retry, 0 bots running, user has to manually restart the dev server.
    // Now we back off and retry a few times for transient errors only —
    // auth errors (401/403/"unauthorized") fail immediately since retrying
    // won't help.
    const START_BOT_BACKOFFS_MS = [5_000, 15_000, 45_000];
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= START_BOT_BACKOFFS_MS.length; attempt++) {
      try {
        await bot.api.deleteWebhook({ drop_pending_updates: false });

        const runner = run(bot, {
          runner: {
            // Short long-poll so runner.stop() returns within a few seconds
            // during hot reloads. Telegram still pushes updates instantly when
            // present — this only caps how long an idle poll blocks.
            fetch: { timeout: POLL_TIMEOUT_S },
            silent: true,
          },
          sink: { concurrency: 4 },
        });

        managed.runner = runner;
        managed.running = true;
        this.bots.set(agentId, managed);

        console.log(
          `[multi-relay] Bot started for ${agent.name} (${agentId})` +
            (attempt > 0 ? ` [recovered after ${attempt} retr${attempt === 1 ? "y" : "ies"}]` : ""),
        );
        return;
      } catch (err) {
        lastErr = err;
        const transient = isTransientNetworkError(err);
        const nextDelay = START_BOT_BACKOFFS_MS[attempt];
        if (!transient || nextDelay === undefined) {
          break;
        }
        console.warn(
          `[multi-relay] Transient failure starting ${agent.name} (attempt ${attempt + 1}/${START_BOT_BACKOFFS_MS.length + 1}), retrying in ${nextDelay / 1000}s:`,
          errMessage(err),
        );
        await new Promise((resolve) => setTimeout(resolve, nextDelay));
      }
    }
    console.error(
      `[multi-relay] Failed to start bot for ${agent.name} after ${START_BOT_BACKOFFS_MS.length + 1} attempts:`,
      lastErr,
    );
    // Don't set status to idle on start failure — it prevents recovery on restart.
  }

  async stopBot(agentId: string): Promise<void> {
    const managed = this.bots.get(agentId);
    if (!managed) return;

    if (managed.running && managed.runner) {
      // Race stop against timeout
      const stopPromise = managed.runner.isRunning()
        ? managed.runner.stop()
        : Promise.resolve();

      await Promise.race([
        stopPromise,
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ]);

      managed.running = false;
      console.log(`[multi-relay] Bot stopped for ${managed.agentName}`);
    }

    this.bots.delete(agentId);
  }

  // ── 409 conflict recovery ────────────────────────────────────────

  private async handle409(agentId: string, agentName: string): Promise<void> {
    await this.stopBot(agentId);
    console.log(`[multi-relay:${agentName}] Waiting ${CONFLICT_BACKOFF_MS / 1000}s before restart...`);
    await new Promise((r) => setTimeout(r, CONFLICT_BACKOFF_MS));
    await this.startBot(agentId);
  }

  // ── Stall watchdog ───────────────────────────────────────────────

  private checkStalls(): void {
    const now = Date.now();
    for (const [agentId, managed] of this.bots) {
      if (!managed.running) continue;
      const idle = now - managed.lastActivity;
      if (idle > STALL_THRESHOLD_MS) {
        console.warn(
          `[multi-relay:${managed.agentName}] Stall detected (${Math.round(idle / 1000)}s idle). Restarting...`,
        );
        this.stopBot(agentId)
          .then(() => this.startBot(agentId))
          .catch((err) => console.error(`[multi-relay] Stall restart failed:`, err));
      }
    }
  }

  // ── Message handling ──────────────────────────────────────────────

  private async handleMessage(
    ctx: Context,
    agentId: string,
    agentName: string,
    textOverride?: string,
    attachments?: import("@carsonos/shared").MediaAttachment[],
  ): Promise<void> {
    const telegramUserId = String(ctx.from!.id);
    const text = textOverride ?? ctx.message!.text!;

    console.log(
      `[multi-relay:${agentName}] Message from ${ctx.from!.first_name} (${telegramUserId}): ${text.slice(0, 50)}`,
    );

    if (text.length > MAX_MESSAGE_LENGTH) {
      await ctx.reply("That message is too long. Try breaking it into shorter messages.");
      return;
    }

    const cacheKey = `${agentId}:${telegramUserId}`;
    const cachedAccess = this.telegramAccessCache.get(cacheKey);
    let member = cachedAccess && cachedAccess.expiresAt > Date.now()
      ? cachedAccess.member
      : null;

    if (!member) {
      // Identify family member
      const [dbMember] = await this.db
        .select()
        .from(familyMembers)
        .where(eq(familyMembers.telegramUserId, telegramUserId))
        .limit(1);

      if (!dbMember) {
        await ctx.reply(
          "I don't recognize your account. Ask your family admin to add you in the CarsonOS dashboard.",
        );
        return;
      }

      // Verify assignment
      const [assignment] = await this.db
        .select()
        .from(staffAssignments)
        .where(
          and(
            eq(staffAssignments.agentId, agentId),
            eq(staffAssignments.memberId, dbMember.id),
          ),
        )
        .limit(1);

      if (!assignment) {
        await ctx.reply("I'm not your assigned agent. Contact your household admin.");
        return;
      }

      member = dbMember;
      this.telegramAccessCache.set(cacheKey, {
        member,
        expiresAt: Date.now() + TELEGRAM_ACCESS_CACHE_TTL_MS,
      });
    }

    // Rate limit
    if (!this.rateLimiter.check(member.id, RATE_LIMIT, RATE_WINDOW_MS)) {
      await ctx.reply("You're sending messages too fast. Please wait a moment.");
      return;
    }

    // Adaptive debounce: quick single-message turns, longer window once a
    // paste burst starts (max 12 parts, 50K chars).
    const bufferKey = `${agentId}:${member.id}`;
    const existingBuf = this.debounceBuffers.get(bufferKey);

    if (existingBuf) {
      clearTimeout(existingBuf.timer);
      const totalChars = existingBuf.messages.reduce((s, m) => s + m.length, 0) + text.length;
      if (existingBuf.messages.length < MAX_DEBOUNCE_PARTS && totalChars < MAX_DEBOUNCE_CHARS) {
        existingBuf.messages.push(text);
        existingBuf.ctx = ctx;
        if (attachments) existingBuf.attachments.push(...attachments);
        existingBuf.timer = setTimeout(
          () => this.flushBuffer(bufferKey, agentId, agentName, member),
          PASTE_DEBOUNCE_MS,
        );
      } else {
        // Buffer full, flush now then start new buffer
        this.flushBuffer(bufferKey, agentId, agentName, member);
        this.debounceBuffers.set(bufferKey, {
          messages: [text],
          ctx,
          attachments: attachments ? [...attachments] : [],
          createdAt: Date.now(),
          timer: setTimeout(
            () => this.flushBuffer(bufferKey, agentId, agentName, member),
            QUICK_DEBOUNCE_MS,
          ),
        });
      }
    } else {
      this.debounceBuffers.set(bufferKey, {
        messages: [text],
        ctx,
        attachments: attachments ? [...attachments] : [],
        createdAt: Date.now(),
        timer: setTimeout(
          () => this.flushBuffer(bufferKey, agentId, agentName, member),
          QUICK_DEBOUNCE_MS,
        ),
      });
    }
  }

  private flushBuffer(
    bufferKey: string,
    agentId: string,
    agentName: string,
    member: typeof familyMembers.$inferSelect,
  ): void {
    const buffer = this.debounceBuffers.get(bufferKey);
    if (!buffer) return;

    this.debounceBuffers.delete(bufferKey);

    const combinedMessage = buffer.messages.join("\n");
    const ctx = buffer.ctx;
    const attachments = buffer.attachments.length > 0 ? buffer.attachments : undefined;
    const traceId = crypto.randomUUID();
    const debounceMs = Date.now() - buffer.createdAt;
    console.log(`[perf:${traceId}] telegram debounce=${debounceMs}ms parts=${buffer.messages.length}`);

    void this.enqueueAgentWork(agentId, member.id, async () => {
      try {
        await this.processMessage(ctx, agentId, agentName, member, combinedMessage, attachments, traceId);
      } catch (err) {
        console.error(`[multi-relay:${agentName}] Error in processMessage:`, err);
        try {
          await ctx.reply("I'm having trouble right now. Try again in a minute.");
        } catch {
          // swallow
        }
      }
    });
  }

  private async processMessage(
    ctx: Context,
    agentId: string,
    agentName: string,
    member: typeof familyMembers.$inferSelect,
    message: string,
    attachments?: import("@carsonos/shared").MediaAttachment[],
    traceId = crypto.randomUUID(),
  ): Promise<void> {
    // Typing indicator until first delta arrives
    let typingInterval: ReturnType<typeof setInterval> | null = null;
    void ctx.replyWithChatAction("typing").catch(() => {});
    typingInterval = setInterval(async () => {
      try { await ctx.replyWithChatAction("typing"); } catch { /* swallow */ }
    }, 4000);

    // Set up streaming — edits Telegram message in real-time as tokens arrive
    // Keep typing indicator running throughout (covers tool call gaps)
    const stream = createTelegramStream(ctx, { traceId });

    // 1. Constitution engine with streaming
    let engineResult;
    try {
      engineResult = await this.engine.processMessage({
        agentId,
        memberId: member.id,
        householdId: member.householdId,
        message,
        channel: "telegram",
        onTextDelta: stream.onDelta,
        attachments,
        traceId,
      });
    } catch (err) {
      if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
      await stream.finish();
      throw err;
    }

    if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }

    // Finish streaming — returns messageId for in-place edit
    const { messageId: streamMsgId } = await stream.finish();

    if (engineResult.blocked) {
      if (streamMsgId) {
        try { await ctx.api.deleteMessage(ctx.chat!.id, streamMsgId); } catch { /* swallow */ }
      }
      await this.sendFormatted(ctx, engineResult.response);
      return;
    }

    // 2. Send the agent's response. v0.4 delegation happens via MCP tool
    // calls during the agent's turn — no post-response XML parsing step.
    const finalText = engineResult.response;

    if (streamMsgId) {
      // Streaming already formatted HTML in-place — nothing more to do.
      // For long responses that exceed a single message, send overflow as new messages.
      const { chunkMessage } = await import("./telegram-format.js");
      const fullHtml = markdownToTelegramHtml(stripThinkingBlocks(finalText));
      const chunks = chunkMessage(fullHtml);
      if (chunks.length > 1) {
        // First chunk is already in the streaming message — send the rest
        for (let i = 1; i < chunks.length; i++) {
          if (!chunks[i].trim()) continue;
          try {
            await ctx.reply(chunks[i], { parse_mode: "HTML" });
          } catch {
            // Fallback to plain text
            await ctx.reply(chunks[i].replace(/<[^>]+>/g, "").slice(0, 4096));
          }
        }
      }
    } else {
      // No streaming message was created (maybe no deltas) — send fresh
      await this.sendFormatted(ctx, finalText);
    }
  }

  // ── Formatted sending ─────────────────────────────────────────────

  /**
   * Send a message with markdown-to-HTML conversion, thinking block
   * stripping, and auto-chunking for long messages.
   */
  private async sendFormatted(ctx: Context, text: string): Promise<void> {
    const { markdownToTelegramHtml, chunkMessage, stripThinkingBlocks } =
      await import("./telegram-format.js");
    const { extractAndRenderTables } =
      await import("./telegram-table-image.js");

    // Strip thinking blocks
    const cleaned = stripThinkingBlocks(text);

    // Extract tables and render as images
    let textForHtml = cleaned;
    const tableImages: Array<{ image: Buffer; caption: string }> = [];
    try {
      const { cleanText, images } = await extractAndRenderTables(cleaned);
      if (images.length > 0) {
        textForHtml = cleanText;

        // Generate LLM descriptions for each table caption
        for (const tableImg of images) {
          try {
            const descResult = await this.adapter.execute({
              systemPrompt: "Describe what this table contains in one short sentence (under 100 chars). Focus on the actual data, not the structure. Just the description, nothing else. No quotes.",
              messages: [{ role: "user", content: tableImg.markdown }],
            });
            tableImg.caption = descResult.content.trim().replace(/^["']|["']$/g, "").slice(0, 100);
          } catch {
            // Keep the header-based fallback caption
          }
          tableImages.push(tableImg);
        }
      }
    } catch (err) {
      console.error("[multi-relay] Table image extraction failed:", err);
    }

    // Convert remaining markdown to Telegram HTML
    // Clean up [table sent as image] placeholders and surrounding whitespace
    textForHtml = textForHtml.replace(/\[table sent as image\]/g, "").replace(/\n{3,}/g, "\n\n").trim();
    const html = markdownToTelegramHtml(textForHtml);

    // Chunk if needed
    const chunks = chunkMessage(html);

    // Send text chunks interleaved with table images at natural positions
    // Simple approach: send all text first, then all table images
    // (Telegram doesn't support inline images in text)
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      try {
        await ctx.reply(chunk, { parse_mode: "HTML" });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[multi-relay] HTML parse failed: ${errMsg}`);
        console.error(`[multi-relay] Failed HTML (first 500): ${chunk.slice(0, 500)}`);
        await ctx.reply(textForHtml.slice(0, MAX_MESSAGE_LENGTH));
        break;
      }
    }

    // Send table images after text
    for (const { image, caption } of tableImages) {
      const { InputFile } = await import("grammy");
      await ctx.replyWithPhoto(new InputFile(image, "table.png"), { caption });
    }
  }

  // ── Delegation result delivery ────────────────────────────────────

  private async deliverDelegationResult(data: {
    memberId: string | null;
    agentId: string;
    conversationId: string | null;
    response: string;
  }): Promise<void> {
    if (!data.memberId || !data.response) return;

    const managed = this.bots.get(data.agentId);
    if (!managed || !managed.running) {
      console.warn(`[multi-relay] Cannot deliver delegation result: bot for ${data.agentId} not running`);
      return;
    }

    const [member] = await this.db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, data.memberId))
      .limit(1);

    if (!member?.telegramUserId) {
      console.warn(`[multi-relay] Cannot deliver: member ${data.memberId} has no Telegram ID`);
      return;
    }

    try {
      const { markdownToTelegramHtml, chunkMessage, stripThinkingBlocks } =
        await import("./telegram-format.js");
      const { extractAndRenderTables } =
        await import("./telegram-table-image.js");
      const { InputFile } = await import("grammy");

      const cleaned = stripThinkingBlocks(data.response);

      // Render tables as images
      let textForHtml = cleaned;
      try {
        const { cleanText, images } = await extractAndRenderTables(cleaned);
        if (images.length > 0) {
          textForHtml = cleanText;
          for (const { image, caption } of images) {
            await managed.bot.api.sendPhoto(member.telegramUserId, new InputFile(image, "table.png"), { caption });
          }
        }
      } catch { /* continue with text */ }

      const html = markdownToTelegramHtml(textForHtml);
      const chunks = chunkMessage(html);

      for (const chunk of chunks) {
        if (!chunk.trim() || chunk.trim() === "[table sent as image]") continue;
        try {
          await managed.bot.api.sendMessage(member.telegramUserId, chunk, {
            parse_mode: "HTML",
          });
        } catch {
          await managed.bot.api.sendMessage(member.telegramUserId, cleaned.slice(0, MAX_MESSAGE_LENGTH));
          break;
        }
      }

      console.log(`[multi-relay:${managed.agentName}] Delivered delegation result to ${member.name}`);
    } catch (err) {
      console.error(`[multi-relay:${managed.agentName}] Failed to deliver delegation result:`, err);
    }
  }

  /**
   * Send a message to a Telegram user via a specific agent's bot.
   * v0.4: accepts optional `replyMarkup` (inline buttons) and returns the
   * message id of the sent message — the notifier stores it in
   * delegation_notifications for server-side dedup so a retry after a
   * silent Telegram success becomes a no-op.
   *
   * When `replyMarkup` is present, we truncate to a single message (inline
   * keyboards can't span chunks) instead of splitting the payload.
   */
  /** Edit a previously-sent message and strip its inline buttons. Used by
   * the web-UI approval path to stamp the Telegram approval card with
   * "✅ Approved" so a parent approving a hire from the dashboard doesn't
   * leave live Approve/Reject buttons sitting in the chat. Idempotent-ish:
   * Telegram returns "message is not modified" if we edit to the same text;
   * we swallow that.
   *
   * Returns true on successful edit, false on any error — caller decides
   * whether a failed edit is load-bearing (usually it isn't). */
  async editMessage(
    agentId: string,
    telegramUserId: string,
    messageId: number | string,
    text: string,
  ): Promise<boolean> {
    const managed = this.bots.get(agentId);
    if (!managed?.running) return false;
    try {
      await managed.bot.api.editMessageText(
        telegramUserId,
        Number(messageId),
        text,
        { parse_mode: "HTML", reply_markup: undefined },
      );
      return true;
    } catch (err) {
      // Already-edited / 48h window / plain-text conflict — not load-bearing.
      console.warn(`[multi-relay:${managed.agentName}] editMessage(${messageId}) failed:`, err);
      return false;
    }
  }

  /** Serialize an async operation behind the agent/member's in-flight user
   * turn, if any. Used by the v0.4 back-channel wake so a task-completion turn
   * doesn't race a real user message on the same Agent SDK session.
   *
   * Chain is shared with `flushBuffer`'s queue — user messages + wakes are
   * merged into one per-conversation ordered stream. Returns a promise that
   * resolves when the enqueued work finishes (success or failure). */
  async enqueueAgentWork(agentId: string, memberId: string | null, fn: () => Promise<void>): Promise<void> {
    const queueKey = memberId ? `${agentId}:${memberId}` : agentId;
    const previousWork = this.agentQueues.get(queueKey) ?? Promise.resolve();
    const currentWork = previousWork
      .catch(() => {
        // Previous work failed; shouldn't block this one.
      })
      .then(fn);
    this.agentQueues.set(queueKey, currentWork);
    currentWork.finally(() => {
      if (this.agentQueues.get(queueKey) === currentWork) {
        this.agentQueues.delete(queueKey);
      }
    }).catch(() => {});
    await currentWork;
  }

  async sendMessage(
    agentId: string,
    telegramUserId: string,
    text: string,
    options: { replyMarkup?: unknown } = {},
  ): Promise<{ messageId?: string }> {
    const managed = this.bots.get(agentId);
    if (!managed?.running) {
      throw new Error(`Bot for agent ${agentId} is not running`);
    }

    const { markdownToTelegramHtml, chunkMessage } = await import("./telegram-format.js");
    const html = markdownToTelegramHtml(text);

    if (options.replyMarkup) {
      // Inline keyboard path — single message only.
      const truncated =
        html.length > MAX_MESSAGE_LENGTH ? html.slice(0, MAX_MESSAGE_LENGTH - 20) + "…" : html;
      try {
        const sent = await managed.bot.api.sendMessage(telegramUserId, truncated, {
          parse_mode: "HTML",
          reply_markup: options.replyMarkup as never,
        });
        return { messageId: String(sent.message_id) };
      } catch {
        const plain = text.length > MAX_MESSAGE_LENGTH - 20 ? text.slice(0, MAX_MESSAGE_LENGTH - 20) : text;
        const sent = await managed.bot.api.sendMessage(telegramUserId, plain, {
          reply_markup: options.replyMarkup as never,
        });
        return { messageId: String(sent.message_id) };
      }
    }

    // Chunk path — no markup, text can span multiple messages.
    const chunks = chunkMessage(html);
    let lastMessageId: string | undefined;
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      try {
        const sent = await managed.bot.api.sendMessage(telegramUserId, chunk, { parse_mode: "HTML" });
        lastMessageId = String(sent.message_id);
      } catch {
        const sent = await managed.bot.api.sendMessage(
          telegramUserId,
          text.slice(0, MAX_MESSAGE_LENGTH),
        );
        lastMessageId = String(sent.message_id);
        break;
      }
    }
    return { messageId: lastMessageId };
  }

  /**
   * Check if any running bot can reach a Telegram user (via getChat).
   * Used by the scheduler to pre-flight delivery before spending tokens.
   * Results cached for 5 minutes to avoid N API calls per tick.
   */
  private reachabilityCache = new Map<string, { reachable: boolean; expiresAt: number }>();

  async canReachUser(telegramUserId: string): Promise<boolean> {
    const cached = this.reachabilityCache.get(telegramUserId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.reachable;
    }

    for (const [, managed] of this.bots) {
      if (!managed.running) continue;
      try {
        await managed.bot.api.getChat(telegramUserId);
        this.reachabilityCache.set(telegramUserId, { reachable: true, expiresAt: Date.now() + 5 * 60_000 });
        return true;
      } catch {
        // This bot can't reach them, try the next
      }
    }

    this.reachabilityCache.set(telegramUserId, { reachable: false, expiresAt: Date.now() + 5 * 60_000 });
    return false;
  }

  /**
   * Try to send a message via any running bot (fallback when the primary bot
   * hasn't been messaged by the user yet). Skips the excluded agent.
   * Returns true if any bot succeeded.
   */
  async sendToAnyBot(telegramUserId: string, text: string, excludeAgentId?: string): Promise<boolean> {
    for (const [agentId, managed] of this.bots) {
      if (agentId === excludeAgentId || !managed.running) continue;
      try {
        await this.sendMessage(agentId, telegramUserId, text);
        console.log(`[multi-relay] Fallback delivery via ${managed.agentName} succeeded`);
        return true;
      } catch {
        // This bot can't reach them either, try the next
      }
    }
    return false;
  }

  private logMemory(): void {
    const heap = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
    console.log(`[multi-relay] ${this.bots.size} bots running, heap: ${heap}MB`);
  }
}
