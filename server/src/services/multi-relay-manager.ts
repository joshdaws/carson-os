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
import type { TaskEngine } from "./task-engine.js";
import type { DelegationOrchestrator } from "./delegation-orchestrator.js";
import type { Adapter } from "./subprocess-adapter.js";
import { createTelegramStream } from "./telegram-streaming.js";
import { markdownToTelegramHtml, stripThinkingBlocks } from "./telegram-format.js";

// ── Types ───────────────────────────────────────────────────────────

interface MultiRelayConfig {
  db: Db;
  adapter: Adapter;
  engine: ConstitutionEngine;
  taskEngine: TaskEngine;
  orchestrator: DelegationOrchestrator;
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
}

// ── Constants ───────────────────────────────────────────────────────

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 1500; // Upgraded from 500ms for paste buffering
const MAX_DEBOUNCE_PARTS = 12;
const MAX_DEBOUNCE_CHARS = 50_000;
const MEMORY_LOG_INTERVAL_MS = 5 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 4096;
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 min dedup window
const DEDUP_MAX_SIZE = 2000;
const STALL_CHECK_INTERVAL_MS = 60_000;
const STALL_THRESHOLD_MS = 300_000; // 5 min — SDK calls can take 30-60s with tool loops
const CONFLICT_BACKOFF_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

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

// ── Multi-Relay Manager ─────────────────────────────────────────────

