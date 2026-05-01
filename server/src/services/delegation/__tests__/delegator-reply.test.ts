/**
 * Pure-fake unit tests for DelegatorReply.
 *
 * No DB, no agent runtime — DelegatorReply's deps are all injected (notifier,
 * wake fn, clock), so the interface IS the test surface. Each test asserts
 * on the policy: which retries fire, when the templated fallback kicks in,
 * and whether the wake-success path threads through markDeliveredByWake.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { DelegatorReply, type Clock, type WakeFn } from "../delegator-reply.js";
import type { DelegationNotifier } from "../notifier.js";

interface FakeNotifier {
  markDeliveredByWake: (taskId: string) => Promise<void>;
  deliver: (taskId: string) => Promise<{ delivered: boolean }>;
  markCalls: string[];
  deliverCalls: string[];
  /** When non-empty, each call to markDeliveredByWake consumes the next entry:
   * truthy = throw that error, falsy = succeed. Unwound entries default to success. */
  markFailures: (Error | null)[];
}

function makeNotifier(): FakeNotifier {
  const f: FakeNotifier = {
    markCalls: [],
    deliverCalls: [],
    markFailures: [],
    markDeliveredByWake: async (taskId) => {
      f.markCalls.push(taskId);
      const failure = f.markFailures.shift();
      if (failure) throw failure;
    },
    deliver: async (taskId) => {
      f.deliverCalls.push(taskId);
      return { delivered: true };
    },
  };
  return f;
}

interface SyntheticClock extends Clock {
  sleeps: number[];
}

