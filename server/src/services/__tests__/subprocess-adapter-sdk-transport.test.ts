/**
 * Regression tests for the v0.5.7 ALS-doesn't-propagate-through-SDK bug.
 *
 * Background:
 *   v0.5.7 (#63) moved the per-request executor + onCall from a mutable
 *   module-scope `handlerRef` into `AsyncLocalStorage` to fix a cross-tenant
 *   leak. The cached tool closure reads the ALS store at tool-call time.
 *
 * Why the existing isolation tests missed the bug:
 *   subprocess-adapter-tool-isolation.test.ts calls the cached closure
 *   DIRECTLY via __TEST_invokeCachedTool, always from inside an
 *   `als.run(...)` block. That test pins the closure path in isolation —
 *   it does not touch the SDK's transport. Production never invokes the
 *   closure that way; the SDK invokes it from a Node event-emitter
 *   callback set up at `query()` call time.
 *
 * The actual bug:
 *   `query()` was called OUTSIDE `toolContextStorage.run(...)`. Async
 *   resources the SDK creates inside `query()` (subprocess stdout
 *   listeners, MCP transport callbacks) snapshot the ALS context active
 *   at registration. Outside `run()`, that snapshot is empty. When the
 *   listener later fires a tool callback, `toolContextStorage.getStore()`
 *   returns undefined and the closure throws "no toolContextStorage in
 *   scope" — silently across 25 conversations in production.
 *
 * What these tests cover:
 *   - The principle: a Node async resource scheduled from inside `als.run`
 *     restores that ALS context when it fires later, even from outside
 *     any `run` frame. Scheduled from outside, it does not.
 *   - The integration: a mock SDK whose `query()` schedules a tool
 *     dispatch via `setImmediate` is exercised through the real
 *     `ClaudeAgentSdkAdapter.execute()`. Pre-fix code path (query()
 *     outside run) leaves the executor uncalled; post-fix invokes it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import type { ToolExecutor, ToolDefinition, ToolResult } from "@carsonos/shared";

// ── Hoisted shared state for the SDK mock ───────────────────────────
//
// `vi.mock()` factory bodies are hoisted above imports, so they cannot
// close over module-scope variables defined the normal way. `vi.hoisted`
// is the supported escape hatch — the value is created during hoisting
// and is available both inside the mock factory and in the test body.
const sdkState = vi.hoisted(() => ({
  /** Captured `tool()` handlers, keyed by tool name. */
  handlers: new Map<string, (input: Record<string, unknown>, extra: unknown) => Promise<unknown>>(),
  /**
   * Per-test plan: queue of `query()` invocations. Each call drains
   * one entry — the entry's `toolCalls` are scheduled via setImmediate
   * INSIDE that query()'s synchronous body, so setImmediate's ALS
   * snapshot reflects the ALS frame active at query() call time. That's
   * the exact behaviour of the real SDK transport.
   */
  queryPlan: [] as Array<{ toolCalls: Array<{ name: string; input: Record<string, unknown> }> }>,
  /** Last error thrown from a cached tool handler (if any). */
  lastHandlerError: null as Error | null,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  /**
   * Minimal stand-in for the SDK's `tool()` factory. Captures the
   * handler so the test (driving the mock `query()`) can fire it later
   * via an event-emitter / setImmediate path that mirrors the real
   * SDK's MCP-over-stdio dispatch.
   */
  tool: (name: string, description: string, inputSchema: unknown, handler: (i: Record<string, unknown>, e: unknown) => Promise<unknown>) => {
    sdkState.handlers.set(name, handler);
    return { name, description, inputSchema };
  },
  /** No-op stand-in. We don't need a real MCP server in unit tests. */
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({
    name,
    version: "1.0.0",
    tools,
    instance: {} as unknown,
  }),
  /**
   * The mock SDK pump.
   *
   * Critical detail: this is called synchronously from inside our
   * adapter's `execute()`. Whatever we schedule via `setImmediate`
   * here snapshots the ALS context active AT THIS MOMENT. That
   * snapshot is exactly what the production bug hinges on:
   *
   *   - Pre-fix: `execute()` calls `query()` BEFORE entering the
   *     `toolContextStorage.run(...)` block. The setImmediate below
   *     captures an empty ALS context; the cached tool handler throws.
   *
   *   - Post-fix: `execute()` calls `query()` INSIDE the run block.
   *     The setImmediate captures our request's context; the handler
   *     reads it and succeeds.
   */
  query: () => {
    // Pull the next planned set of tool calls. The plan is set up by
    // the test before triggering execute(); each query() invocation
    // drains one entry, so two concurrent execute()s drain entries 0
    // and 1 in the order they hit query().
    const plan = sdkState.queryPlan.shift() ?? { toolCalls: [] };

    // Schedule every planned tool call via setImmediate RIGHT NOW.
    // "Right now" means: inside the synchronous body of query(),
    // which is itself called from inside the adapter's execute(). Our
    // adapter's fix moved query() inside `toolContextStorage.run(...)`,
    // so the ALS snapshot setImmediate captures here is this request's
    // tool context. Pre-fix code path (query() above the run frame)
    // captures empty context, and the cached tool handler will throw.
    //
    // This mirrors the real SDK: it wires up subprocess stdout
    // listeners + MCP transport callbacks during the synchronous part
    // of query(), which is when the ALS context that those callbacks
    // see for the rest of their lives is fixed.
    const fireQueue: Array<Promise<unknown>> = plan.toolCalls.map(({ name, input }) => {
      const handler = sdkState.handlers.get(name);
      if (!handler) throw new Error(`mock SDK: no handler for ${name}`);
      return new Promise<unknown>((resolve) => {
        setImmediate(async () => {
          try {
            const result = await handler(input, {});
            resolve(result);
          } catch (err) {
            sdkState.lastHandlerError = err as Error;
            resolve({
              content: [{ type: "text" as const, text: `error: ${(err as Error).message}` }],
              isError: true,
            });
          }
        });
      });
    });

    return (async function* () {
      yield {
        type: "system" as const,
        subtype: "init" as const,
        session_id: "test-session",
        model: "sonnet",
        tools: [],
        mcp_servers: [{ name: "mock", status: "connected" }],
        skills: [],
      };

      // Drain so the result message comes after all tool dispatches
      // have returned — same as the SDK does between assistant turns.
      for (const fire of fireQueue) {
        await fire;
      }

      yield {
        type: "result" as const,
        subtype: "success" as const,
        result: "done",
        session_id: "test-session",
        total_cost_usd: 0,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })();
  },
}));

