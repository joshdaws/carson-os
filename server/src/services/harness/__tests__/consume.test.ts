/**
 * Tests for consumeHarnessTurn — folding a HarnessEvent stream into the flat
 * { content, sessionId, costUsd, error } shape the engine consumes, and
 * driving the real-time onTextDelta callback.
 */

import { describe, it, expect, vi } from "vitest";
import type { HarnessEvent } from "@carsonos/shared";
import { consumeHarnessTurn } from "../consume.js";

async function* stream(...events: HarnessEvent[]): AsyncIterable<HarnessEvent> {
  for (const e of events) yield e;
}

describe("consumeHarnessTurn", () => {
  it("drives onTextDelta and returns content from the terminal done", async () => {
    const onDelta = vi.fn();
    const result = await consumeHarnessTurn(
      stream(
        { type: "text_delta", text: "Hel" },
        { type: "text_delta", text: "lo" },
        { type: "session_id", harness: "claude", id: "sess-1" },
        { type: "done", content: "Hello" },
      ),
      onDelta,
    );

    expect(onDelta.mock.calls).toEqual([["Hel"], ["lo"]]);
    expect(result).toEqual({ content: "Hello", sessionId: "sess-1" });
  });

  it("captures costUsd from a usage event", async () => {
    const result = await consumeHarnessTurn(
      stream({ type: "usage", costUsd: 0.02 }, { type: "done", content: "x" }),
    );
    expect(result.costUsd).toBe(0.02);
  });

  it("captures token counts from a usage event (Codex reports tokens, no cost)", async () => {
    const result = await consumeHarnessTurn(
      stream({ type: "usage", inputTokens: 1200, outputTokens: 340 }, { type: "done", content: "x" }),
    );
    expect(result.inputTokens).toBe(1200);
    expect(result.outputTokens).toBe(340);
    expect(result.costUsd).toBeUndefined();
  });

  it("leaves content empty and sets error on a terminal error event", async () => {
    const result = await consumeHarnessTurn(
      stream(
        { type: "text_delta", text: "partial" },
        { type: "error", recoverable: false, error: "boom" },
      ),
    );
    expect(result.content).toBe("");
    expect(result.error).toEqual({ recoverable: false, message: "boom" });
  });

  it("reports a recoverable aborted error", async () => {
    const result = await consumeHarnessTurn(
      stream({ type: "error", recoverable: true, error: "aborted" }),
    );
    expect(result.error).toEqual({ recoverable: true, message: "aborted" });
  });

  it("ignores tool_use_* events (engine tracks tools separately)", async () => {
    const result = await consumeHarnessTurn(
      stream(
        { type: "tool_use_start", name: "search_memory", input: {} },
        { type: "tool_use_end", name: "search_memory", result: "ok", isError: false },
        { type: "done", content: "answer" },
      ),
    );
    expect(result).toEqual({ content: "answer" });
  });

  it("works without an onTextDelta callback", async () => {
    const result = await consumeHarnessTurn(
      stream({ type: "text_delta", text: "hi" }, { type: "done", content: "hi" }),
    );
    expect(result.content).toBe("hi");
  });
});
