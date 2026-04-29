/**
 * Enrichment worker — Phase 2 of v5 memory.
 *
 * After every agent turn, the (message, reply) pair is queued in the
 * `enrichment_queue` table. This worker runs on the existing scheduler
 * tick (60s cadence): claims a batch, runs each through a Haiku-class
 * LLM via the existing Agent SDK + Claude Max subscription, extracts
 * structured atoms (entity, type, content, importance), validates the
 * shape with Zod, and appends each atom to the relevant entity page's
 * Timeline section with full provenance.
 *
 * Key behaviours:
 *   - Source-of-truth is markdown. Atoms are append-only.
 *   - SHA-256 fingerprint dedup — re-queueing the same payload is a
 *     no-op. (Schema enforces uniqueness.)
 *   - Per-batch lock token. Crashed workers drop their lock on
 *     reclaim.
 *   - Wall-clock budget per tick (default 30s) prevents long batches
 *     from holding the scheduler.
 *   - Atom validation gate (eng-review issue 2A): Zod schema check on
 *     each candidate atom. Failures are logged + skipped — never
 *     written. Raw LLM output captured to `_enrichment-log.md`.
 *   - Quota throttle: when `last_interactive_activity_at` is fresher
 *     than `households.background_yield_threshold_seconds`, the worker
 *     skips its tick. Subscription quota goes to user-facing chat.
 *   - Subscription quota exhaustion: pauses after N consecutive
 *     failures and writes a notice to `_enrichment-log.md`.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { and, eq, isNotNull, lte, or } from "drizzle-orm";
import {
  enrichmentQueue,
  households,
  type Db,
} from "@carsonos/db";
import type { MemoryProvider } from "@carsonos/shared";
import type { Adapter } from "../subprocess-adapter.js";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_BUDGET_MS = 30_000;
const DEFAULT_LOCK_TTL_MS = 60_000;
const MAX_ATTEMPTS = 5;
const QUOTA_FAILURE_THRESHOLD = 3;

/** v5 entity types that get two-layer pages + nightly compilation. */
const ENTITY_TYPES = new Set<string>([
  "person",
  "project",
  "place",
  "media",
  "relationship",
  "commitment",
  "goal",
  "concept",
]);

// ── Activity gate ────────────────────────────────────────────────────

/**
 * Shared timestamp updated by every interactive turn. The worker reads
 * this to decide whether to yield. Module-scoped so any caller can
 * touch it without a service handle.
 */
let lastInteractiveActivityAt = 0;

export function markInteractiveActivity(): void {
  lastInteractiveActivityAt = Date.now();
}

export function getLastInteractiveActivityAt(): number {
  return lastInteractiveActivityAt;
}

// ── Atom shape (Zod gate) ────────────────────────────────────────────

const AtomCandidateSchema = z.object({
  entity_slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case slug only"),
  entity_type: z.enum([
    "fact",
    "preference",
    "event",
    "decision",
    "commitment",
    "person",
    "project",
    "media",
    "place",
    "routine",
    "relationship",
    "goal",
    "skill",
    "concept",
  ]),
  collection: z.string().min(1),
  content: z
    .string()
    .min(1)
    .max(2000)
    .refine((s) => !s.includes("\n---\n"), "atom body must not embed `---` separators"),
  importance: z.number().int().min(1).max(10).optional().default(5),
});

const ExtractionResponseSchema = z.object({
  atoms: z.array(AtomCandidateSchema).max(20),
});

type AtomCandidate = z.infer<typeof AtomCandidateSchema>;

// ── Worker ───────────────────────────────────────────────────────────

export interface EnrichmentTurnPayload {
  channel: "telegram" | "web" | "signal" | string;
  conversationId?: string;
  capturedAt: string; // ISO date
  capturedBy: string; // agent slug
  member: string; // member name (for context)
  /** Latest user message body. */
  userMessage: string;
  /** Agent's reply. */
  agentReply: string;
}

export interface EnrichmentWorkerOptions {
  db: Db;
  memoryProvider: MemoryProvider;
  adapter: Adapter;
  /** Where to write `_enrichment-log.md` files. Typically `${dataDir}/memory`. */
  memoryRoot: string;
  /** Per-tick batch size. Defaults to 10. */
  batchSize?: number;
  /** Wall-clock budget per tick (ms). Default 30s. */
  budgetMs?: number;
  /** Lock TTL (ms). Default 60s. */
  lockTtlMs?: number;
  /** Override the model passed to the adapter. */
  model?: string;
  /** Optional compilation agent — when set, the worker marks an entity dirty
   *  after appending an atom so the next nightly compilation regenerates its view. */
  compilationAgent?: import("./compilation-agent.js").CompilationAgent;
}

