/**
 * Tests for ClaudeHarness — the AgentHarness wrapper over the Claude Agent
 * SDK adapter. ClaudeHarness takes an Adapter via its constructor, so these
 * tests inject a hand-rolled fake adapter (no SDK module mock needed) and
 * assert the normalized HarnessEvent stream.
 */

import { describe, it, expect } from "vitest";
import type {
  AdapterExecuteParams,
  AdapterExecuteResult,
  HarnessEvent,
  HarnessTurnParams,
} from "@carsonos/shared";
import type { Adapter } from "../../subprocess-adapter.js";
import { ClaudeHarness } from "../claude-harness.js";

interface FakeBehavior {
  deltas?: string[];
  result?: Partial<AdapterExecuteResult>;
  reject?: Error;
  /** Reject with "aborted" only once the passed AbortController fires. */
  hangUntilAbort?: boolean;
  health?: boolean;
  capture?: (params: AdapterExecuteParams) => void;
}

function makeAdapter(behavior: FakeBehavior): Adapter {
  return {
    name: "fake",
    async execute(params: AdapterExecuteParams): Promise<AdapterExecuteResult> {
      behavior.capture?.(params);
      for (const d of behavior.deltas ?? []) params.onTextDelta?.(d);

      if (behavior.hangUntilAbort) {
        await new Promise<void>((_resolve, reject) => {
          const ac = params.abortController!;
          if (ac.signal.aborted) reject(new Error("aborted"));
          else ac.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if (behavior.reject) throw behavior.reject;

      return {
        content: behavior.result?.content ?? "",
        ...(behavior.result?.toolCalls ? { toolCalls: behavior.result.toolCalls } : {}),
        ...(behavior.result?.sessionId ? { sessionId: behavior.result.sessionId } : {}),
        ...(behavior.result?.metadata ? { metadata: behavior.result.metadata } : {}),
      };
    },
    async healthCheck(): Promise<boolean> {
      return behavior.health ?? true;
    },
  };
}

const baseParams: HarnessTurnParams = {
  systemPrompt: "sys",
  messages: [{ role: "user", content: "hi" }],
};

async function collect(stream: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("ClaudeHarness — happy path", () => {
  it("streams text deltas, then session_id, then done", async () => {
    const harness = new ClaudeHarness(
      makeAdapter({
        deltas: ["Hel", "lo"],
        result: { content: "Hello", sessionId: "sess-1" },
      }),
    );
    const events = await collect(harness.streamTurn(baseParams, new AbortController().signal));

    expect(events).toEqual<HarnessEvent[]>([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "session_id", harness: "claude", id: "sess-1" },
      { type: "done", content: "Hello" },
    ]);
  });

  it("emits tool_use_start/end pairs from the result's toolCalls", async () => {
    const harness = new ClaudeHarness(
      makeAdapter({
        result: {
          content: "done",
          toolCalls: [
            { name: "search_memory", input: { q: "x" }, result: { content: "found" } },
            { name: "send_telegram", input: { msg: "hi" }, result: { content: "err", is_error: true } },
          ],
        },
      }),
    );
    const events = await collect(harness.streamTurn(baseParams, new AbortController().signal));

    expect(events).toEqual<HarnessEvent[]>([
      { type: "tool_use_start", name: "search_memory", input: { q: "x" } },
      { type: "tool_use_end", name: "search_memory", result: "found", isError: false },
      { type: "tool_use_start", name: "send_telegram", input: { msg: "hi" } },
      { type: "tool_use_end", name: "send_telegram", result: "err", isError: true },
      { type: "done", content: "done" },
    ]);
  });

  it("emits a usage event only when costUsd is numeric", async () => {
    const withCost = new ClaudeHarness(
      makeAdapter({ result: { content: "a", metadata: { costUsd: 0.0123 } } }),
    );
    expect(await collect(withCost.streamTurn(baseParams, new AbortController().signal))).toContainEqual({
      type: "usage",
      costUsd: 0.0123,
    });

    // Max subscription reports costUsd: null — no usage event.
    const noCost = new ClaudeHarness(
      makeAdapter({ result: { content: "a", metadata: { costUsd: null } } }),
    );
    const events = await collect(noCost.streamTurn(baseParams, new AbortController().signal));
    expect(events.some((e) => e.type === "usage")).toBe(false);
  });
});

describe("ClaudeHarness — param passthrough", () => {
  it("forwards attachments, resumeSessionId, tools, and traceId to the adapter", async () => {
    let captured: AdapterExecuteParams | undefined;
    const harness = new ClaudeHarness(
      makeAdapter({ result: { content: "ok" }, capture: (p) => (captured = p) }),
    );
    await collect(
      harness.streamTurn(
        {
          ...baseParams,
          attachments: [{ type: "image", mediaType: "image/png", base64: "AAAA" }],
          resumeSessionId: "resume-me",
          traceId: "trace-9",
          tools: [{ name: "t", description: "d", input_schema: {} }],
        },
        new AbortController().signal,
      ),
    );

    expect(captured?.attachments).toHaveLength(1);
    expect(captured?.resumeSessionId).toBe("resume-me");
    expect(captured?.tools).toHaveLength(1);
    expect((captured as AdapterExecuteParams & { traceId?: string }).traceId).toBe("trace-9");
    // The harness always supplies its own abort controller + delta callback.
    expect(captured?.abortController).toBeInstanceOf(AbortController);
    expect(typeof captured?.onTextDelta).toBe("function");
  });
});

describe("ClaudeHarness — failure and abort (never throws)", () => {
  it("maps a rejected execute() to a non-recoverable error event", async () => {
    const harness = new ClaudeHarness(makeAdapter({ reject: new Error("SDK boom") }));
    const events = await collect(harness.streamTurn(baseParams, new AbortController().signal));

    expect(events).toEqual<HarnessEvent[]>([
      { type: "error", recoverable: false, error: "SDK boom" },
    ]);
  });

  it("aborts the adapter's controller and emits a recoverable 'aborted' error", async () => {
    let captured: AdapterExecuteParams | undefined;
    const harness = new ClaudeHarness(
      makeAdapter({ hangUntilAbort: true, capture: (p) => (captured = p) }),
    );
    const ac = new AbortController();

    const events: HarnessEvent[] = [];
    const done = (async () => {
      for await (const e of harness.streamTurn(baseParams, ac.signal)) events.push(e);
    })();

    await new Promise((r) => setImmediate(r));
    ac.abort();
    await done;

    expect(captured?.abortController?.signal.aborted).toBe(true);
    expect(events.at(-1)).toEqual({ type: "error", recoverable: true, error: "aborted" });
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("emits 'aborted' immediately when the signal is already aborted", async () => {
    const harness = new ClaudeHarness(makeAdapter({ hangUntilAbort: true }));
    const events = await collect(harness.streamTurn(baseParams, AbortSignal.abort()));
    expect(events.at(-1)).toEqual({ type: "error", recoverable: true, error: "aborted" });
  });
});

describe("ClaudeHarness — healthCheck + capabilities", () => {
  it("maps adapter health to the harness shape", async () => {
    expect(await new ClaudeHarness(makeAdapter({ health: true })).healthCheck()).toEqual({
      healthy: true,
    });
    const unhealthy = await new ClaudeHarness(makeAdapter({ health: false })).healthCheck();
    expect(unhealthy.healthy).toBe(false);
    expect(unhealthy.reason).toBeTruthy();
  });

  it("declares Claude's capabilities", () => {
    const h = new ClaudeHarness(makeAdapter({}));
    expect(h.id).toBe("claude");
    expect(h.capabilities).toMatchObject({
      supportsImages: true,
      supportsMcp: true,
      refreshTier: "mid-turn",
      resumeKind: "session_id",
    });
  });
});