function makeClock(): SyntheticClock {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

function makeReply(opts: {
  notifier: FakeNotifier;
  wake: WakeFn;
  clock?: Clock;
  retryDelaysMs?: number[];
}): { reply: DelegatorReply; logs: string[] } {
  const logs: string[] = [];
  const reply = new DelegatorReply({
    notifier: opts.notifier as unknown as DelegationNotifier,
    wake: opts.wake,
    clock: opts.clock ?? makeClock(),
    retryDelaysMs: opts.retryDelaysMs ?? [10, 20, 30],
    log: (msg) => logs.push(msg),
  });
  return { reply, logs };
}

describe("DelegatorReply.handleTerminal", () => {
  let notifier: FakeNotifier;
  let clock: SyntheticClock;

  beforeEach(() => {
    notifier = makeNotifier();
    clock = makeClock();
  });

  it("wake succeeds first try → markDeliveredByWake, no templated send", async () => {
    let wakeCalls = 0;
    const wake: WakeFn = async () => {
      wakeCalls += 1;
      return { delivered: true };
    };
    const { reply, logs } = makeReply({ notifier, wake, clock });

    await reply.handleTerminal("task-1");

    expect(wakeCalls).toBe(1);
    expect(notifier.markCalls).toEqual(["task-1"]);
    expect(notifier.deliverCalls).toEqual([]);
    expect(clock.sleeps).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("wake refuses transiently then succeeds → retries with backoff, no templated send", async () => {
    const reasons = ["engine blocked the wake turn", "engine returned no response"];
    let attempt = 0;
    const wake: WakeFn = async () => {
      const reason = reasons[attempt];
      attempt += 1;
      if (reason) return { delivered: false, reason };
      return { delivered: true };
    };
    const { reply, logs } = makeReply({ notifier, wake, clock });

    await reply.handleTerminal("task-2");

    expect(attempt).toBe(3);
    expect(notifier.markCalls).toEqual(["task-2"]);
    expect(notifier.deliverCalls).toEqual([]);
    // Two backoffs fired (after attempts 0 and 1); attempt 2 succeeded.
    expect(clock.sleeps).toEqual([10, 20]);
    expect(logs).toEqual([]);
  });

  it("wake exhausts retry budget → templated fallback fires + warning logged", async () => {
    let attempt = 0;
    const wake: WakeFn = async () => {
      attempt += 1;
      return { delivered: false, reason: "engine blocked the wake turn" };
    };
    const { reply, logs } = makeReply({ notifier, wake, clock });

    await reply.handleTerminal("task-3");

    // Initial attempt + 3 retries = 4 total.
    expect(attempt).toBe(4);
    expect(notifier.markCalls).toEqual([]);
    expect(notifier.deliverCalls).toEqual(["task-3"]);
    expect(clock.sleeps).toEqual([10, 20, 30]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("did not deliver");
    expect(logs[0]).toContain("engine blocked the wake turn");
  });

  it("wake refuses with terminal reason → templated immediately, no retries", async () => {
    let attempt = 0;
    const wake: WakeFn = async () => {
      attempt += 1;
      return { delivered: false, reason: "task not found" };
    };
    const { reply, logs } = makeReply({ notifier, wake, clock });

    await reply.handleTerminal("task-4");

    expect(attempt).toBe(1);
    expect(notifier.deliverCalls).toEqual(["task-4"]);
    expect(clock.sleeps).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("task not found");
  });

  it("wake reason 'task status is cancelled' → terminal, no retries", async () => {
    let attempt = 0;
    const wake: WakeFn = async () => {
      attempt += 1;
      return { delivered: false, reason: "task status is cancelled" };
    };
    const { reply } = makeReply({ notifier, wake, clock });

    await reply.handleTerminal("task-5");

    expect(attempt).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(notifier.deliverCalls).toEqual(["task-5"]);
  });

  it("unknown thrown-error reason → treated as transient, retries", async () => {
    let attempt = 0;
    const wake: WakeFn = async () => {
      attempt += 1;
      if (attempt === 1) return { delivered: false, reason: "ECONNRESET reading socket" };
      return { delivered: true };
    };
    const { reply } = makeReply({ notifier, wake, clock });

    await reply.handleTerminal("task-6");

    expect(attempt).toBe(2);
    expect(notifier.markCalls).toEqual(["task-6"]);
    expect(notifier.deliverCalls).toEqual([]);
    expect(clock.sleeps).toEqual([10]);
  });

  it("markDeliveredByWake transient failure → retries, then succeeds", async () => {
    notifier.markFailures = [new Error("DB locked"), new Error("DB locked")];
    const wake: WakeFn = async () => ({ delivered: true });
    const { reply, logs } = makeReply({ notifier, wake, clock });

    await reply.handleTerminal("task-7a");

    // 2 failures + 1 success.
    expect(notifier.markCalls).toEqual(["task-7a", "task-7a", "task-7a"]);
    expect(notifier.deliverCalls).toEqual([]);
    // Two short retry sleeps fired (after attempts 0 and 1).
    expect(clock.sleeps).toEqual([100, 100]);
    expect(logs).toEqual([]);
  });

  it("markDeliveredByWake exhausts retries → logs error, does not fall back to templated", async () => {
    notifier.markFailures = [
      new Error("DB locked"),
      new Error("DB locked"),
      new Error("DB locked"),
    ];
    const wake: WakeFn = async () => ({ delivered: true });
    const { reply, logs } = makeReply({ notifier, wake, clock });

    await expect(reply.handleTerminal("task-7b")).resolves.toBeUndefined();

    expect(notifier.markCalls).toHaveLength(3);
    // Wake delivered the message; templated must NOT fire (would double-deliver).
    expect(notifier.deliverCalls).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("markDeliveredByWake");
    expect(logs[0]).toContain("after 3 attempts");
  });

  it("wake throws → treated as transient reason, retries continue", async () => {
    let attempt = 0;
    const wake: WakeFn = async () => {
      attempt += 1;
      if (attempt < 3) throw new Error("connect ETIMEDOUT");
      return { delivered: true };
    };
    const { reply, logs } = makeReply({ notifier, wake, clock });

    // Must not reject — a thrown wake should fall through to retries, then
    // templated, never bubble out and skip the user's reply entirely.
    await expect(reply.handleTerminal("task-7c")).resolves.toBeUndefined();

    expect(attempt).toBe(3);
    expect(notifier.markCalls).toEqual(["task-7c"]);
    expect(notifier.deliverCalls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("wake throws repeatedly → exhausts retries, falls back to templated", async () => {
    let attempt = 0;
    const wake: WakeFn = async () => {
      attempt += 1;
      throw new Error("network unreachable");
    };
    const { reply, logs } = makeReply({ notifier, wake, clock });

    await reply.handleTerminal("task-7d");

    expect(attempt).toBe(4); // initial + 3 retries
    expect(notifier.deliverCalls).toEqual(["task-7d"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("network unreachable");
  });

  it("'wake deps not wired' → transient, retries (covers boot ordering)", async () => {
    let attempt = 0;
    const wake: WakeFn = async () => {
      attempt += 1;
      if (attempt < 3) return { delivered: false, reason: "wake deps not wired" };
      return { delivered: true };
    };
    const { reply } = makeReply({ notifier, wake, clock });

    await reply.handleTerminal("task-8");

    expect(attempt).toBe(3);
    expect(notifier.markCalls).toEqual(["task-8"]);
    expect(notifier.deliverCalls).toEqual([]);
    expect(clock.sleeps).toEqual([10, 20]);
  });
});