export class EnrichmentWorker {
  private db: Db;
  private memoryProvider: MemoryProvider;
  private adapter: Adapter;
  private memoryRoot: string;
  private batchSize: number;
  private budgetMs: number;
  private lockTtlMs: number;
  private model: string;
  private consecutiveFailures = 0;
  /** When set to a future timestamp, the worker is paused until then. Set after quota-exhaustion-style failures. */
  private pausedUntil = 0;
  private compilationAgent: import("./compilation-agent.js").CompilationAgent | null;
  /** Cached list of entity-type files (slug+title+type+collection), refreshed
   *  on a TTL. Passed into the extraction prompt so the LLM can reuse existing
   *  slugs instead of inventing variants for the same logical entity. */
  private entityListCache: Array<{ collection: string; slug: string; type: string; title: string }> = [];
  private entityListCachedAt = 0;

  constructor(opts: EnrichmentWorkerOptions) {
    this.db = opts.db;
    this.memoryProvider = opts.memoryProvider;
    this.adapter = opts.adapter;
    this.memoryRoot = opts.memoryRoot;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    this.lockTtlMs = opts.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    this.model = opts.model ?? "claude-haiku-4-5-20251001";
    this.compilationAgent = opts.compilationAgent ?? null;
  }

  /** Late-bind the compilation agent (boot order: enrichment worker → compilation agent). */
  setCompilationAgent(agent: import("./compilation-agent.js").CompilationAgent): void {
    this.compilationAgent = agent;
  }