export class MultiRelayManager {
  private db: Db;
  private adapter: Adapter;
  private engine: ConstitutionEngine;
  private taskEngine: TaskEngine;
  private orchestrator: DelegationOrchestrator;
  private bots = new Map<string, ManagedBot>();
  private rateLimiter = new SharedRateLimiter();
  private debounceBuffers = new Map<string, DebounceBuffer>();
  private agentQueues = new Map<string, Promise<void>>();
  private events = new EventEmitter();
  private memoryLogInterval: ReturnType<typeof setInterval> | null = null;
  private stallCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: MultiRelayConfig) {
    this.db = config.db;
    this.adapter = config.adapter;
    this.engine = config.engine;
    this.taskEngine = config.taskEngine;
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

    // Media message handlers (photos, voice, documents, stickers, video)
    const mediaTypes = ["message:photo", "message:voice", "message:document", "message:sticker", "message:video"] as const;
    for (const mediaType of mediaTypes) {
      bot.on(mediaType, async (ctx) => {
        const updateId = ctx.update.update_id;
        if (managed.recentUpdateIds.has(updateId)) return;
        managed.recentUpdateIds.add(updateId);
        managed.lastActivity = Date.now();

        try {
          const { extractMediaText } = await import("./telegram-media.js");
          const extraction = await extractMediaText(ctx, agent.telegramBotToken!);
          if (extraction) {
            const fullText = extraction.caption
              ? `${extraction.caption}\n\n${extraction.text}`
              : extraction.text;
            await this.handleMessage(
              { ...ctx, message: { ...ctx.message!, text: fullText } } as unknown as Context,
              agentId,
              agent.name,
            );
          } else {
            await ctx.reply("I received your message but couldn't process that type of content yet.");
          }
        } catch (err) {
          console.error(`[multi-relay:${agent.name}] Media error:`, err);
          await ctx.reply("I had trouble processing that. Try sending it as text.");
        }
      });
    }

    // Clear any stale webhook, then start with runner
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false });

      const runner = run(bot, {
        runner: {
          fetch: { timeout: 30 },
          silent: true,
        },
        sink: { concurrency: 4 },
      });

      managed.runner = runner;
      managed.running = true;
      this.bots.set(agentId, managed);

      console.log(`[multi-relay] Bot started for ${agent.name} (${agentId})`);
    } catch (err) {
      console.error(`[multi-relay] Failed to start bot for ${agent.name}:`, err);
      // Don't set status to idle on start failure — it prevents recovery on restart
    }
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
  ): Promise<void> {
    const telegramUserId = String(ctx.from!.id);
    const text = ctx.message!.text!;

    console.log(
      `[multi-relay:${agentName}] Message from ${ctx.from!.first_name} (${telegramUserId}): ${text.slice(0, 50)}`,
    );

    if (text.length > MAX_MESSAGE_LENGTH) {
      await ctx.reply("That message is too long. Try breaking it into shorter messages.");
      return;
    }

    // Identify family member
    const [member] = await this.db
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

    // Verify assignment
    const [assignment] = await this.db
      .select()
      .from(staffAssignments)
      .where(
        and(
          eq(staffAssignments.agentId, agentId),
          eq(staffAssignments.memberId, member.id),
        ),
      )
      .limit(1);

    if (!assignment) {
      await ctx.reply("I'm not your assigned agent. Contact your household admin.");
      return;
    }

    // Rate limit
    if (!this.rateLimiter.check(member.id, RATE_LIMIT, RATE_WINDOW_MS)) {
      await ctx.reply("You're sending messages too fast. Please wait a moment.");
      return;
    }

    // Debounce (paste buffering: 1500ms, max 12 parts, 50K chars)
    const bufferKey = `${agentId}:${member.id}`;
    const existingBuf = this.debounceBuffers.get(bufferKey);

    if (existingBuf) {
      clearTimeout(existingBuf.timer);
      const totalChars = existingBuf.messages.reduce((s, m) => s + m.length, 0) + text.length;
      if (existingBuf.messages.length < MAX_DEBOUNCE_PARTS && totalChars < MAX_DEBOUNCE_CHARS) {
        existingBuf.messages.push(text);
        existingBuf.ctx = ctx;
        existingBuf.timer = setTimeout(
          () => this.flushBuffer(bufferKey, agentId, agentName, member),
          DEBOUNCE_MS,
        );
      } else {
        // Buffer full, flush now then start new buffer
        this.flushBuffer(bufferKey, agentId, agentName, member);
        this.debounceBuffers.set(bufferKey, {
          messages: [text],
          ctx,
          timer: setTimeout(
            () => this.flushBuffer(bufferKey, agentId, agentName, member),
            DEBOUNCE_MS,
          ),
        });
      }
    } else {
      this.debounceBuffers.set(bufferKey, {
        messages: [text],
        ctx,
        timer: setTimeout(
          () => this.flushBuffer(bufferKey, agentId, agentName, member),
          DEBOUNCE_MS,
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

    const previousWork = this.agentQueues.get(agentId) ?? Promise.resolve();
    const currentWork = previousWork.then(async () => {
      try {
        await this.processMessage(ctx, agentId, agentName, member, combinedMessage);
      } catch (err) {
        console.error(`[multi-relay:${agentName}] Error in processMessage:`, err);
        try {
          await ctx.reply("I'm having trouble right now. Try again in a minute.");
        } catch {
          // swallow
        }
      }
    });

    this.agentQueues.set(agentId, currentWork);
  }

  private async processMessage(
    ctx: Context,
    agentId: string,
    agentName: string,
    member: typeof familyMembers.$inferSelect,
    message: string,
  ): Promise<void> {
    // Typing indicator until first delta arrives
    let typingInterval: ReturnType<typeof setInterval> | null = null;
    try {
      await ctx.replyWithChatAction("typing");
      typingInterval = setInterval(async () => {
        try { await ctx.replyWithChatAction("typing"); } catch { /* swallow */ }
      }, 4000);
    } catch { /* swallow */ }

    // Set up streaming — edits Telegram message in real-time as tokens arrive
    // Keep typing indicator running throughout (covers tool call gaps)
    const stream = createTelegramStream(ctx);

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

    // 2. Delegation orchestrator
    const conversationId = await this.getConversationId(
      agentId, member.id, member.householdId,
    );

    const delegationResult = await this.orchestrator.handleAgentResponse(
      agentId, member.id, member.householdId, conversationId, engineResult.response,
    );

    if (delegationResult.warnings?.length) {
      for (const warning of delegationResult.warnings) {
        console.warn(`[multi-relay:${agentName}] Delegation warning: ${warning}`);
      }
    }

    // 3. Send final formatted response
    const finalText = delegationResult.delegated
      ? (delegationResult.userMessage || "Working on that for you. I'll have an answer shortly.")
      : (delegationResult.userMessage || engineResult.response);

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

  /**
   * Edit an existing message with formatted HTML content.
   * Falls back to delete+resend if the edit fails (e.g., content too long for single message).
   */
  private async editFormatted(ctx: Context, messageId: number, text: string): Promise<void> {
    const { markdownToTelegramHtml, chunkMessage, stripThinkingBlocks } =
      await import("./telegram-format.js");

    const cleaned = stripThinkingBlocks(text);
    const html = markdownToTelegramHtml(cleaned);
    const chunks = chunkMessage(html);

    if (chunks.length === 1 && chunks[0].trim()) {
      // Single chunk — edit in place
      try {
        await ctx.api.editMessageText(ctx.chat!.id, messageId, chunks[0], {
          parse_mode: "HTML",
        });
        return;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[multi-relay] HTML edit failed: ${errMsg}`);
        // Fall through to delete+resend
      }
    }

    // Multiple chunks or edit failed — delete streaming msg, send formatted chunks
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, messageId);
    } catch { /* swallow */ }
    await this.sendFormatted(ctx, text);
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
    const { InputFile } = await import("grammy");

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

  // ── Helpers ───────────────────────────────────────────────────────

  private async getConversationId(
    agentId: string,
    memberId: string,
    householdId: string,
  ): Promise<string> {
    const { conversations } = await import("@carsonos/db");
    const { desc } = await import("drizzle-orm");

    const today = new Date().toISOString().slice(0, 10);

    const existing = await this.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.agentId, agentId),
          eq(conversations.memberId, memberId),
          eq(conversations.householdId, householdId),
          eq(conversations.channel, "telegram"),
        ),
      )
      .orderBy(desc(conversations.startedAt))
      .limit(1);

    if (existing.length > 0 && existing[0].startedAt.startsWith(today)) {
      return existing[0].id;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db.insert(conversations).values({
      id,
      agentId,
      memberId,
      householdId,
      channel: "telegram",
      startedAt: now,
      lastMessageAt: now,
    });

    return id;
  }

  private logMemory(): void {
    const heap = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
    console.log(`[multi-relay] ${this.bots.size} bots running, heap: ${heap}MB`);
  }
}
