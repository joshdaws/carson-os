/**
 * Compilation agent — Phase 2 of v5 memory.
 *
 * Atoms-canonical, views-regenerable: every entity page has a
 * compiled view ABOVE the `---` separator and an append-only atom
 * timeline BELOW it. The compilation agent regenerates the compiled
 * view nightly from the atoms underneath. If the compiled view is
 * wrong, fix or append an atom — the next regen pass repairs it.
 *
 * Key behaviours:
 *   - Per-entity dirty tracking via `compilation_state`. Only entities
 *     whose atoms changed since last run get re-compiled.
 *   - CAS pattern (eng-review critical gap #2): snapshot dirty_at →
 *     regenerate → conditionally clear dirty_at IF and only IF it
 *     still equals the snapshot. A new atom appended during regen
 *     leaves the row dirty for the next tick.
 *   - Contradiction detection appendix (eng-review issue 1B): the
 *     same Haiku call that generates the compiled view also lists any
 *     contradictions across atoms with provenance. Output folded into
 *     the compiled view and appended to household `_disagreements.md`.
 *   - Per-batch cap: `households.compilation_batch_size_per_tick`
 *     (default 20). Prevents quota stalls when many entities are
 *     dirty after an active day.
 *   - 3am family-local cadence. The scheduler integration checks the
 *     local hour; this module's `tick()` is callable for tests
 *     regardless of clock.
 *   - Per-project views (CEO cherry-pick #3): both `person` and
 *     `project` entity types get nightly compiled views.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import {
  compilationState,
  households,
  type Db,
} from "@carsonos/db";
import type { MemoryProvider } from "@carsonos/shared";
import type { Adapter } from "../subprocess-adapter.js";
import { getLastInteractiveActivityAt } from "./enrichment-worker.js";

const DEFAULT_BATCH = 20;
/** Skip entities whose dirty_at is fresher than this — lets atom bursts settle. */
const DEBOUNCE_SECONDS = 60;

const COMPILABLE_TYPES = new Set<string>([
  "person",
  "project",
  "place",
  "media",
  "relationship",
  "commitment",
  "goal",
  "concept",
]);

// ── Schema for the LLM's structured response ────────────────────────

const CompilationResponseSchema = z.object({
  summary: z.string().min(1).max(2000),
  state: z.string().max(2000).optional().default(""),
  open_threads: z.array(z.string()).max(20).optional().default([]),
  see_also: z.array(z.string()).max(20).optional().default([]),
  contradictions: z
    .array(
      z.object({
        topic: z.string().min(1),
        a: z.string().min(1), // claim A with provenance
        b: z.string().min(1), // claim B with provenance
      }),
    )
    .max(10)
    .optional()
    .default([]),
});

type CompilationResponse = z.infer<typeof CompilationResponseSchema>;

// ── Public API ──────────────────────────────────────────────────────

export interface CompilationAgentOptions {
  db: Db;
  memoryProvider: MemoryProvider;
  adapter: Adapter;
  /** Memory root (e.g., `~/projects/brain`). Where `_disagreements.md` goes. */
  memoryRoot: string;
  /** Batch size override; otherwise read per-household. */
  batchSize?: number;
  /** Override the model used for compilation. Defaults to Haiku. */
  model?: string;
  /**
   * Per-entity debounce (seconds): skip entities whose `dirty_at` is
   * fresher than this. Lets atom bursts coalesce. Defaults to 60s.
   * Tests pass 0 to bypass.
   */
  debounceSeconds?: number;
}

export class CompilationAgent {
  private db: Db;
  private memoryProvider: MemoryProvider;
  private adapter: Adapter;
  private memoryRoot: string;
  private batchSize?: number;
  private model: string;
  private debounceSeconds: number;

  constructor(opts: CompilationAgentOptions) {
    this.db = opts.db;
    this.memoryProvider = opts.memoryProvider;
    this.adapter = opts.adapter;
    this.memoryRoot = opts.memoryRoot;
    this.batchSize = opts.batchSize;
    this.model = opts.model ?? "claude-haiku-4-5-20251001";
    this.debounceSeconds = opts.debounceSeconds ?? DEBOUNCE_SECONDS;
  }