  /**
   * Add a turn to the queue. Idempotent via the unique fingerprint
   * index — re-enqueueing the same payload is a no-op.
   */
  async enqueueTurn(args: {
    householdId: string;
    memberId?: string;
    agentId?: string;
    payload: EnrichmentTurnPayload;
  }): Promise<{ queued: boolean }> {
    const fingerprint = fingerprintPayload(args.payload);
    try {
      await this.db.insert(enrichmentQueue).values({
        householdId: args.householdId,
        memberId: args.memberId,
        agentId: args.agentId,
        contentFingerprint: fingerprint,
        payload: args.payload as unknown as Record<string, unknown>,
      });
      return { queued: true };
    } catch (err) {
      // Unique-constraint violation = already enqueued. Silent dedup.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE") || msg.includes("constraint")) {
        return { queued: false };
      }
      throw err;
    }
  }

  /**
   * One scheduler-tick of work. Honours the quota throttle and the
   * paused-until backoff. Returns a small summary for telemetry.
   */
  async tick(): Promise<{ processed: number; failed: number; skipped: "throttled" | "paused" | null }> {
    const now = Date.now();

    if (this.pausedUntil > now) {
      return { processed: 0, failed: 0, skipped: "paused" };
    }

    if (await this.shouldYield()) {
      return { processed: 0, failed: 0, skipped: "throttled" };
    }

    const claimed = await this.claimBatch();
    if (claimed.length === 0) {
      return { processed: 0, failed: 0, skipped: null };
    }

    const deadline = now + this.budgetMs;
    let processed = 0;
    let failed = 0;
    for (const item of claimed) {
      if (Date.now() > deadline) {
        // Release remaining items by clearing their lock so the next
        // tick can pick them up.
        await this.releaseLock(item.id);
        continue;
      }
      try {
        await this.processItem(item);
        await this.markDone(item.id);
        processed++;
        this.consecutiveFailures = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.markFailed(item.id, item.attempts ?? 0, msg);
        failed++;
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= QUOTA_FAILURE_THRESHOLD) {
          this.pause("Subscription quota likely exhausted — see _enrichment-log.md");
          break;
        }
      }
    }

    return { processed, failed, skipped: null };
  }

  /**
   * Existing entity slugs across all collections, refreshed on a 60-second
   * TTL. Disk-walks all entity-type files via the provider's listEntities,
   * so the LLM can be given a list of known slugs to reuse instead of
   * inventing a new one. If the provider doesn't implement listEntities
   * (non-QMD provider), returns an empty list.
   */
  private getCachedEntityList(): Array<{ collection: string; slug: string; type: string; title: string }> {
    const ENTITY_LIST_TTL_MS = 60_000;
    const now = Date.now();
    if (this.entityListCache.length > 0 && now - this.entityListCachedAt < ENTITY_LIST_TTL_MS) {
      return this.entityListCache;
    }
    const provider = this.memoryProvider as unknown as {
      listEntities?: () => Array<{ collection: string; slug: string; type: string; title: string }>;
    };
    this.entityListCache = provider.listEntities?.() ?? [];
    this.entityListCachedAt = now;
    return this.entityListCache;
  }

  /** Has interactive activity been detected within the yield window? */
  private async shouldYield(): Promise<boolean> {
    if (lastInteractiveActivityAt === 0) return false;
    const [hh] = await this.db
      .select({ s: households.backgroundYieldThresholdSeconds })
      .from(households)
      .limit(1);
    const thresholdMs = (hh?.s ?? 90) * 1000;
    return Date.now() - lastInteractiveActivityAt < thresholdMs;
  }

  /**
   * Atomically claim a batch of pending items by setting lock_token +
   * lock_until. Reclaims expired locks from crashed workers.
   */
  private async claimBatch(): Promise<Array<{ id: string; payload: EnrichmentTurnPayload; attempts: number }>> {
    const lockToken = crypto.randomUUID();
    const lockUntil = new Date(Date.now() + this.lockTtlMs);
    const now = new Date();

    // Pick candidate ids: pending OR (claimed AND lock_until < now).
    const candidates = await this.db
      .select({ id: enrichmentQueue.id })
      .from(enrichmentQueue)
      .where(
        and(
          or(
            eq(enrichmentQueue.status, "pending"),
            and(
              eq(enrichmentQueue.status, "claimed"),
              isNotNull(enrichmentQueue.lockUntil),
              lte(enrichmentQueue.lockUntil, now),
            ),
          ),
        ),
      )
      .limit(this.batchSize);

    if (candidates.length === 0) return [];

    // Set the lock on each. (No transactional batch update in Drizzle for
    // SQLite; do it row-by-row but inside a single tick.)
    const claimed: Array<{ id: string; payload: EnrichmentTurnPayload; attempts: number }> = [];
    for (const c of candidates) {
      const result = await this.db
        .update(enrichmentQueue)
        .set({ status: "claimed", lockToken, lockUntil })
        .where(
          and(
            eq(enrichmentQueue.id, c.id),
            // Re-check the gate to avoid claim races.
            or(
              eq(enrichmentQueue.status, "pending"),
              and(
                eq(enrichmentQueue.status, "claimed"),
                isNotNull(enrichmentQueue.lockUntil),
                lte(enrichmentQueue.lockUntil, now),
              ),
            ),
          ),
        )
        .returning({
          id: enrichmentQueue.id,
          payload: enrichmentQueue.payload,
          attempts: enrichmentQueue.attempts,
        });
      if (result.length > 0) {
        claimed.push({
          id: result[0].id,
          payload: result[0].payload as unknown as EnrichmentTurnPayload,
          attempts: result[0].attempts,
        });
      }
    }

    return claimed;
  }

  /**
   * Run one queue item: build the extraction prompt, call the LLM via
   * the adapter, validate the response, append atoms.
   */
  private async processItem(item: { id: string; payload: EnrichmentTurnPayload }): Promise<void> {
    const prompt = buildExtractionPrompt(item.payload, this.getCachedEntityList());
    const result = await this.adapter.execute({
      systemPrompt: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      model: this.model,
      maxTokens: 1500,
    });

    let parsed: { atoms: AtomCandidate[] };
    try {
      const json = extractJsonBlock(result.content);
      parsed = ExtractionResponseSchema.parse(json);
    } catch (err) {
      // Eng-review issue 2A: log raw output, skip the atom — don't write.
      this.logEnrichment(
        item.payload,
        `[validation-fail] ${err instanceof Error ? err.message : String(err)}\n--- raw ---\n${result.content}\n`,
      );
      return;
    }

    const skipped: string[] = [];
    let appended = 0;
    for (const atom of parsed.atoms) {
      try {
        await this.appendAtom(atom, item.payload);
        appended++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        skipped.push(`${atom.entity_slug}: ${msg}`);
      }
    }

    this.logEnrichment(
      item.payload,
      `appended=${appended} skipped=${skipped.length}${skipped.length > 0 ? `\n  ${skipped.join("\n  ")}` : ""}\n`,
    );
  }

  /**
   * Append a candidate atom to its entity page's Timeline. Creates
   * the entity file if it doesn't exist (skeleton with placeholder
   * compiled view + Timeline header + the new atom).
   */
  private async appendAtom(atom: AtomCandidate, source: EnrichmentTurnPayload): Promise<void> {
    // Try the LLM-provided slug first. If that misses, fuzzy-match the
    // collection for typo-style duplicates (e.g., `claire-elisabeth-daws`
    // → existing `2026-04-29-claire-elizabeth-daws`). Catches the
    // dedup gap surfaced 2026-04-29 — different conversations producing
    // multiple files for the same logical entity.
    let existing = await this.memoryProvider.read(atom.collection, atom.entity_slug);
    let resolvedSlug = atom.entity_slug;
    if (!existing) {
      const provider = this.memoryProvider as unknown as {
        findEntityBySimilarSlug?: (col: string, slug: string) => string | null;
      };
      const similar = provider.findEntityBySimilarSlug?.(atom.collection, atom.entity_slug);
      if (similar) {
        existing = await this.memoryProvider.read(atom.collection, similar);
        resolvedSlug = similar;
      }
    }
    const atomBlock = formatAtomBlock(atom, source);
    const isEntity = ENTITY_TYPES.has(atom.entity_type);

    /**
     * `fileId` is the actual on-disk identifier the compilation agent
     * needs to look the file up later. For UPDATES it equals
     * `existing.id`. For SAVES it equals what `qmd-provider.save()`
     * returns — typically `${YYYY-MM-DD}-${slug}` — NOT the bare
     * `atom.entity_slug`. Marking dirty with the bare slug was the
     * 20/20 compilation-agent failure surfaced 2026-04-29.
     */
    let fileId: string;

    if (existing) {
      // Append below the existing body. The qmd-provider's update_memory
      // strips a leading `# heading` from incoming content, so we pass the
      // existing body + appended atom and the storage layer handles the
      // duplicate-heading invariant.
      const newContent = existing.content.replace(/\s*$/, "") + "\n\n" + atomBlock + "\n";
      const updated = await this.memoryProvider.update(atom.collection, resolvedSlug, {
        content: newContent,
        frontmatter: { ...existing.frontmatter, last_atom_added_at: source.capturedAt },
      });
      fileId = updated.id;
    } else {
      // New entity page: skeleton + first atom.
      const body = isEntity
        ? [
            "(Compiled view — provisional. The compilation agent will regenerate this from the atoms below in v5.1. Until then, treat the timeline below as canonical.)",
            "",
            "---",
            "",
            "## Timeline",
            "",
            atomBlock,
          ].join("\n")
        : atomBlock;

      const frontmatter: Record<string, unknown> = {
        source: "enrichment-worker",
        last_atom_added_at: source.capturedAt,
      };
      if (isEntity) frontmatter.aliases = [];

      const saved = await this.memoryProvider.save(atom.collection, {
        type: atom.entity_type as never,
        title: atom.entity_slug.replace(/-/g, " "),
        content: body,
        frontmatter,
      });
      fileId = saved.id;
    }

    // Mark the entity dirty for the next compilation pass using the
    // FILE'S ACTUAL ID (which may include the YYYY-MM-DD prefix added
    // by generateMemoryId). Earlier code used `atom.entity_slug` here,
    // which produced 20 "Entity not found" failures the next time the
    // compilation agent tried to look the file up.
    if (this.compilationAgent && isEntity) {
      try {
        await this.compilationAgent.markDirty(fileId, atom.collection);
      } catch (err) {
        console.warn("[enrichment-worker] markDirty failed (non-fatal):", err);
      }
    }
  }

  private async markDone(id: string): Promise<void> {
    await this.db
      .update(enrichmentQueue)
      .set({
        status: "done",
        lockToken: null,
        lockUntil: null,
        processedAt: new Date(),
      })
      .where(eq(enrichmentQueue.id, id));
  }

  private async markFailed(id: string, prevAttempts: number, error: string): Promise<void> {
    const next = prevAttempts + 1;
    const finalStatus = next >= MAX_ATTEMPTS ? "failed" : "pending";
    await this.db
      .update(enrichmentQueue)
      .set({
        status: finalStatus,
        attempts: next,
        lastError: error.slice(0, 500),
        lockToken: null,
        lockUntil: null,
      })
      .where(eq(enrichmentQueue.id, id));
  }

  private async releaseLock(id: string): Promise<void> {
    await this.db
      .update(enrichmentQueue)
      .set({ status: "pending", lockToken: null, lockUntil: null })
      .where(eq(enrichmentQueue.id, id));
  }

  private pause(reason: string): void {
    // 30-minute backoff after quota-style failures.
    this.pausedUntil = Date.now() + 30 * 60_000;
    const log = `\n[paused] ${new Date().toISOString()} ${reason}\n`;
    try {
      const householdLog = join(this.memoryRoot, "household", "_enrichment-log.md");
      mkdirSync(join(this.memoryRoot, "household"), { recursive: true });
      appendFileSync(householdLog, log, "utf-8");
    } catch {
      // best-effort
    }
    console.warn(`[enrichment-worker] ${reason} — paused for 30m`);
  }

  /**
   * Append a digest line to the per-member `_enrichment-log.md` so
   * parents can audit what the worker did. Best-effort.
   */
  private logEnrichment(payload: EnrichmentTurnPayload, body: string): void {
    try {
      const memberDir = sanitizeSlug(payload.member);
      const logDir = join(this.memoryRoot, memberDir);
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      const ts = new Date().toISOString();
      const entry = `\n### ${ts} (${payload.channel})\n${body}`;
      appendFileSync(join(logDir, "_enrichment-log.md"), entry, "utf-8");
    } catch {
      // best-effort
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function fingerprintPayload(p: EnrichmentTurnPayload): string {
  const canonical = JSON.stringify({
    member: p.member,
    captured_at: p.capturedAt,
    user: p.userMessage,
    reply: p.agentReply,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function sanitizeSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
}

function buildExtractionPrompt(
  payload: EnrichmentTurnPayload,
  existingEntities: Array<{ collection: string; slug: string; type: string; title: string }> = [],
): { system: string; user: string } {
  // Format the existing-entity list as one entry per line, sorted by
  // collection then slug for stability. Capped at 200 entries to keep the
  // prompt under ~5KB even on large families.
  const knownEntitiesBlock = (() => {
    if (existingEntities.length === 0) return "";
    const sorted = [...existingEntities]
      .sort((a, b) => a.collection.localeCompare(b.collection) || a.slug.localeCompare(b.slug))
      .slice(0, 200);
    const lines = sorted.map(
      (e) => `- [${e.collection}] ${e.slug} (${e.type}) — ${e.title}`,
    );
    return [
      "",
      "EXISTING ENTITIES — when an atom is about one of these, REUSE its exact slug + collection. Don't invent a variant (e.g., don't emit `claire` if `claire-elizabeth-daws` is already listed):",
      ...lines,
      "",
      "Only emit a NEW slug if the entity is genuinely not in this list.",
    ].join("\n");
  })();

  const system = [
    "You are an extraction worker for a family memory system. Your job is to read one conversation turn and extract DISCRETE, FACTUAL atoms — entities mentioned, claims about them, dated events, decisions, commitments.",
    "",
    "Output STRICT JSON matching the schema:",
    `{"atoms":[{"entity_slug":"kebab-case","entity_type":"person|project|place|media|relationship|commitment|goal|concept|fact|preference|event|decision|routine|skill","collection":"household|<member-slug>","content":"<one to three sentences>","importance":<1-10>}]}`,
    "",
    "Rules:",
    "- entity_slug: kebab-case ASCII, no slashes/dots/underscores.",
    "- collection: 'household' for facts that affect the family, otherwise the member-slug whose memory it belongs to.",
    "- content: short, faithful to what was said. Never paraphrase loosely. If exact words matter, use them.",
    "- Don't fabricate. If the turn contains no factual atoms (chitchat, greetings, restating known info), return {\"atoms\":[]}.",
    "- importance: 1-3 trivial, 4-6 normal, 7-9 high signal, 10 corrections only.",
    knownEntitiesBlock,
  ].filter(Boolean).join("\n");

  const user = [
    `Member: ${payload.member}`,
    `Captured at: ${payload.capturedAt}`,
    `Channel: ${payload.channel}`,
    "",
    "User said:",
    payload.userMessage,
    "",
    "Agent replied:",
    payload.agentReply,
    "",
    "Return JSON only.",
  ].join("\n");

  return { system, user };
}

/**
 * Pull the first JSON object out of an LLM response that might include
 * code-fence wrappers or surrounding prose.
 */
function extractJsonBlock(text: string): unknown {
  // Try fenced block first.
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return JSON.parse(fenced[1]);
  // Otherwise grab the first { ... } region.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1));
  }
  throw new Error("no JSON object found in LLM response");
}

function formatAtomBlock(atom: AtomCandidate, source: EnrichmentTurnPayload): string {
  return [
    `### ${source.capturedAt} | source: ${source.channel} | by: ${source.capturedBy} | importance: ${atom.importance}`,
    "",
    atom.content,
  ].join("\n");
}

// Re-export for test wiring
export const __test = { fingerprintPayload, ExtractionResponseSchema, AtomCandidateSchema, buildExtractionPrompt, extractJsonBlock };
