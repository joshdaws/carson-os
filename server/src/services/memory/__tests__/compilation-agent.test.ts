/**
 * Tests for the compilation agent.
 *
 * Critical regression coverage:
 *   - CAS pattern (eng-review critical gap #2): atom appended during
 *     regen leaves the row dirty for the next tick.
 *   - Contradiction detection (eng-review issue 1B): contradictions
 *     surface in compiled view + `_disagreements.md`.
 *   - Per-batch cap from households table.
 *   - Two-layer split + compiled-view render preserves the timeline.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isNotNull } from "drizzle-orm";
import { createDb, type Db, compilationState, households } from "@carsonos/db";
import {
  CompilationAgent,
  splitTwoLayer,
  __test,
} from "../compilation-agent.js";
import type {
  MemoryProvider,
  AdapterExecuteParams,
  AdapterExecuteResult,
} from "@carsonos/shared";
import type { Adapter } from "../../subprocess-adapter.js";

let tmpRoot: string;
let dbPath: string;
let db: Db;

function makeAdapter(reply: string | (() => string)): Adapter {
  return {
    name: "fake",
    execute: async (_p: AdapterExecuteParams): Promise<AdapterExecuteResult> => ({
      content: typeof reply === "string" ? reply : reply(),
    }),
    healthCheck: async () => true,
  };
}

interface FakeFile {
  id: string;
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
  filePath: string;
}

function makeMemoryProvider(seed: Record<string, FakeFile>): {
  provider: MemoryProvider;
  files: Record<string, FakeFile>;
  updates: Array<{ collection: string; id: string; entry: { content?: string; frontmatter?: Record<string, unknown> } }>;
} {
  const files = { ...seed };
  const updates: Array<{ collection: string; id: string; entry: { content?: string; frontmatter?: Record<string, unknown> } }> = [];
  const provider: MemoryProvider = {
    search: async () => ({ entries: [] }),
    save: async () => ({ id: "x", filePath: "/fake/x.md" }),
    update: async (collection, id, entry) => {
      updates.push({ collection, id, entry: entry as never });
      const existing = files[`${collection}:${id}`];
      if (existing) {
        if (entry.content !== undefined) existing.content = entry.content;
        if (entry.frontmatter) existing.frontmatter = { ...existing.frontmatter, ...entry.frontmatter };
      }
      return { id, filePath: existing?.filePath ?? "/fake/x.md" };
    },
    delete: async () => undefined,
    read: async (collection, id) => files[`${collection}:${id}`] ?? null,
    list: async () => [],
  };
  return { provider, files, updates };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "compile-test-"));
  dbPath = join(tmpRoot, "test.db");
  db = createDb(dbPath);
  db.insert(households).values({ id: "h1", name: "Test Family" }).run();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const TWO_LAYER_BODY = `# Grant Daws

(Compiled view — provisional. Will regenerate.)

---

## Timeline

### 2026-04-21 | source: telegram | by: josh | importance: 5

Grant got the role of the Hatter in Wonderland.

### 2026-04-22 | source: telegram | by: becca | importance: 5

Grant's bedtime is 8pm sharp.

### 2026-04-22 | source: telegram | by: josh | importance: 5

Grant goes down at 8:30, not 8.`;

const VALID_LLM_RESPONSE = JSON.stringify({
  summary: "Grant is in the Wonderland production as the Hatter.",
  state: "Active rehearsals.",
  open_threads: ["Confirm bedtime"],
  see_also: ["wonderland-musical"],
  contradictions: [
    {
      topic: "bedtime",
      a: "Becca says 8pm (2026-04-22 telegram)",
      b: "Josh says 8:30pm (2026-04-22 telegram)",
    },
  ],
});

describe("splitTwoLayer", () => {
  it("splits at the first `---` separator", () => {
    const { compiledViewPart, timelinePart } = splitTwoLayer(TWO_LAYER_BODY);
    expect(compiledViewPart).toContain("Grant Daws");
    expect(timelinePart).toContain("## Timeline");
    expect(timelinePart).toContain("Hatter");
  });
  it("returns empty compiled view when body has no separator", () => {
    const { compiledViewPart, timelinePart } = splitTwoLayer("Just a flat body.");
    expect(compiledViewPart).toBe("");
    expect(timelinePart).toBe("Just a flat body.");
  });
});

describe("renderCompiledView", () => {
  it("includes summary, state, open threads, see also, contradictions", () => {
    const view = __test.renderCompiledView("Grant Daws", {
      summary: "S",
      state: "ST",
      open_threads: ["OT"],
      see_also: ["wonderland"],
      contradictions: [{ topic: "bedtime", a: "A", b: "B" }],
    });
    expect(view).toContain("# Grant Daws");
    expect(view).toContain("## State");
    expect(view).toContain("## Open Threads\n\n- OT");
    expect(view).toContain("[[wonderland]]");
    expect(view).toContain("## Contradictions");
    expect(view).toContain("**bedtime**");
  });
  it("omits empty sections", () => {
    const view = __test.renderCompiledView("X", {
      summary: "Just a summary.",
      state: "",
      open_threads: [],
      see_also: [],
      contradictions: [],
    });
    expect(view).not.toContain("## State");
    expect(view).not.toContain("## Open Threads");
    expect(view).not.toContain("## See Also");
    expect(view).not.toContain("## Contradictions");
  });
});

describe("CompilationAgent.compileEntity", () => {
  it("regenerates compiled view above the `---` and preserves timeline below", async () => {
    const { provider, files, updates } = makeMemoryProvider({
      "household:grant-daws": {
        id: "grant-daws",
        title: "Grant Daws",
        content: TWO_LAYER_BODY,
        frontmatter: { type: "person", id: "grant-daws", title: "Grant Daws" },
        filePath: "/fake/grant.md",
      },
    });
    const agent = new CompilationAgent({
      db,
      memoryProvider: provider,
      adapter: makeAdapter(VALID_LLM_RESPONSE),
      memoryRoot: tmpRoot,
    });

    const result = await agent.compileEntity("grant-daws", "household");
    expect(result.summary).toMatch(/Hatter/);
    expect(result.contradictions).toHaveLength(1);

    expect(updates).toHaveLength(1);
    const newBody = files["household:grant-daws"].content;
    // New compiled view appears above `---`.
    expect(newBody).toMatch(/^# Grant Daws/);
    expect(newBody).toContain("## Open Threads");
    expect(newBody).toContain("---");
    // Timeline below `---` is preserved.
    expect(newBody).toContain("## Timeline");
    expect(newBody).toContain("Grant got the role of the Hatter");
    expect(newBody).toContain("Grant goes down at 8:30");
    // last_compiled_at landed in frontmatter.
    expect(files["household:grant-daws"].frontmatter.last_compiled_at).toBeTruthy();
  });

  it("rejects non-entity types (fact, preference, etc.)", async () => {
    const { provider } = makeMemoryProvider({
      "josh:weather": {
        id: "weather",
        title: "Weather",
        content: "Sunny.",
        frontmatter: { type: "fact" },
        filePath: "/fake/w.md",
      },
    });
    const agent = new CompilationAgent({
      db,
      memoryProvider: provider,
      adapter: makeAdapter(VALID_LLM_RESPONSE),
      memoryRoot: tmpRoot,
    });
    await expect(agent.compileEntity("weather", "josh")).rejects.toThrow(/not compilable/);
  });
});

describe("CompilationAgent.tick — CAS pattern (eng-review critical gap #2)", () => {
  it("clears dirty_at on a clean run", async () => {
    const { provider } = makeMemoryProvider({
      "household:grant-daws": {
        id: "grant-daws",
        title: "Grant Daws",
        content: TWO_LAYER_BODY,
        frontmatter: { type: "person" },
        filePath: "/fake/g.md",
      },
    });
    const agent = new CompilationAgent({
      db,
      memoryProvider: provider,
      adapter: makeAdapter(VALID_LLM_RESPONSE),
      memoryRoot: tmpRoot,
    });

    await agent.markDirty("grant-daws", "household");
    const r = await agent.tick();

    expect(r.compiled).toBe(1);
    expect(r.skippedRace).toBe(0);

    const [row] = await db.select().from(compilationState);
    expect(row.dirtyAt).toBeNull();
    expect(row.lastCompiledAt).toBeTruthy();
  });

  it("LEAVES dirty_at non-null when a new atom marks the entity dirty during regen", async () => {
    const { provider } = makeMemoryProvider({
      "household:grant-daws": {
        id: "grant-daws",
        title: "Grant Daws",
        content: TWO_LAYER_BODY,
        frontmatter: { type: "person" },
        filePath: "/fake/g.md",
      },
    });

    // Holder so the adapter callback can call back into the agent that
    // hasn't been constructed yet.
    let agent!: CompilationAgent;
    const adapter: Adapter = {
      name: "fake",
      execute: async () => {
        // Simulate a concurrent atom append mid-regeneration: bump
        // dirtyAt to a fresh timestamp before this LLM call resolves.
        // SQLite stores timestamps at 1s resolution, so we wait >1s
        // to ensure the new timestamp is visibly different from the
        // snapshot the agent already read.
        await new Promise((r) => setTimeout(r, 1100));
        await agent.markDirty("grant-daws", "household");
        return { content: VALID_LLM_RESPONSE };
      },
      healthCheck: async () => true,
    };
    agent = new CompilationAgent({
      db,
      memoryProvider: provider,
      adapter,
      memoryRoot: tmpRoot,
    });

    await agent.markDirty("grant-daws", "household");
    const r = await agent.tick();

    expect(r.compiled).toBe(1);
    expect(r.skippedRace).toBe(1);

    const [row] = await db.select().from(compilationState);
    // The row stays dirty for the next tick — exactly the behaviour eng-review demanded.
    expect(row.dirtyAt).not.toBeNull();
  });

  it("appends to `_disagreements.md` when the LLM returns contradictions", async () => {
    const { provider } = makeMemoryProvider({
      "household:grant-daws": {
        id: "grant-daws",
        title: "Grant Daws",
        content: TWO_LAYER_BODY,
        frontmatter: { type: "person" },
        filePath: "/fake/g.md",
      },
    });
    const agent = new CompilationAgent({
      db,
      memoryProvider: provider,
      adapter: makeAdapter(VALID_LLM_RESPONSE),
      memoryRoot: tmpRoot,
    });

    await agent.markDirty("grant-daws", "household");
    await agent.tick();

    const disagreementsPath = join(tmpRoot, "household", "_disagreements.md");
    expect(existsSync(disagreementsPath)).toBe(true);
    const text = readFileSync(disagreementsPath, "utf-8");
    expect(text).toMatch(/grant-daws \(household\)/);
    expect(text).toMatch(/bedtime/);
  });

  it("respects the per-household batch size cap", async () => {
    const { provider } = makeMemoryProvider({
      "household:a": { id: "a", title: "A", content: TWO_LAYER_BODY, frontmatter: { type: "person" }, filePath: "/x" },
      "household:b": { id: "b", title: "B", content: TWO_LAYER_BODY, frontmatter: { type: "person" }, filePath: "/x" },
      "household:c": { id: "c", title: "C", content: TWO_LAYER_BODY, frontmatter: { type: "person" }, filePath: "/x" },
    });
    // Set the household batch cap to 2.
    db.update(households).set({ compilationBatchSizePerTick: 2 }).run();

    const agent = new CompilationAgent({
      db,
      memoryProvider: provider,
      adapter: makeAdapter(VALID_LLM_RESPONSE),
      memoryRoot: tmpRoot,
    });
    await agent.markDirty("a", "household");
    await agent.markDirty("b", "household");
    await agent.markDirty("c", "household");

    const r = await agent.tick();
    expect(r.compiled).toBe(2); // capped at 2

    // Third entity stays dirty for next tick.
    const remaining = await db
      .select()
      .from(compilationState)
      .where(isNotNull(compilationState.dirtyAt));
    expect(remaining.length).toBeGreaterThanOrEqual(1);
  });
});
