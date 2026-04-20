/**
 * Signal streaming engine — accumulate-and-send with typing indicators.
 *
 * Signal has no edit-in-place API (unlike Telegram's editMessageText), so
 * rather than sending partial updates we accumulate all tokens, keep the
 * typing indicator alive while the LLM runs, and deliver the complete
 * formatted text in a single send when finish() is called.
 *
 * The interface mirrors TelegramStreamConsumer so the constitution engine
 * can use either transport without modification — both expose onDelta and
 * finish(), and the engine only calls onDelta with text deltas.
 */

import { stripThinkingBlocks } from "./telegram-format.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface SignalStreamResult {
  text: string;
}

export interface SignalStreamConsumer {
  onDelta: (text: string) => void;
  finish: () => Promise<SignalStreamResult>;
}

// ── Signal text formatting ─────────────────────────────────────────────

/**
 * Convert LLM markdown output to Signal-friendly plain text.
 *
 * Signal renders messages as plain text — no HTML, no markdown.
 * We strip markdown syntax and make the result readable as-is.
 * Code blocks are preserved with indentation; headers and lists
 * are retained but stripped of their syntax markers.
 */
export function markdownToSignalText(text: string): string {
  return text
    // Fenced code blocks: strip fences, preserve content with a blank line
    .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code: string) => {
      const trimmed = code.trim();
      return trimmed ? `\n${trimmed}\n` : "";
    })
    // Inline code: strip backticks, keep content
    .replace(/`([^`\n]+)`/g, "$1")
    // Bold (**text** or __text__): keep content
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    // Italic (*text* or _text_): keep content
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    // Strikethrough
    .replace(/~~([^~\n]+)~~/g, "$1")
    // ATX headers (# ## ###): keep text, no special prefix
    .replace(/^#{1,6}\s+(.+)$/gm, "$1")
    // Horizontal rules → unicode dash line
    .replace(/^[-*_]{3,}\s*$/gm, "─────────────")
    // Blockquotes: strip >
    .replace(/^>\s?/gm, "")
    // Unordered list items: normalize bullet
    .replace(/^[ \t]*[-*+]\s+/gm, "• ")
    // Ordered list items: keep numbering
    .replace(/^[ \t]*(\d+)\.\s+/gm, "$1. ")
    // Collapse 3+ consecutive newlines to 2
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split a long message into chunks that fit within Signal's message size
 * limit (~60KB in practice; we use 4000 chars as a conservative limit to
 * keep messages readable).
 *
 * Splits on paragraph boundaries where possible.
 */
export function chunkSignalMessage(text: string, maxChars = 4000): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;

    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) chunks.push(current);

      // Paragraph itself is too long — hard split on word boundary
      if (para.length > maxChars) {
        let remaining = para;
        while (remaining.length > maxChars) {
          const cut = remaining.lastIndexOf(" ", maxChars);
          const splitAt = cut > 0 ? cut : maxChars;
          chunks.push(remaining.slice(0, splitAt).trim());
          remaining = remaining.slice(splitAt).trim();
        }
        current = remaining;
      } else {
        current = para;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks.filter((c) => c.trim().length > 0);
}

// ── Stream Consumer ────────────────────────────────────────────────────

/**
 * Create a Signal stream consumer.
 *
 * `sendTyping` — called immediately on the first delta and every 4s
 *   thereafter to keep Signal's typing indicator alive. Errors are
 *   swallowed so a failed typing call doesn't abort the LLM pipeline.
 *
 * `onComplete` — called once with the final formatted text when finish()
 *   is called. Responsible for the actual send.
 */
export function createSignalStream(
  sendTyping: () => Promise<void>,
  onComplete: (text: string) => Promise<void>,
): SignalStreamConsumer {
  let accumulated = "";
  let finished = false;
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  let typingStarted = false;

  const startTyping = () => {
    if (typingStarted) return;
    typingStarted = true;
    // Fire immediately, then refresh every 4s (Signal indicator expires ~5s)
    sendTyping().catch(() => {});
    typingInterval = setInterval(() => {
      sendTyping().catch(() => {});
    }, 4_000);
  };

  const stopTyping = () => {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
  };

  const onDelta = (text: string): void => {
    if (finished) return;
    accumulated += text;
  };

  // Start typing indicator immediately at construction — user sees
  // "Carson is typing..." as soon as the relay accepts the message, not
  // only after Claude produces its first text token (which may be 5-15s in
  // with thinking-mode models).
  startTyping();

  const finish = async (): Promise<SignalStreamResult> => {
    finished = true;
    stopTyping();

    const cleaned = stripThinkingBlocks(accumulated);
    const formatted = markdownToSignalText(cleaned);

    if (formatted) {
      try {
        await onComplete(formatted);
      } catch (err) {
        console.error("[signal-stream] Failed to deliver message:", err);
      }
    }

    return { text: accumulated };
  };

  return { onDelta, finish };
}