// Imports must come AFTER vi.mock declarations so the module under test
// receives the mocked SDK. (Vitest hoists vi.mock above this line at
// transform time; this ordering matches the documented usage.)
import { ClaudeAgentSdkAdapter, __TEST_resetToolCache, toolContextStorage } from "../subprocess-adapter.js";

beforeEach(() => {
  __TEST_resetToolCache();
  sdkState.handlers.clear();
  sdkState.queryPlan.length = 0;
  sdkState.lastHandlerError = null;
});

// ── Layer 1: the principle (documents Node's ALS contract) ──────────

describe("AsyncLocalStorage propagation through Node event resources", () => {
  it("a setImmediate scheduled INSIDE als.run() restores context when it fires", async () => {
    const als = new AsyncLocalStorage<string>();
    let observed: string | undefined;

    await new Promise<void>((resolve) => {
      als.run("expected", () => {
        // Schedule outside the synchronous body of run(); the immediate
        // fires on the next event loop tick, after run() has returned.
        setImmediate(() => {
          observed = als.getStore();
          resolve();
        });
      });
    });

    expect(observed).toBe("expected");
  });

  it("a setImmediate scheduled OUTSIDE als.run() does NOT see the store (the v0.5.7 bug shape)", async () => {
    const als = new AsyncLocalStorage<string>();
    let observed: string | undefined = "sentinel";

    // Schedule first, run() second. The immediate snapshots an empty
    // ALS context — exactly what `query()` did when called above
    // `toolContextStorage.run(...)` in the buggy v0.5.7 adapter.
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        observed = als.getStore();
        resolve();
      });
      als.run("would-have-been-set", () => {
        // run() body is empty on purpose — the immediate above already
        // captured its (empty) context.
      });
    });

    expect(observed).toBeUndefined();
  });
});

// ── Layer 2: integration through the real adapter ───────────────────

