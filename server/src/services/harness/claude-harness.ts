/**
 * ClaudeHarness — wraps the existing Claude Agent SDK adapter
 * ({@link ClaudeAgentSdkAdapter}) behind the {@link AgentHarness} interface.
 *
 * The adapter exposes a Promise-returning `execute()` with an `onTextDelta`
 * callback and an `AbortController` param. This harness bridges that to an
 * `AsyncIterable<HarnessEvent>`: text deltas stream in real time as they
 * arrive; the session id, tool calls, usage, and the terminal `done` are
 * emitted when the turn finishes. The adapter is the source of truth and is
 * unchanged by this layer — the engine still calls it directly today.
 *
 * Abort is owned here: the incoming `AbortSignal` is linked to a private
 * `AbortController` passed to the adapter, and the harness maps an aborted
 * turn to `{ type: 'error', recoverable: true, error: 'aborted' }`.
 */

import type { AdapterExecuteParams, HarnessEvent, HarnessTurnParams } from "@carsonos/shared";
import type { Adapter } from "../subprocess-adapter.js";
import type { AgentHarness, HarnessCapabilities } from "./types.js";

export class ClaudeHarness implements AgentHarness {
  readonly id = "claude";
  readonly capabilities: HarnessCapabilities = {
    supportsImages: true,
    supportsMcp: true,
    refreshTier: "mid-turn",
    resumeKind: "session_id",
  };

  constructor(private readonly adapter: Adapter) {}

  streamTurn(params: HarnessTurnParams, signal: AbortSignal): AsyncIterable<HarnessEvent> {
    const adapter = this.adapter;
    return (async function* (): AsyncGenerator<HarnessEvent> {
      const queue = new EventQueue();

      // Link the incoming signal to a controller the adapter can act on.
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });

      const execParams: AdapterExecuteParams = {
        systemPrompt: params.systemPrompt,
        messages: params.messages,
        ...(params.attachments ? { attachments: params.attachments } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(params.tools ? { tools: params.tools } : {}),
        ...(params.toolExecutor ? { toolExecutor: params.toolExecutor } : {}),
        ...(params.builtinTools ? { builtinTools: params.builtinTools } : {}),
        ...(params.enabledSkills ? { enabledSkills: params.enabledSkills } : {}),
        ...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
        ...(params.refreshTools ? { refreshTools: params.refreshTools } : {}),
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.maxTurns != null ? { maxTurns: params.maxTurns } : {}),
        onTextDelta: (text) => queue.push({ type: "text_delta", text }),
        abortController: controller,
      };
      // traceId rides the loose extension the adapter reads off params.
      (execParams as AdapterExecuteParams & { traceId?: string }).traceId = params.traceId;

      const run = adapter
        .execute(execParams)
        .then(
          (result) => {
            if (signal.aborted) {
              queue.push({ type: "error", recoverable: true, error: "aborted" });
              return;
            }
            if (result.sessionId) {
              queue.push({ type: "session_id", harness: "claude", id: result.sessionId });
            }
            for (const call of result.toolCalls ?? []) {
              queue.push({ type: "tool_use_start", name: call.name, input: call.input });
              queue.push({
                type: "tool_use_end",
                name: call.name,
                result: call.result.content,
                isError: call.result.is_error ?? false,
              });
            }
            const costUsd = (result.metadata as { costUsd?: number | null } | undefined)?.costUsd;
            if (typeof costUsd === "number") {
              queue.push({ type: "usage", costUsd });
            }
            queue.push({ type: "done", content: result.content });
          },
          (err) => {
            if (signal.aborted) {
              queue.push({ type: "error", recoverable: true, error: "aborted" });
            } else {
              queue.push({
                type: "error",
                recoverable: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          },
        )
        .finally(() => {
          signal.removeEventListener("abort", onAbort);
          queue.close();
        });

      try {
        for await (const event of queue) {
          yield event;
        }
      } finally {
        // Consumer broke early (downstream error): stop compute, then let the
        // execute() promise settle so we don't leak the subprocess.
        controller.abort();
        await run.catch(() => {});
      }
    })();
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    const ok = await this.adapter.healthCheck();
    return ok ? { healthy: true } : { healthy: false, reason: "claude api unreachable" };
  }
}

/**
 * Minimal single-consumer async queue. `push` either hands the event to a
 * waiting iterator or buffers it; `close` ends iteration once the buffer
 * drains. Events pushed after close are dropped.
 */
class EventQueue implements AsyncIterable<HarnessEvent> {
  private items: HarnessEvent[] = [];
  private waiters: Array<(r: IteratorResult<HarnessEvent>) => void> = [];
  private closed = false;

  push(event: HarnessEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.items.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    let waiter: ((r: IteratorResult<HarnessEvent>) => void) | undefined;
    while ((waiter = this.waiters.shift())) {
      waiter({ value: undefined as unknown as HarnessEvent, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<HarnessEvent>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
