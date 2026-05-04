/**
 * Regression tests for MCP server naming.
 *
 * Bug context: prior to this fix, MCP server names were generated as
 * `carsonos-memory-{Date.now()}-{counter}` with `mcpServerCounter` declared
 * inside `execute()`. The counter reset to 0 every conversation turn and the
 * Date.now() suffix changed every call, so each turn produced a brand-new,
 * unpredictable server name. The Claude Agent SDK exposes MCP tools as
 * `mcp__{server-name}__{tool-name}`, so when the LLM resumed a session the
 * tool identifier it remembered was dead — memory tools silently failed to
 * dispatch. The bug existed for ~30 commits because nothing pinned this
 * behavior in tests.
 *
 * These tests pin the post-fix contract so the regression cannot recur:
 *   - Names use the form `carsonos-memory-N` where N is a positive integer.
 *   - The counter is module-scope: consecutive calls produce monotonically
 *     increasing N, and N survives across `execute()` invocations.
 *   - No `Date.now()`-style timestamp appears in the name.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  nextMcpServerName,
  __TEST_resetMcpServerCounter,
} from "../subprocess-adapter.js";

describe("nextMcpServerName", () => {
  beforeEach(() => {
    __TEST_resetMcpServerCounter();
  });

  it("produces names of the form carsonos-memory-N", () => {
    const name = nextMcpServerName();
    expect(name).toMatch(/^carsonos-memory-\d+$/);
  });

  it("starts at 1 after a fresh process / counter reset", () => {
    expect(nextMcpServerName()).toBe("carsonos-memory-1");
  });

  it("increments monotonically across consecutive calls", () => {
    const a = nextMcpServerName();
    const b = nextMcpServerName();
    const c = nextMcpServerName();
    expect(a).toBe("carsonos-memory-1");
    expect(b).toBe("carsonos-memory-2");
    expect(c).toBe("carsonos-memory-3");
  });

  it("never emits a Date.now()-style timestamp suffix", () => {
    // Any suffix component longer than 6 digits is almost certainly a unix
    // timestamp slipped back into the template. Running 100 calls so a
    // future regression that re-introduces Date.now() (which produces a
    // 13-digit ms timestamp) is guaranteed to trip this guard.
    for (let i = 0; i < 100; i += 1) {
      const name = nextMcpServerName();
      const suffix = name.replace("carsonos-memory-", "");
      expect(suffix).toMatch(/^\d+$/);
      expect(Number(suffix)).toBeLessThan(1_000_000);
      expect(name).not.toMatch(/\d{10,}/);
    }
  });

  it("counter survives across simulated execute() boundaries", () => {
    // The original bug was that mcpServerCounter was declared inside
    // execute(), so it reset to 0 on every call. We simulate two separate
    // execute() calls by NOT calling __TEST_resetMcpServerCounter between
    // them — the module-scope counter must keep climbing.
    const callOne = nextMcpServerName();
    const callTwo = nextMcpServerName();
    // (no reset here — that's the point)
    const callThree = nextMcpServerName();
    expect(callOne).toBe("carsonos-memory-1");
    expect(callTwo).toBe("carsonos-memory-2");
    expect(callThree).toBe("carsonos-memory-3");
  });
});
