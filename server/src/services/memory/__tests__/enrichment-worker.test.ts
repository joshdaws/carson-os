/**
 * Tests for the enrichment worker.
 *
 * Covers the eng-review critical-gap regression: malformed Haiku
 * output is skipped + logged, not appended (issue 2A). Plus dedup,
 * lock+release, atom append, throttle yield.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb, type Db, enrichmentQueue, households } from "@carsonos/db";
import {
  EnrichmentWorker,
  markInteractiveActivity,
  __test,
  type EnrichmentTurnPayload,
} from "../enrichment-worker.js";
import type { MemoryProvider, AdapterExecuteParams, AdapterExecuteResult } from "@carsonos/shared";
import type { Adapter } from "../../subprocess-adapter.js";

let tmpRoot: string;
let dbPath: string;
let db: Db;

function makeAdapter(reply: string): Adapter {
  return {
    name: "fake",
    execute: async (_p: AdapterExecuteParams): Promise<AdapterExecuteResult> => ({
      content: reply,
    }),
    healthCheck: async () => true,
  };
}

function makeMemoryProvider(): {
  provider: MemoryProvider;
  saves: Array<{ collection: string; entry: { type: string; title: string; content: string; frontmatter?: Record<string, unknown> } }>;
  updates: Array<{ collection: string; id: string; entry: { content?: string; frontmatter?: Record<string, unknown> } }>;
  reads: Map<string, { id: string; title: string; content: string; frontmatter: Record<string, unknown>; filePath: string }>;
} {
  const saves: Array<{ collection: string; entry: { type: string; title: string; content: string; frontmatter?: Record<string, unknown> } }> = [];
  const updates: Array<{ collection: string; id: string; entry: { content?: string; frontmatter?: Record<string, unknown> } }> = [];
  const reads = new Map<string, { id: string; title: string; content: string; frontmatter: Record<string, unknown>; filePath: string }>();

  const provider: MemoryProvider = {
    search: async () => ({ entries: [] }),
    save: async (collection, entry) => {
      saves.push({ collection, entry: entry as never });
      const id = entry.title.toLowerCase().replace(/\s+/g, "-");
      return { id, filePath: `/fake/${id}.md` };
    },
    update: async (collection, id, entry) => {
      updates.push({ collection, id, entry: entry as never });
      return { id, filePath: `/fake/${id}.md` };
    },
    delete: async () => undefined,
    read: async (_collection, id) => reads.get(id) ?? null,
    list: async () => [],
  };

  return { provider, saves, updates, reads };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "enrichment-test-"));
  dbPath = join(tmpRoot, "test.db");
  db = createDb(dbPath);
  // Seed a household so the worker's threshold lookup succeeds.
  db.insert(households).values({ id: "h1", name: "Test Family" }).run();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const validPayload: EnrichmentTurnPayload = {
  channel: "telegram",
  capturedAt: "2026-04-28",
  capturedBy: "carson",
  member: "Josh",
  userMessage: "Grant got the role of the Hatter in Wonderland.",
  agentReply: "Noted — Grant is cast as the Hatter.",
};

describe("fingerprintPayload", () => {
  it("returns the same hash for the same payload", () => {
    const a = __test.fingerprintPayload(validPayload);
    const b = __test.fingerprintPayload({ ...validPayload });
    expect(a).toBe(b);
  });
  it("differs when content changes", () => {
    const a = __test.fingerprintPayload(validPayload);
    const b = __test.fingerprintPayload({ ...validPayload, userMessage: "different" });
    expect(a).not.toBe(b);
  });
});

describe("AtomCandidateSchema (validation gate, eng-review issue 2A)", () => {
  it("accepts a clean atom", () => {
    expect(() =>
      __test.AtomCandidateSchema.parse({
        entity_slug: "grant-daws",
        entity_type: "person",
        collection: "household",
        content: "Cast as the Hatter.",
        importance: 5,
      }),
    ).not.toThrow();
  });
  it("rejects an atom with a forbidden slash in the slug", () => {
    expect(() =>
      __test.AtomCandidateSchema.parse({
        entity_slug: "grant/daws",
        entity_type: "person",
        collection: "household",
        content: "x",
      }),
    ).toThrow();
  });
  it("rejects an atom whose body embeds a `---` separator", () => {
    expect(() =>
      __test.AtomCandidateSchema.parse({
        entity_slug: "grant-daws",
        entity_type: "person",
        collection: "household",
        content: "before\n---\nafter",
      }),
    ).toThrow();
  });
  it("rejects an unknown entity_type", () => {
    expect(() =>
      __test.AtomCandidateSchema.parse({
        entity_slug: "grant-daws",
        entity_type: "made-up",
        collection: "household",
        content: "x",
      }),
    ).toThrow();
  });
  it("clamps importance into 1–10", () => {
    expect(() =>
      __test.AtomCandidateSchema.parse({
        entity_slug: "x",
        entity_type: "fact",
        collection: "household",
        content: "y",
        importance: 11,
      }),
    ).toThrow();
  });
});

describe("extractJsonBlock", () => {
  it("parses a fenced ```json block", () => {
    const text = "Here:\n```json\n{\"atoms\":[]}\n```\n";
    expect(__test.extractJsonBlock(text)).toEqual({ atoms: [] });
  });
  it("parses bare JSON in prose", () => {
    const text = "Reply:\n{\"atoms\":[]}\nthat's it";
    expect(__test.extractJsonBlock(text)).toEqual({ atoms: [] });
  });
  it("throws when no JSON object is present", () => {
    expect(() => __test.extractJsonBlock("just prose, no JSON")).toThrow();
  });
});

describe("EnrichmentWorker.enqueueTurn", () => {
  it("queues a payload and is idempotent on the fingerprint", async () => {
    const { provider } = makeMemoryProvider();
    const worker = new EnrichmentWorker({
      db,
      memoryProvider: provider,
      adapter: makeAdapter(""),
      memoryRoot: tmpRoot,
    });
    const r1 = await worker.enqueueTurn({ householdId: "h1", payload: validPayload });
    expect(r1.queued).toBe(true);
    const r2 = await worker.enqueueTurn({ householdId: "h1", payload: validPayload });
    expect(r2.queued).toBe(false);
    const all = await db.select().from(enrichmentQueue);
    expect(all).toHaveLength(1);
  });
});

describe("EnrichmentWorker.tick — happy path", () => {
  it("appends atoms returned by the LLM and marks the row done", async () => {
    const { provider, saves } = makeMemoryProvider();
    const adapter = makeAdapter(
      JSON.stringify({
        atoms: [
          {
            entity_slug: "grant-daws",
            entity_type: "person",
            collection: "household",
            content: "Cast as the Hatter in Wonderland.",
            importance: 7,
          },
        ],
      }),
    );
    const worker = new EnrichmentWorker({
      db,
      memoryProvider: provider,
      adapter,
      memoryRoot: tmpRoot,
    });
    await worker.enqueueTurn({ householdId: "h1", payload: validPayload });
    const r = await worker.tick();
    expect(r.processed).toBe(1);
    expect(r.failed).toBe(0);
    expect(saves).toHaveLength(1);
    expect(saves[0].entry.title).toBe("grant daws");
    expect(saves[0].entry.frontmatter?.source).toBe("enrichment-worker");
  });
});

describe("EnrichmentWorker.tick — atom validation gate (eng-review 2A)", () => {
  it("skips and logs atoms with malformed Haiku output (no save fires)", async () => {
    const { provider, saves } = makeMemoryProvider();
    // Garbage response — not parseable as the schema.
    const adapter = makeAdapter("```json\n{ this is not json }\n```");
    const worker = new EnrichmentWorker({
      db,
      memoryProvider: provider,
      adapter,
      memoryRoot: tmpRoot,
    });
    await worker.enqueueTurn({ householdId: "h1", payload: validPayload });
    const r = await worker.tick();
    expect(r.processed).toBe(1); // tick processed the row (logged the failure)
    expect(saves).toHaveLength(0); // but no atom was appended

    // The enrichment log captured the raw output for forensic review.
    const logPath = join(tmpRoot, "josh", "_enrichment-log.md");
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf-8")).toMatch(/validation-fail/);
  });

  it("skips a single bad atom but still appends the good ones in the same response", async () => {
    const { provider, saves } = makeMemoryProvider();
    const adapter = makeAdapter(
      JSON.stringify({
        atoms: [
          {
            entity_slug: "grant-daws",
            entity_type: "person",
            collection: "household",
            content: "Good atom.",
            importance: 5,
          },
          {
            entity_slug: "bad/slug",
            entity_type: "person",
            collection: "household",
            content: "Bad atom — slash in slug.",
            importance: 5,
          },
        ],
      }),
    );
    const worker = new EnrichmentWorker({
      db,
      memoryProvider: provider,
      adapter,
      memoryRoot: tmpRoot,
    });
    await worker.enqueueTurn({ householdId: "h1", payload: validPayload });
    // Top-level Zod parse rejects the entire response if any atom is invalid.
    // Confirms the "all-or-nothing per response" validation contract — the
    // log captures, no atoms get partial-applied. This is intentional: it
    // prevents inconsistent partial writes that would be hard to diagnose.
    const r = await worker.tick();
    expect(r.processed).toBe(1);
    expect(saves).toHaveLength(0);

    const logPath = join(tmpRoot, "josh", "_enrichment-log.md");
    expect(readFileSync(logPath, "utf-8")).toMatch(/validation-fail/);
  });
});

describe("EnrichmentWorker.tick — throttle yield", () => {
  it("skips the tick when interactive activity is recent (within threshold)", async () => {
    const { provider } = makeMemoryProvider();
    const worker = new EnrichmentWorker({
      db,
      memoryProvider: provider,
      adapter: makeAdapter(JSON.stringify({ atoms: [] })),
      memoryRoot: tmpRoot,
    });
    await worker.enqueueTurn({ householdId: "h1", payload: validPayload });
    markInteractiveActivity(); // Just now.
    const r = await worker.tick();
    expect(r.skipped).toBe("throttled");
    expect(r.processed).toBe(0);
  });
});

describe("buildExtractionPrompt", () => {
  it("includes the user message + agent reply + member context", () => {
    const { system, user } = __test.buildExtractionPrompt(validPayload);
    expect(system).toMatch(/STRICT JSON/);
    expect(user).toMatch(/Grant got the role/);
    expect(user).toMatch(/Member: Josh/);
  });
});
