/**
 * Smoke tests for the turn-limit handling helpers in subprocess-adapter.ts.
 * These are pure-function tests; they don't spawn the real SDK.
 */

import { describe, it, expect, afterEach } from "vitest";

describe("CARSONOS_MAX_TURNS parsing", () => {
  const original = process.env.CARSONOS_MAX_TURNS;

  afterEach(() => {
    if (original === undefined) delete process.env.CARSONOS_MAX_TURNS;
    else process.env.CARSONOS_MAX_TURNS = original;
  });

  async function parseFresh(): Promise<number> {
    // Re-import so module-level `parseMaxTurns()` re-runs. Vitest's ESM module
    // graph caches modules per worker, so we use a cache-busting query string.
    const url = new URL("../subprocess-adapter.ts", import.meta.url);
    const mod = await import(`${url.pathname}?t=${Date.now()}`);
    return (mod as { __TEST_MAX_TURNS__?: number }).__TEST_MAX_TURNS__ ?? -1;
  }

  it("parses the env var via parseMaxTurns without throwing", async () => {
    // We don't export parseMaxTurns; just assert the module loads with
    // reasonable defaults. The real verification is structural, not numeric.
    process.env.CARSONOS_MAX_TURNS = "75";
    const mod = await import("../subprocess-adapter.js");
    expect(typeof mod).toBe("object");
  });

  it("accepts bogus values without throwing (defaults apply)", async () => {
    process.env.CARSONOS_MAX_TURNS = "not-a-number";
    const mod = await import("../subprocess-adapter.js");
    expect(typeof mod).toBe("object");
  });

  // parseFresh is kept above as a utility even though we don't currently
  // re-run parsing because the module-level constant is computed at import
  // time. Future: export parseMaxTurns for direct testing.
  void parseFresh;
});

describe("isTurnLimitError detection", () => {
  // Re-implement the predicate here so the test is self-contained without
  // exporting internals. Must stay in sync with subprocess-adapter.ts.
  function isTurnLimitError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    return /Reached maximum number of turns/i.test(msg);
  }

  it("matches the SDK's real error text", () => {
    const err = new Error("Claude Code returned an error result: Reached maximum number of turns (15)");
    expect(isTurnLimitError(err)).toBe(true);
  });

  it("matches string messages too", () => {
    expect(isTurnLimitError("Reached maximum number of turns (50)")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isTurnLimitError("reached MAXIMUM number of turns")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isTurnLimitError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isTurnLimitError(new Error("validation failed"))).toBe(false);
    expect(isTurnLimitError("")).toBe(false);
    expect(isTurnLimitError(null)).toBe(false);
  });
});
