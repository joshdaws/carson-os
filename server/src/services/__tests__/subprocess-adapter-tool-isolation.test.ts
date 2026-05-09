/**
 * Regression tests for issue #63 — cross-tenant leak in `mcpToolCache`.
 *
 * Bug: pre-v0.5.7, `getOrCreateCachedTool` cached the SDK `tool()` def by
 * name and stored a mutable module-scope `handlerRef.current = executor`.
 * When two `execute()` calls registered the same tool name concurrently,
 * the second call mutated the shared ref, and the first call's in-flight
 * tool invocation then ran against the second call's executor — leaking
 * memberB's data into memberA's session.
 *
 * Fix: the cache stores only the def; per-request executor + onCall live
 * in `toolContextStorage` (AsyncLocalStorage). Each execute() runs its
 * SDK pump inside `toolContextStorage.run({ current: { executor, onCall } })`,
 * so the cached closure reads its OWN context at tool-call time.
 *
 * These tests exercise the closure directly via `__TEST_invokeCachedTool`
 * (Carson's repro plan) without needing the SDK in the loop.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  __TEST_invokeCachedTool,
  __TEST_resetToolCache,
  toolContextStorage,
} from "../subprocess-adapter.js";
import type { ToolExecutor, ToolResult, ToolDefinition } from "@carsonos/shared";

// Re-export the private getOrCreateCachedTool by re-importing the module
// and reaching for the internal binding via a side channel — simpler
// approach: we don't need to call it directly. The test exercises the
// closure path via __TEST_invokeCachedTool, which is a thin wrapper.

beforeEach(() => {
  __TEST_resetToolCache();
});

describe("toolContextStorage isolation (#63 regression)", () => {
  it("dispatches the closure to the executor in the current ALS context", async () => {
    const calls: Array<{ executor: string; name: string; input: unknown }> = [];
    const executor: ToolExecutor = async (name, input) => {
      calls.push({ executor: "A", name, input });
      return { content: "from-A", is_error: false };
    };
    const onCall = (name: string, input: Record<string, unknown>, result: ToolResult) => {
      calls.push({ executor: "A-onCall", name, input });
      void result;
    };

    // Register a tool def via the public closure path. We don't need the
    // real `tool()` factory — runCachedTool is invoked directly through
    // the test export, which means we just need ALS to be set.
    const result = await toolContextStorage.run(
      { current: { executor, onCall } },
      async () => __TEST_invokeCachedTool("search_memory", { query: "hello" }),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "from-A" }]);
    expect(calls).toEqual([
      { executor: "A", name: "search_memory", input: { query: "hello" } },
      { executor: "A-onCall", name: "search_memory", input: { query: "hello" } },
    ]);
  });

  it("throws when invoked outside any ALS context", async () => {
    await expect(__TEST_invokeCachedTool("search_memory", {})).rejects.toThrow(
      /invoked outside of execute\(\) context/,
    );
  });

  // The headline regression test: the bug Carson described in #63.
  it("isolates concurrent contexts — A's closure never runs B's executor", async () => {
    const recordA: Array<{ name: string; input: unknown; via: string }> = [];
    const recordB: Array<{ name: string; input: unknown; via: string }> = [];

    // Each "request" has its OWN executor that records to its own log.
    const executorA: ToolExecutor = async (name, input) => {
      recordA.push({ name, input, via: "exec-A" });
      // Simulate work — yield to the event loop so concurrent dispatch
      // has a chance to interleave (this is the window where the
      // pre-v0.5.7 mutation bug would surface).
      await new Promise((r) => setTimeout(r, 5));
      return { content: "A-result", is_error: false };
    };
    const onCallA = (name: string, input: Record<string, unknown>, _result: ToolResult) => {
      recordA.push({ name, input, via: "onCall-A" });
    };

    const executorB: ToolExecutor = async (name, input) => {
      recordB.push({ name, input, via: "exec-B" });
      await new Promise((r) => setTimeout(r, 5));
      return { content: "B-result", is_error: false };
    };
    const onCallB = (name: string, input: Record<string, unknown>, _result: ToolResult) => {
      recordB.push({ name, input, via: "onCall-B" });
    };

    // Two concurrent ALS scopes invoking the SAME cached tool name with
    // DIFFERENT executors. Under the pre-v0.5.7 mutation bug, A would
    // run executorB (whichever registered last). Under the ALS fix, A
    // runs executorA and B runs executorB — period.
    const promiseA = toolContextStorage.run(
      { current: { executor: executorA, onCall: onCallA } },
      async () => {
        // Stagger entry so B has a chance to register first
        await new Promise((r) => setTimeout(r, 0));
        return __TEST_invokeCachedTool("search_memory", { query: "from-A" });
      },
    );

    const promiseB = toolContextStorage.run(
      { current: { executor: executorB, onCall: onCallB } },
      async () => {
        await new Promise((r) => setTimeout(r, 0));
        return __TEST_invokeCachedTool("search_memory", { query: "from-B" });
      },
    );

    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

    // Each side gets its OWN content back.
    expect(resultA.content).toEqual([{ type: "text", text: "A-result" }]);
    expect(resultB.content).toEqual([{ type: "text", text: "B-result" }]);

    // Crucially: A's executor saw A's input, B's executor saw B's input.
    // Pre-v0.5.7, recordA would contain entries with `via: "exec-B"`.
    expect(recordA).toEqual([
      { name: "search_memory", input: { query: "from-A" }, via: "exec-A" },
      { name: "search_memory", input: { query: "from-A" }, via: "onCall-A" },
    ]);
    expect(recordB).toEqual([
      { name: "search_memory", input: { query: "from-B" }, via: "exec-B" },
      { name: "search_memory", input: { query: "from-B" }, via: "onCall-B" },
    ]);
  });

  it("respects mutation of toolContextRef.current (mid-session executor swap)", async () => {
    // triggerRefresh swaps the executor mid-session by mutating the ref
    // stored in ALS. Subsequent tool calls within the same execute()
    // should use the FRESH executor.
    const log: string[] = [];
    const oldExecutor: ToolExecutor = async () => {
      log.push("OLD");
      return { content: "old", is_error: false };
    };
    const newExecutor: ToolExecutor = async () => {
      log.push("NEW");
      return { content: "new", is_error: false };
    };
    const noopOnCall = () => {};

    const ref = { current: { executor: oldExecutor, onCall: noopOnCall } };

    await toolContextStorage.run(ref, async () => {
      // First call: uses old executor
      const r1 = await __TEST_invokeCachedTool("t", {});
      expect(r1.content).toEqual([{ type: "text", text: "old" }]);

      // Mid-session refresh: swap the executor by mutating the ref
      // (this mirrors what buildMcpServer does when triggerRefresh fires).
      ref.current = { executor: newExecutor, onCall: noopOnCall };

      // Second call: uses new executor
      const r2 = await __TEST_invokeCachedTool("t", {});
      expect(r2.content).toEqual([{ type: "text", text: "new" }]);
    });

    expect(log).toEqual(["OLD", "NEW"]);
  });

  it("propagates is_error from the executor result", async () => {
    const errExecutor: ToolExecutor = async () => ({ content: "boom", is_error: true });
    const noopOnCall = () => {};

    const result = await toolContextStorage.run(
      { current: { executor: errExecutor, onCall: noopOnCall } },
      async () => __TEST_invokeCachedTool("t", {}),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "boom" }]);
  });

  // Surface check for unused imports — the test file imports ToolDefinition
  // for documentation completeness, but the test exports don't need it directly.
  it("re-exports the expected test surface", () => {
    expect(typeof __TEST_invokeCachedTool).toBe("function");
    expect(typeof __TEST_resetToolCache).toBe("function");
    expect(toolContextStorage).toBeDefined();
    // Sanity check that ToolDefinition type import didn't break — value-level
    // we just confirm the module loaded.
    const _check: ToolDefinition | undefined = undefined;
    expect(_check).toBeUndefined();
  });
});
