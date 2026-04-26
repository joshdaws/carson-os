/**
 * Telegram streaming engine — formatted edit-in-place.
 *
 * Streams formatted HTML as tokens arrive. Tracks open markdown
 * constructs (code fences, bold, italic) and auto-closes them
 * before converting to HTML on each edit. No jarring flash at
 * the end — the message is already formatted when complete.
 *
 * Inspired by OpenClaw's EmbeddedBlockChunker.
 */

import type { Context } from "grammy";
import {
  markdownToTelegramHtml,
  stripThinkingBlocks,
} from "./telegram-format.js";

const EDIT_INTERVAL_MS = 450;
const MAX_MESSAGE_LENGTH = 4096;

// ── Markdown state tracking ────────────────────────────────────────

interface MarkdownState {
  inCodeFence: boolean;
  codeFenceLang: string;
  inBold: boolean;
  inItalic: boolean;
  inStrikethrough: boolean;
}

function createMarkdownState(): MarkdownState {
  return {
    inCodeFence: false,
    codeFenceLang: "",
    inBold: false,
    inItalic: false,
    inStrikethrough: false,
  };
}

/**
 * Scan text and determine which markdown constructs are still open.
 * Uses simple counting — doesn't handle every edge case but covers
 * the common patterns LLMs produce.
 */
function scanMarkdownState(text: string): MarkdownState {
  const state = createMarkdownState();

  const lines = text.split("\n");
  for (const line of lines) {
    // Code fence toggle
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      if (state.inCodeFence) {
        state.inCodeFence = false;
        state.codeFenceLang = "";
      } else {
        state.inCodeFence = true;
        state.codeFenceLang = fenceMatch[1] || "";
      }
      continue;
    }

    // Skip content inside code fences — no inline formatting
    if (state.inCodeFence) continue;

    // Count unescaped markers on this line
    // Bold: **
    const boldCount = (line.match(/(?<!\\)\*\*/g) || []).length;
    if (boldCount % 2 !== 0) state.inBold = !state.inBold;

    // Strikethrough: ~~
    const strikeCount = (line.match(/(?<!\\)~~/g) || []).length;
    if (strikeCount % 2 !== 0) state.inStrikethrough = !state.inStrikethrough;
  }

  return state;
}

/**
 * Append closing markers for any open markdown constructs.
 * This makes partial text safe to convert to HTML.
 */
function closeOpenMarkdown(text: string, state: MarkdownState): string {
  let closed = text;
  if (state.inStrikethrough) closed += "~~";
  if (state.inBold) closed += "**";
  if (state.inCodeFence) closed += "\n```";
  return closed;
}

// ── Stream Consumer ────────────────────────────────────────────────

export interface StreamResult {
  text: string;
  messageId: number | null;
  editCount: number;
  firstDeltaMs: number | null;
  firstEditMs: number | null;
}

export interface TelegramStreamConsumer {
  onDelta: (text: string) => void;
  finish: () => Promise<StreamResult>;
}

export interface TelegramStreamOptions {
  traceId?: string;
}

export function createTelegramStream(ctx: Context, options: TelegramStreamOptions = {}): TelegramStreamConsumer {
  const streamStart = Date.now();
  const tracePrefix = options.traceId ? `[perf:${options.traceId}]` : "[perf]";
  let accumulated = "";
  let messageId: number | null = null;
  let lastSentText = "";
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  let firstDeltaSent = false;
  let firstDeltaMs: number | null = null;
  let firstEditMs: number | null = null;
  let editCount = 0;
  let lastEditAt = 0;
  let queuedRawText: string | null = null;
  let editRunning = false;
  let editLoop: Promise<void> = Promise.resolve();

  async function sendSnapshot(rawText: string) {
    // Clean thinking blocks, auto-close open markdown, convert to HTML
    const cleaned = stripThinkingBlocks(rawText);
    const mdState = scanMarkdownState(cleaned);
    const closedText = closeOpenMarkdown(cleaned, mdState);

    let html: string;
    try {
      html = markdownToTelegramHtml(closedText);
    } catch {
      // Fallback to plain text if conversion fails
      html = cleaned;
    }

    // Truncate for Telegram limit
    if (html.length > MAX_MESSAGE_LENGTH) {
      html = html.slice(0, MAX_MESSAGE_LENGTH - 10) + "…";
    }

    try {
      if (messageId) {
        await ctx.api.editMessageText(ctx.chat!.id, messageId, html, {
          parse_mode: "HTML",
        });
      } else {
        const sent = await ctx.reply(html, { parse_mode: "HTML" });
        messageId = sent.message_id;
      }
      lastSentText = rawText;
      lastEditAt = Date.now();
      editCount++;
      firstEditMs ??= lastEditAt - streamStart;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("not modified")) return;

      // HTML parse failed — try plain text
      if (msg.includes("parse") || msg.includes("HTML") || msg.includes("entities")) {
        try {
          if (messageId) {
            await ctx.api.editMessageText(ctx.chat!.id, messageId, cleaned);
          } else {
            const sent = await ctx.reply(cleaned);
            messageId = sent.message_id;
          }
          lastSentText = rawText;
          lastEditAt = Date.now();
          editCount++;
          firstEditMs ??= lastEditAt - streamStart;
        } catch {
          // Give up on this edit
        }
      }
    }
  }

  function enqueueEdit(force = false) {
    if (!accumulated) return;

    queuedRawText = accumulated;
    if (queuedRawText === lastSentText) {
      queuedRawText = null;
      return;
    }
    if (editRunning) return;

    editRunning = true;
    editLoop = (async () => {
      try {
        while (queuedRawText) {
          const rawText = queuedRawText;
          queuedRawText = null;
          if (rawText === lastSentText) continue;

          if (!force && messageId && lastEditAt > 0) {
            const waitMs = Math.max(0, EDIT_INTERVAL_MS - (Date.now() - lastEditAt));
            if (waitMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, waitMs));
            }
          }

          await sendSnapshot(rawText);
        }
      } finally {
        editRunning = false;
        if (queuedRawText && queuedRawText !== lastSentText) {
          enqueueEdit(force);
        }
      }
    })();
  }

  const onDelta = (text: string) => {
    if (finished) return;
    accumulated += text;
    firstDeltaMs ??= Date.now() - streamStart;

    if (!firstDeltaSent) {
      firstDeltaSent = true;
      enqueueEdit(true);
      return;
    }

    if (editTimer) clearTimeout(editTimer);
    editTimer = setTimeout(() => {
      editTimer = null;
      enqueueEdit();
    }, EDIT_INTERVAL_MS);
  };

  const finish = async (): Promise<StreamResult> => {
    finished = true;
    if (editTimer) {
      clearTimeout(editTimer);
      editTimer = null;
    }

    // Final edit with complete text (all constructs should be closed by LLM)
    enqueueEdit(true);
    await editLoop;

    console.log(
      `${tracePrefix} telegram stream firstDelta=${firstDeltaMs ?? "none"}ms firstEdit=${firstEditMs ?? "none"}ms edits=${editCount} total=${Date.now() - streamStart}ms`,
    );

    return { text: accumulated, messageId, editCount, firstDeltaMs, firstEditMs };
  };

  return { onDelta, finish };
}
