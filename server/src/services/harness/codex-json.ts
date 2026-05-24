/**
 * Maps the newline-delimited JSON event stream from `codex exec --json` into
 * normalized {@link HarnessEvent}s.
 *
 * Observed Codex 0.130.0 event schema (see scripts/smoke-codex-mcp):
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"type":"mcp_tool_call","server":..,"tool":..,"arguments":..,"status":"in_progress"}}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *   {"type":"item.completed","item":{"type":"mcp_tool_call",...,"result":{"content":[{"type":"text","text":..}]},"status":"completed"}}
 *   {"type":"turn.completed","usage":{"input_tokens":..,"output_tokens":..,..}}
 *
 * Notes:
 *   - `agent_message` arrives complete at `item.completed` (Codex does not emit
 *     character deltas), so each one becomes a single `text_delta`.
 *   - Codex reports token usage but no per-call cost (ChatGPT subscription), so
 *     the `usage` event carries tokens only.
 *   - The mapper does NOT emit the terminal `done`/`error` — the harness owns
 *     that, since it depends on process exit, not just `turn.completed`.
 */

import type { HarnessEvent } from "@carsonos/shared";

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: Array<{ type?: string; text?: string }> } | null;
  error?: { message?: string } | null;
  status?: string;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class CodexEventMapper {
  private threadId: string | undefined;
  private contentParts: string[] = [];
  private turnCompleted = false;

  /** The captured Codex thread_id (resume token), once `thread.started` is seen. */
  get capturedThreadId(): string | undefined {
    return this.threadId;
  }

  /** Whether a `turn.completed` event was observed (a clean turn boundary). */
  get sawTurnCompleted(): boolean {
    return this.turnCompleted;
  }

  /** Full assistant text accumulated from all `agent_message` items this turn. */
  get content(): string {
    return this.contentParts.join("\n\n");
  }

  /** Map one JSON line to zero or more HarnessEvents. Unknown/malformed lines yield []. */
  handleLine(line: string): HarnessEvent[] {
    const text = line.trim();
    if (!text) return [];

    let ev: CodexEvent;
    try {
      ev = JSON.parse(text) as CodexEvent;
    } catch {
      console.debug(`[harness:codex] unparseable event line: ${text.slice(0, 200)}`);
      return [];
    }

    switch (ev.type) {
      case "thread.started":
        // Capture the resume token but do NOT emit `session_id` here. The
        // harness emits it only on a successful turn, so an aborted/killed turn
        // never persists a thread_id (see the harness's terminal handling).
        if (typeof ev.thread_id === "string") this.threadId = ev.thread_id;
        return [];

      case "item.started":
        if (ev.item?.type === "mcp_tool_call") {
          return [
            {
              type: "tool_use_start",
              name: ev.item.tool ?? ev.item.server ?? "unknown",
              input: ev.item.arguments,
              ...(ev.item.id ? { id: ev.item.id } : {}),
            },
          ];
        }
        return [];

      case "item.completed": {
        const item = ev.item;
        if (!item) return [];
        if (item.type === "agent_message" && typeof item.text === "string") {
          this.contentParts.push(item.text);
          return [{ type: "text_delta", text: item.text }];
        }
        if (item.type === "mcp_tool_call") {
          const resultText = item.result?.content
            ?.map((c) => c.text ?? "")
            .join("")
            .trim();
          const isError = !!item.error || item.status === "failed";
          return [
            {
              type: "tool_use_end",
              name: item.tool ?? item.server ?? "unknown",
              ...(resultText ? { result: resultText } : {}),
              isError,
              ...(item.id ? { id: item.id } : {}),
            },
          ];
        }
        return [];
      }

      case "turn.completed": {
        this.turnCompleted = true;
        const u = ev.usage;
        if (u && (typeof u.input_tokens === "number" || typeof u.output_tokens === "number")) {
          return [
            {
              type: "usage",
              ...(typeof u.input_tokens === "number" ? { inputTokens: u.input_tokens } : {}),
              ...(typeof u.output_tokens === "number" ? { outputTokens: u.output_tokens } : {}),
            },
          ];
        }
        return [];
      }

      default:
        // turn.started, reasoning, and any future event types — ignore.
        return [];
    }
  }
}
