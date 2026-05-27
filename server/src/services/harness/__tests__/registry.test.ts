/**
 * Tests for the harness registry: model-string → harness resolution, the
 * unknown-model → claude fallback, instance memoization, and registration
 * bookkeeping.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  registerHarness,
  resolveHarness,
  hasHarness,
  __TEST_resetRegistry,
} from "../registry.js";
import type { AgentHarness, HarnessCapabilities } from "../types.js";

const caps: HarnessCapabilities = {
  supportsImages: true,
  supportsMcp: true,
  refreshTier: "mid-turn",
  resumeKind: "session_id",
};

function stubHarness(id: string): AgentHarness {
  return {
    id,
    capabilities: caps,
    streamTurn: () => (async function* () {})(),
    healthCheck: async () => ({ healthy: true }),
  };
}

beforeEach(() => {
  __TEST_resetRegistry();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registry", () => {
  it("resolves a Claude model string to the registered claude harness", () => {
    registerHarness("claude", () => stubHarness("claude"));
    expect(resolveHarness("claude-sonnet-4-6").id).toBe("claude");
  });

  it("resolves a Codex model string to the codex harness when registered", () => {
    registerHarness("claude", () => stubHarness("claude"));
    registerHarness("codex", () => stubHarness("codex"));
    expect(resolveHarness("codex/gpt-5.4").id).toBe("codex");
  });

  it("falls back to claude (with a warning) for an unregistered key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerHarness("claude", () => stubHarness("claude"));

    expect(resolveHarness("codex/gpt-5.4").id).toBe("claude");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown_model"));
  });

  it("memoizes instances — resolving twice returns the same object", () => {
    let built = 0;
    registerHarness("claude", () => {
      built++;
      return stubHarness("claude");
    });
    const a = resolveHarness("claude-sonnet-4-6");
    const b = resolveHarness("claude-sonnet-4-6");
    expect(a).toBe(b);
    expect(built).toBe(1);
  });

  it("re-registering a key rebuilds the instance lazily", () => {
    registerHarness("claude", () => stubHarness("claude-v1"));
    const first = resolveHarness("claude-sonnet-4-6");
    registerHarness("claude", () => stubHarness("claude-v2"));
    const second = resolveHarness("claude-sonnet-4-6");
    expect(first).not.toBe(second);
  });

  it("hasHarness reflects registration state", () => {
    expect(hasHarness("claude")).toBe(false);
    registerHarness("claude", () => stubHarness("claude"));
    expect(hasHarness("claude")).toBe(true);
  });

  it("throws if even the fallback harness is unregistered", () => {
    // Nothing registered at all.
    expect(() => resolveHarness("codex/gpt-5.4")).toThrow(/no harness registered for fallback/);
  });
});