describe("ClaudeAgentSdkAdapter.execute — SDK transport ALS regression", () => {
  it("invokes the toolExecutor when the SDK fires a tool callback via setImmediate", async () => {
    const executor: ToolExecutor = vi.fn(async (_name, _input): Promise<ToolResult> => ({
      content: "executor-result",
      is_error: false,
    }));

    const tools: ToolDefinition[] = [
      {
        name: "test_tool",
        description: "test tool",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      },
    ];

    // The plan: when execute() calls query(), the mock will schedule
    // one tool dispatch via setImmediate. That setImmediate fires from
    // a fresh microtask after the adapter has entered the for-await —
    // exactly when production would crash if query() ran outside the
    // ALS frame.
    sdkState.queryPlan.push({ toolCalls: [{ name: "test_tool", input: { q: "hi" } }] });

    const adapter = new ClaudeAgentSdkAdapter();
    const result = await adapter.execute({
      systemPrompt: "system",
      messages: [{ role: "user", content: "test" }],
      tools,
      toolExecutor: executor,
    });

    // The smoking gun. Pre-fix, the cached tool handler threw "no
    // toolContextStorage in scope" inside the setImmediate, the SDK
    // marshalled that as a tool error, the executor was never called,
    // and `result.toolCalls` would be empty (or the call would have
    // `is_error: true` with the ALS error string).
    expect(sdkState.lastHandlerError).toBeNull();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith("test_tool", { q: "hi" });
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toMatchObject({
      name: "test_tool",
      input: { q: "hi" },
      result: { content: "executor-result", is_error: false },
    });
  });

  it("preserves per-request executor across concurrent execute() calls (no cross-tenant leak)", async () => {
    // Two concurrent execute() calls register the same tool name with
    // DIFFERENT executors. Each call's tool dispatch must reach its
    // OWN executor — that's the contract #63 was filed for. The fix
    // shape (run query() inside als.run) preserves this because each
    // execute()'s setImmediate captures its own ALS context.
    const executorA = vi.fn(async (): Promise<ToolResult> => ({ content: "A", is_error: false }));
    const executorB = vi.fn(async (): Promise<ToolResult> => ({ content: "B", is_error: false }));

    const def: ToolDefinition[] = [
      { name: "leaky_tool", description: "shared name", input_schema: { type: "object", properties: {} } },
    ];

    // Two query() calls in flight, each draining one plan entry. The
    // mock schedules each entry's setImmediate inside its own query()
    // body — which (post-fix) means inside its own ALS frame. So
    // execute A's tool fires under A's context (sees executorA), and
    // execute B's fires under B's (sees executorB). Pre-v0.5.7's
    // mutable handlerRef shared one ref across both, and whichever
    // registered last won — that's the cross-tenant leak.
    sdkState.queryPlan.push({ toolCalls: [{ name: "leaky_tool", input: { from: "A" } }] });
    sdkState.queryPlan.push({ toolCalls: [{ name: "leaky_tool", input: { from: "B" } }] });

    const adapter = new ClaudeAgentSdkAdapter();
    const promiseA = adapter.execute({
      systemPrompt: "A",
      messages: [{ role: "user", content: "from-A" }],
      tools: def,
      toolExecutor: executorA,
    });
    const promiseB = adapter.execute({
      systemPrompt: "B",
      messages: [{ role: "user", content: "from-B" }],
      tools: def,
      toolExecutor: executorB,
    });

    await Promise.all([promiseA, promiseB]);

    // Pre-v0.5.7: the mutable handlerRef was shared, and whichever
    // execute() registered last won — the other side's tool ran
    // against the wrong executor. Post-fix: ALS isolates them.
    expect(executorA).toHaveBeenCalledTimes(1);
    expect(executorA).toHaveBeenCalledWith("leaky_tool", { from: "A" });
    expect(executorB).toHaveBeenCalledTimes(1);
    expect(executorB).toHaveBeenCalledWith("leaky_tool", { from: "B" });
  });

  it("does not crash on a healthy SDK pump (no toolContextStorage error in the result)", async () => {
    // Sanity check: with no tool calls, the pump should drain cleanly
    // and return a normal result. Catches regressions where the ALS
    // wrapper itself starts throwing.
    const adapter = new ClaudeAgentSdkAdapter();
    const result = await adapter.execute({
      systemPrompt: "x",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.content).toBeTruthy();
    // toolCalls is undefined when execute() ran without tools at all
    // (allToolCalls is built but the result shape only includes it
    // when there were tool definitions). Either is fine for this test.
    expect(result.toolCalls === undefined || result.toolCalls.length === 0).toBe(true);
  });
});

// Re-export check so a missing export here surfaces as a test failure
// instead of a silent compile error in another file.
describe("module surface", () => {
  it("exports toolContextStorage", () => {
    expect(toolContextStorage).toBeInstanceOf(AsyncLocalStorage);
  });

  it("emits an EventEmitter at all (sanity for the principle layer)", () => {
    expect(new EventEmitter()).toBeInstanceOf(EventEmitter);
  });
});