  /**
   * Mark an entity as dirty, so the next compilation tick recompiles
   * its view. Idempotent — repeated calls just refresh the timestamp.
   */
  async markDirty(entitySlug: string, entityCollection: string): Promise<void> {
    const now = new Date();
    const existing = await this.db
      .select({ id: compilationState.id })
      .from(compilationState)
      .where(
        and(
          eq(compilationState.entitySlug, entitySlug),
          eq(compilationState.entityCollection, entityCollection),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      await this.db.insert(compilationState).values({
        entitySlug,
        entityCollection,
        dirtyAt: now,
      });
    } else {
      await this.db
        .update(compilationState)
        .set({ dirtyAt: now })
        .where(eq(compilationState.id, existing[0].id));
    }
  }

  /**
   * Run one compilation pass: pick up to `batchSize` dirty entities
   * whose dirty_at is at least DEBOUNCE_SECONDS old (lets atom bursts
   * coalesce into one compile call), regenerate each, and clear the
   * dirty flag IF no new atom landed during regen (CAS).
   *
   * Yields entirely if interactive activity fired within the
   * household's `background_yield_threshold_seconds` (default 90s) —
   * same throttle as the enrichment worker.
   */
  async tick(): Promise<{ compiled: number; failed: number; skippedRace: number; skipped?: "throttled" }> {
    // Yield to interactive activity. This is shared with the enrichment
    // worker — both workers respect the same threshold.
    if (await this.shouldYieldToInteractive()) {
      return { compiled: 0, failed: 0, skippedRace: 0, skipped: "throttled" };
    }

    const limit = await this.resolveBatchSize();
    const debounceCutoff = new Date(Date.now() - this.debounceSeconds * 1000);
    const dirtyRows = await this.db
      .select()
      .from(compilationState)
      .where(
        and(
          isNotNull(compilationState.dirtyAt),
          lte(compilationState.dirtyAt, debounceCutoff),
        ),
      )
      .limit(limit);

    if (dirtyRows.length === 0) {
      return { compiled: 0, failed: 0, skippedRace: 0 };
    }

    const allContradictions: Array<{
      slug: string;
      collection: string;
      contradictions: CompilationResponse["contradictions"];
    }> = [];

    let compiled = 0;
    let failed = 0;
    let skippedRace = 0;

    for (const row of dirtyRows) {
      const dirtySnapshot = row.dirtyAt;
      try {
        const result = await this.compileEntity(row.entitySlug, row.entityCollection);
        // CAS: only clear dirty_at if it still equals the snapshot we read.
        // If a new atom landed mid-regen, dirty_at moved forward — leave it.
        const cleared = await this.db
          .update(compilationState)
          .set({ dirtyAt: null, lastCompiledAt: new Date(), lastError: null })
          .where(
            and(
              eq(compilationState.id, row.id),
              eq(compilationState.dirtyAt, dirtySnapshot!),
            ),
          )
          .returning({ id: compilationState.id });

        if (cleared.length === 0) {
          // Someone marked the row dirtier during our regen. Leave it
          // dirty for the next tick. We did still produce a compiled
          // view this round; the next pass will redo it.
          skippedRace++;
        }

        compiled++;
        if (result.contradictions.length > 0) {
          allContradictions.push({
            slug: row.entitySlug,
            collection: row.entityCollection,
            contradictions: result.contradictions,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.db
          .update(compilationState)
          .set({ lastError: msg.slice(0, 500) })
          .where(eq(compilationState.id, row.id));
        failed++;
      }
    }

    // Roll up contradictions into household `_disagreements.md`.
    if (allContradictions.length > 0) {
      this.appendDisagreements(allContradictions);
    }

    return { compiled, failed, skippedRace };
  }

  /**
   * Compile one entity: read it, prompt the LLM with its atoms, parse
   * the structured response, write the compiled view above the `---`
   * separator without disturbing the timeline below it.
   */
  async compileEntity(slug: string, collection: string): Promise<CompilationResponse> {
    const entry = await this.memoryProvider.read(collection, slug);
    if (!entry) {
      throw new Error(`Entity not found: ${slug} in ${collection}`);
    }
    const type = String(entry.frontmatter.type ?? "");
    if (!COMPILABLE_TYPES.has(type)) {
      throw new Error(`Type "${type}" is not compilable (must be an entity type)`);
    }

    const { compiledViewPart, timelinePart } = splitTwoLayer(entry.content);
    const atomsText = timelinePart || entry.content;

    const prompt = buildCompilationPrompt(entry.title, type, atomsText);
    const result = await this.adapter.execute({
      systemPrompt: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      model: this.model,
      maxTokens: 2000,
    });

    let parsed: CompilationResponse;
    try {
      const json = extractJsonBlock(result.content);
      parsed = CompilationResponseSchema.parse(json);
    } catch (err) {
      throw new Error(
        `compilation parse failed: ${err instanceof Error ? err.message : String(err)} (raw: ${result.content.slice(0, 200)})`,
      );
    }

    const newCompiledView = renderCompiledView(entry.title, parsed);
    const newBody = `${newCompiledView}\n\n---\n\n${atomsText.replace(/^## Timeline\s*\n*/, "## Timeline\n\n")}`;

    await this.memoryProvider.update(collection, slug, {
      content: newBody,
      frontmatter: {
        ...entry.frontmatter,
        last_compiled_at: new Date().toISOString().slice(0, 10),
      },
    });

    // Mark presence of compiledViewPart so we don't lose track of whether
    // a regeneration ever ran. (Kept implicit in the body for now —
    // future enhancement could capture a hash for diffing.)
    void compiledViewPart;

    return parsed;
  }

  // ── helpers ────────────────────────────────────────────────────────

  /** Has interactive activity fired within the household's yield threshold? */
  private async shouldYieldToInteractive(): Promise<boolean> {
    const lastActivity = getLastInteractiveActivityAt();
    if (lastActivity === 0) return false;
    const [hh] = await this.db
      .select({ s: households.backgroundYieldThresholdSeconds })
      .from(households)
      .limit(1);
    const thresholdMs = (hh?.s ?? 90) * 1000;
    return Date.now() - lastActivity < thresholdMs;
  }

  private async resolveBatchSize(): Promise<number> {
    if (this.batchSize !== undefined) return this.batchSize;
    const [hh] = await this.db
      .select({ s: households.compilationBatchSizePerTick })
      .from(households)
      .limit(1);
    return hh?.s ?? DEFAULT_BATCH;
  }

  private appendDisagreements(
    rolled: Array<{
      slug: string;
      collection: string;
      contradictions: CompilationResponse["contradictions"];
    }>,
  ): void {
    try {
      const dir = join(this.memoryRoot, "household");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "_disagreements.md");
      const ts = new Date().toISOString();
      const blocks: string[] = [`\n## ${ts} compilation pass\n`];
      for (const r of rolled) {
        blocks.push(`### ${r.slug} (${r.collection})\n`);
        for (const c of r.contradictions) {
          blocks.push(`- **${c.topic}** — ${c.a} vs ${c.b}`);
        }
        blocks.push("");
      }
      appendFileSync(path, blocks.join("\n"), "utf-8");
    } catch {
      // best-effort — _disagreements.md write must never crash compile
    }
  }
}

// ── Pure helpers (testable) ──────────────────────────────────────────

/**
 * Split a body into the compiled-view portion (above first `---`) and
 * the timeline portion (below). Returns empty strings when the body
 * has no separator (flat or pre-migration files).
 */
export function splitTwoLayer(body: string): { compiledViewPart: string; timelinePart: string } {
  const idx = body.indexOf("\n---\n");
  if (idx < 0) return { compiledViewPart: "", timelinePart: body };
  return {
    compiledViewPart: body.slice(0, idx).trim(),
    timelinePart: body.slice(idx + 5).trim(),
  };
}

export function buildCompilationPrompt(title: string, entityType: string, atomsText: string): { system: string; user: string } {
  const system = [
    "You are the v5 compilation agent for a family memory system. Your job is to read the append-only TIMELINE of an entity page and regenerate the COMPILED VIEW above it.",
    "",
    "Output STRICT JSON matching:",
    `{"summary":"<one paragraph>","state":"<current status>","open_threads":["..."],"see_also":["..."],"contradictions":[{"topic":"...","a":"...","b":"..."}]}`,
    "",
    "Rules:",
    "- Faithful to atoms. Never add facts that aren't in the timeline.",
    "- Surface contradictions; don't smooth them. If atoms disagree on a predicate (bedtime, address, schedule, role, etc.), include them in `contradictions` with provenance ('Becca says X (2026-04-21 telegram)' vs 'Josh says Y (2026-04-22 telegram)').",
    "- Keep `summary` to one paragraph (3–6 sentences).",
    "- `open_threads` are unresolved commitments / questions. `see_also` are related entity slugs.",
    "- importance: weight high-importance atoms (8+) heavier in your synthesis.",
  ].join("\n");

  const user = [
    `Entity: ${title}`,
    `Type: ${entityType}`,
    "",
    "Timeline of atoms (canonical, append-only):",
    atomsText,
    "",
    "Return JSON only.",
  ].join("\n");

  return { system, user };
}

export function renderCompiledView(title: string, c: CompilationResponse): string {
  const parts: string[] = [`# ${title}`, "", c.summary];

  if (c.state && c.state.trim().length > 0) {
    parts.push("", "## State", "", c.state.trim());
  }
  if (c.open_threads.length > 0) {
    parts.push("", "## Open Threads", "", ...c.open_threads.map((t) => `- ${t}`));
  }
  if (c.see_also.length > 0) {
    parts.push("", "## See Also", "", ...c.see_also.map((s) => `- ${s.startsWith("[[") ? s : `[[${s}]]`}`));
  }
  if (c.contradictions.length > 0) {
    parts.push(
      "",
      "## Contradictions (unresolved)",
      "",
      ...c.contradictions.map((x) => `- **${x.topic}** — ${x.a} vs ${x.b}`),
    );
  }

  return parts.join("\n");
}

function extractJsonBlock(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return JSON.parse(fenced[1]);
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1));
  }
  throw new Error("no JSON object found in compilation response");
}

export const __test = {
  splitTwoLayer,
  buildCompilationPrompt,
  renderCompiledView,
  extractJsonBlock,
  CompilationResponseSchema,
  COMPILABLE_TYPES,
};
