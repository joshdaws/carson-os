/**
 * Drains a harness event stream into the flat result the engine needs.
 *
 * The Claude path historically called `adapter.execute()` and read
 * `{ content, sessionId }` off the resolved result. Harnesses stream those as
 * events instead, so this helper folds the stream back into that shape and
 * drives the real-time `onTextDelta` callback as `text_delta` events arrive.
 *
 * `content` comes strictly from the terminal `done` event — a terminal
 * `error` leaves `content` empty and sets `error`, matching the old
 * "adapter threw → friendly message, no partial" behavior. Tool events are
 * ignored here: the engine tracks tool calls through its own wrapped
 * `toolExecutor`, not the harness stream.
 */

import type { HarnessEvent } from "@carsonos/shared";

export interface HarnessTurnResult {
  /** Full assistant text from the terminal `done` event; "" if the turn errored. */
  content: string;
  /** Resume token for the harness (Agent SDK session_id / Codex thread_id). */
  sessionId?: string;
  /** Per-turn cost in USD when the harness reports it (Claude API; null on Max). */
  costUsd?: number;
  /** Token counts when reported. Codex emits these (no cost); Claude on Max often omits both. */
  inputTokens?: number;
  outputTokens?: number;
  /** Set when the turn ended in a terminal `error` event. */
  error?: { recoverable: boolean; message: string };
}

export async function consumeHarnessTurn(
  stream: AsyncIterable<HarnessEvent>,
  onTextDelta?: (text: string) => void,
): Promise<HarnessTurnResult> {
  let content = "";
  let sessionId: string | undefined;
  let costUsd: number | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let error: { recoverable: boolean; message: string } | undefined;

  for await (const ev of stream) {
    switch (ev.type) {
      case "text_delta":
        onTextDelta?.(ev.text);
        break;
      case "session_id":
        sessionId = ev.id;
        break;
      case "usage":
        if (typeof ev.costUsd === "number") costUsd = ev.costUsd;
        if (typeof ev.inputTokens === "number") inputTokens = ev.inputTokens;
        if (typeof ev.outputTokens === "number") outputTokens = ev.outputTokens;
        break;
      case "done":
        content = ev.content;
        break;
      case "error":
        error = { recoverable: ev.recoverable, message: ev.error };
        break;
      case "tool_use_start":
      case "tool_use_end":
        // Engine tracks tool calls via its wrapped toolExecutor; ignore here.
        break;
    }
  }

  return {
    content,
    ...(sessionId ? { sessionId } : {}),
    ...(costUsd != null ? { costUsd } : {}),
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(error ? { error } : {}),
  };
}
