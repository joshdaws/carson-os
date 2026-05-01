/**
 * Tests for the system update self-awareness module (TODO-3).
 *
 * Pure-helper coverage: compareVersions, extractChangelogEntry, sanitizeExcerpt.
 * Integration coverage: checkForUpdate against an injected fake fetcher with
 * an in-memory SQLite (createDb(":memory:")) so the cache TTL, write/read,
 * and clear paths are exercised end-to-end without hitting GitHub.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "@carsonos/db";

import {
  checkForUpdate,
  compareVersions,
  extractChangelogEntry,
  sanitizeExcerpt,
  readUpdateAvailable,
} from "../system-update-check.js";

// ── compareVersions ───────────────────────────────────────────────

describe("compareVersions", () => {
  it("orders 4-digit versions correctly", () => {
    expect(compareVersions("0.5.0", "0.5.1")).toBe(-1);
    expect(compareVersions("0.5.1", "0.5.0")).toBe(1);
    expect(compareVersions("0.5.0", "0.5.0")).toBe(0);
  });

  it("orders mixed 3-digit and 4-digit shapes by zero-padding", () => {
    // 0.5.0 (3-digit) treated as 0.5.0.0 — strictly less than 0.5.0.1
    expect(compareVersions("0.5.0", "0.5.0.1")).toBe(-1);
    expect(compareVersions("0.5.0.0", "0.5.0")).toBe(0);
  });

  it("handles major-version differences", () => {
    expect(compareVersions("0.9.99", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.9.99")).toBe(1);
  });

  it("treats trailing zeros as equal", () => {
    expect(compareVersions("0.5.0", "0.5.0.0")).toBe(0);
    expect(compareVersions("0.5", "0.5.0.0")).toBe(0);
  });
});

// ── extractChangelogEntry ─────────────────────────────────────────

const SAMPLE_CHANGELOG = `# Changelog

All notable changes to CarsonOS will be documented in this file.

## [0.5.1] - 2026-05-01

### Added

- The agent now tells you when an update is available.
- /api/health reports adapter status correctly.

### Why this matters

Closes the loop on the v0.4 → v0.5 manual update pain.

## [0.5.0] - 2026-05-01

### Added — Memory v0.5

- Enrichment worker.
- Compilation agent.

## [0.4.2.1] - 2026-04-27
`;

describe("extractChangelogEntry", () => {
  it("pulls the entry for an existing version", () => {
    const entry = extractChangelogEntry(SAMPLE_CHANGELOG, "0.5.1");
    expect(entry).toContain("The agent now tells you");
    expect(entry).toContain("Closes the loop");
    // Should NOT include the next entry's content.
    expect(entry).not.toContain("Memory v0.5");
    expect(entry).not.toContain("Enrichment worker");
  });

  it("handles the last entry in the file (no following ## [ marker)", () => {
    const entry = extractChangelogEntry(SAMPLE_CHANGELOG, "0.4.2.1");
    expect(entry).toBe(""); // empty body, but still finds the header
  });

  it("returns empty string when version isn't in the changelog", () => {
    expect(extractChangelogEntry(SAMPLE_CHANGELOG, "9.9.9.9")).toBe("");
  });

  it("regex-escapes the version (dots are literal, not 'any char')", () => {
    // 0.5.1 must not match a hypothetical 0X5X1 (dots-as-anything regex bug).
    const malicious = "## [0X5X1] - 2026-05-01\n\nWrong entry.";
    const safe = SAMPLE_CHANGELOG + "\n" + malicious;
    const entry = extractChangelogEntry(safe, "0.5.1");
    expect(entry).not.toContain("Wrong entry");
    expect(entry).toContain("The agent now tells you");
  });
});

// ── sanitizeExcerpt ───────────────────────────────────────────────

describe("sanitizeExcerpt", () => {
  it("strips C0 control bytes (NUL, BEL, ESC, DEL)", () => {
    const dirty = "ok\x00\x07\x1Btext\x7F";
    expect(sanitizeExcerpt(dirty)).toBe("oktext");
  });

  it("preserves legitimate whitespace (tab, newline, carriage return)", () => {
    expect(sanitizeExcerpt("line1\nline2\trow\rend")).toBe("line1\nline2\trow\rend");
  });

  it("caps oversized payloads with a truncation marker", () => {
    const huge = "X".repeat(5000);
    const out = sanitizeExcerpt(huge);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toMatch(/\[truncated to \d+B\]/);
  });

  it("leaves under-cap payloads untouched", () => {
    const small = "A short changelog excerpt.";
    expect(sanitizeExcerpt(small)).toBe(small);
  });
});

// ── checkForUpdate (integration with in-memory DB + fake fetcher) ──

describe("checkForUpdate", () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  function makeFetcher(version: string, changelog: string) {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/VERSION")) {
        return new Response(version);
      }
      if (url.endsWith("/CHANGELOG.md")) {
        return new Response(changelog);
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  it("writes update_available when remote > local", async () => {
    const result = await checkForUpdate(db, {
      currentVersion: "0.5.0",
      fetcher: makeFetcher("0.5.1", SAMPLE_CHANGELOG),
      force: true,
    });
    expect(result).not.toBeNull();
    expect(result!.from).toBe("0.5.0");
    expect(result!.to).toBe("0.5.1");
    expect(result!.changelogExcerpt).toContain("The agent now tells you");

    // Persisted to instance_settings.
    const stored = await readUpdateAvailable(db);
    expect(stored?.to).toBe("0.5.1");
  });

  it("returns null and clears stale state when local >= remote", async () => {
    // First run: remote ahead, state gets written.
    await checkForUpdate(db, {
      currentVersion: "0.5.0",
      fetcher: makeFetcher("0.5.1", SAMPLE_CHANGELOG),
      force: true,
    });
    expect(await readUpdateAvailable(db)).not.toBeNull();

    // Second run: we caught up. State should be cleared.
    const result = await checkForUpdate(db, {
      currentVersion: "0.5.1",
      fetcher: makeFetcher("0.5.1", SAMPLE_CHANGELOG),
      force: true,
    });
    expect(result).toBeNull();
    expect(await readUpdateAvailable(db)).toBeNull();
  });

  it("rejects malformed remote VERSION", async () => {
    const result = await checkForUpdate(db, {
      currentVersion: "0.5.0",
      fetcher: makeFetcher("not-a-version\n<html>broken</html>", SAMPLE_CHANGELOG),
      force: true,
    });
    expect(result).toBeNull();
    expect(await readUpdateAvailable(db)).toBeNull();
  });

  it("survives fetch failures (returns null, no throw)", async () => {
    const failingFetch = (async () => {
      throw new Error("ENETUNREACH");
    }) as typeof fetch;
    const result = await checkForUpdate(db, {
      currentVersion: "0.5.0",
      fetcher: failingFetch,
      force: true,
    });
    expect(result).toBeNull();
  });

  it("respects the 24h cache (no second fetch within window)", async () => {
    let fetchCount = 0;
    const countingFetch = (async (input: RequestInfo | URL) => {
      fetchCount += 1;
      const url = String(input);
      if (url.endsWith("/VERSION")) return new Response("0.5.1");
      return new Response(SAMPLE_CHANGELOG);
    }) as typeof fetch;

    // First call hits the network (force not set, no cache yet).
    await checkForUpdate(db, { currentVersion: "0.5.0", fetcher: countingFetch });
    const firstCount = fetchCount;
    expect(firstCount).toBeGreaterThan(0);

    // Second call within the 24h window hits the cache — no new fetches.
    await checkForUpdate(db, { currentVersion: "0.5.0", fetcher: countingFetch });
    expect(fetchCount).toBe(firstCount);

    // force=true bypasses the cache.
    await checkForUpdate(db, {
      currentVersion: "0.5.0",
      fetcher: countingFetch,
      force: true,
    });
    expect(fetchCount).toBeGreaterThan(firstCount);
  });
});
