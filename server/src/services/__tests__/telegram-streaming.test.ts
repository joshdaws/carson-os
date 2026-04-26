import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Context } from "grammy";
import { createTelegramStream } from "../telegram-streaming.js";

function createMockContext(): Context {
  return {
    chat: { id: 123 },
    reply: vi.fn(async () => ({ message_id: 456 })),
    api: {
      editMessageText: vi.fn(async () => undefined),
    },
  } as unknown as Context;
}

describe("createTelegramStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends the first delta immediately and coalesces later edits", async () => {
    const ctx = createMockContext();
    const stream = createTelegramStream(ctx, { traceId: "test-trace" });

    stream.onDelta("Hello");
    await vi.runOnlyPendingTimersAsync();

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.api.editMessageText).not.toHaveBeenCalled();

    stream.onDelta(" there");
    await vi.advanceTimersByTimeAsync(200);
    stream.onDelta(", Josh");
    await vi.advanceTimersByTimeAsync(449);

    expect(ctx.api.editMessageText).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.api.editMessageText).toHaveBeenCalledTimes(1);

    const result = await stream.finish();
    expect(result.messageId).toBe(456);
    expect(result.editCount).toBeGreaterThanOrEqual(2);
    expect(result.firstDeltaMs).toBe(0);
    expect(result.firstEditMs).not.toBeNull();
  });
});
