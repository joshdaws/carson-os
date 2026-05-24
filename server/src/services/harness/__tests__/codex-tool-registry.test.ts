/**
 * Tests for the per-turn Codex tool registry — bearer-token scoping of a turn's
 * tools + executor, with TTL expiry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolDefinition, ToolExecutor } from "@carsonos/shared";
import { CodexToolRegistry } from "../codex-tool-registry.js";

const tools: ToolDefinition[] = [{ name: "search_memory", description: "d", input_schema: {} }];
const executor: ToolExecutor = async () => ({ content: "ok" });

describe("CodexToolRegistry", () => {
  it("issues a unique opaque token per registration and resolves it", () => {
    const reg = new CodexToolRegistry();
    const a = reg.register(tools, executor);
    const b = reg.register(tools, executor);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(reg.get(a)?.tools).toBe(tools);
    expect(reg.get(b)?.executor).toBe(executor);
    expect(reg.size).toBe(2);
  });

  it("returns undefined for unknown tokens", () => {
    const reg = new CodexToolRegistry();
    expect(reg.get("nope")).toBeUndefined();
  });

  it("unregister is idempotent and drops the turn", () => {
    const reg = new CodexToolRegistry();
    const t = reg.register(tools, executor);
    reg.unregister(t);
    reg.unregister(t);
    expect(reg.get(t)).toBeUndefined();
    expect(reg.size).toBe(0);
  });

  describe("TTL expiry", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("expires a token after its TTL", () => {
      const reg = new CodexToolRegistry();
      const t = reg.register(tools, executor, 1000);
      expect(reg.get(t)).toBeDefined();
      vi.advanceTimersByTime(1001);
      expect(reg.get(t)).toBeUndefined();
    });

    it("sweeps expired entries on the next register()", () => {
      const reg = new CodexToolRegistry();
      reg.register(tools, executor, 1000);
      expect(reg.size).toBe(1);
      vi.advanceTimersByTime(1001);
      reg.register(tools, executor, 1000); // triggers sweep of the stale entry
      expect(reg.size).toBe(1);
    });
  });
});
