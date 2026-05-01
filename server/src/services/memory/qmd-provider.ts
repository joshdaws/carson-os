/**
 * QMD Memory Provider — default MemoryProvider implementation.
 *
 * Uses QMD CLI for search (subprocess calls) and the filesystem for
 * save/delete (markdown files with YAML frontmatter). Collections are
 * managed via `qmd collection add/remove`.
 *
 * This is the default provider. Swappable via CARSONOS_MEMORY_PROVIDER
 * env var for third-party backends (Mem0, Perplexity, etc).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdirSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import matter from "gray-matter";
import type {
  MemoryProvider,
  MemoryEntry,
  MemorySearchResult,
  MemoryType,
} from "@carsonos/shared";

const execFileAsync = promisify(execFile);

const QMD_BIN = "qmd";
const SEARCH_TIMEOUT_MS = 30_000; // qmd query (hybrid) can take 5-10s
const UPDATE_TIMEOUT_MS = 30_000;

/** v5 entity types that get two-layer pages + nightly compilation. */
const ENTITY_TYPES = new Set<string>([
  "person", "project", "place", "media",
  "relationship", "commitment", "goal", "concept",
]);

/**
 * Expand a leading `~` or `~/` in a path to the user's home directory.
 * Node's fs and path APIs don't do this automatically — it's a shell thing —
 * so stored paths like `~/projects/brain` fail silently by creating a
 * literal `~` directory relative to cwd if we don't expand them first.
 */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

// ── QMD Provider ───────────────────────────────────────────────────

export class QmdMemoryProvider implements MemoryProvider {
  private rootDir: string;
  private collections = new Map<string, string>(); // name → directory path
  private collectionAliases = new Map<string, string>(); // name → existing QMD collection name
  /**
   * Per-file write lock. Concurrent save/update/delete calls targeting
   * the same memory file (e.g., 3 grammy bots in the same Node process
   * appending to a shared entity page) serialize through this map.
   * Different files do not block each other. Eng-review issue 1A,
   * 2026-04-27.
   */
  private fileLocks = new Map<string, Promise<unknown>>();
  /**
   * Optional DB handle. When set, save/update reconcile the
   * memory_links table from `[[wikilink]]` patterns in the body.
   * Optional during the v0.5.0 transition; tests construct providers
   * without a DB.
   */
  private db: import("@carsonos/db").Db | null = null;
  /**
   * Optional compilation agent. When set, save/update on entity-type
   * memories call markDirty so the next compilation tick regenerates
   * the compiled view. Wired late at boot (compilation agent is
   * constructed after the memory provider).
   */
  private compilationAgent: import("./compilation-agent.js").CompilationAgent | null = null;
  /**
   * QMD reindex coalescing. `qmd update` is a subprocess that touches
   * QMD's own SQLite index (~/.cache/qmd/index.sqlite). Concurrent runs —
   * either same-process bursts or cross-process collisions — can produce
   * SQLITE_CONSTRAINT_PRIMARYKEY errors during the per-collection insert
   * loop. The in-process coalescer caps simultaneous runs at one (plus
   * one queued) to eliminate the same-process case.
   *
   * Cross-process races (e.g., user runs `qmd update` manually while the
   * service is also running) are rarer and not addressed here. The error
   * is self-healing: `reindexCollection` iterates the file system fresh
   * each invocation, so a failed run is recovered by the next successful
   * one. Eng diagnosis 2026-05-01: zero duplicate (collection, path)
   * pairs in the live index, zero inactive rows, sqlite_sequence in sync
   * with max(id). The errors observed in stderr.log were transient and
   * did not leave the index in a corrupt state.
   *
   * `reindexErrorCount` is exposed via /api/health so future occurrences
   * are visible without grepping logs.
   */
  private reindexInFlight: Promise<void> | null = null;
  private reindexQueued = false;
  private reindexErrorCount = 0;
  private lastReindexError: { at: string; message: string } | null = null;

  constructor(rootDir: string, db?: import("@carsonos/db").Db) {
    this.rootDir = rootDir;
    this.db = db ?? null;
    mkdirSync(rootDir, { recursive: true });
  }

  /**
   * Late-bind the compilation agent (boot order: memory provider →
   * compilation agent). When set, save/update on entity-type memories
   * fire markDirty so the next compilation tick recompiles them.
   */
  setCompilationAgent(agent: import("./compilation-agent.js").CompilationAgent): void {
    this.compilationAgent = agent;
  }

  /**
   * Run an async operation while holding an exclusive lock on the given
   * file path. Other calls for the same path queue behind it FIFO. Locks
   * for different paths run independently.
   *
   * Errors from earlier holders are swallowed at the lock layer (via
   * `.catch`) so a failed save doesn't poison subsequent waiters. The
   * actual error still propagates to the caller that triggered it.
   *
   * The map grows by one entry per unique file path ever written. For a
   * family with N memories that's O(N) — bounded and small enough that
   * explicit cleanup isn't worth the complexity.
   */
  private async withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.fileLocks.get(filePath) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.fileLocks.set(filePath, next.catch(() => undefined));
    return next;
  }

  /** Resolve a collection name to its QMD collection name (follows aliases). */
  private resolveCollection(name: string): string {
    return this.collectionAliases.get(name) ?? name;
  }

  /**
   * Register a collection. Creates the directory if needed and adds
   * it to QMD's collection index.
   *
   * If dirOverride points to a directory already registered in QMD
   * under a different name, we alias to that existing collection
   * instead of creating a new one (avoids duplicate indexing).
   */
  async ensureCollection(name: string, dirOverride?: string): Promise<void> {
    const expandedOverride = dirOverride ? expandHome(dirOverride) : undefined;
    const dir = expandedOverride ?? join(this.rootDir, name);
    mkdirSync(dir, { recursive: true });

    // Check if QMD already has this directory under a different name
    try {
      const { stdout } = await execFileAsync(QMD_BIN, ["collection", "list"], {
        timeout: SEARCH_TIMEOUT_MS,
      });

      // If our name is already registered, we're done
      if (stdout.includes(`${name} (`)) {
        this.collections.set(name, dir);
        return;
      }

      // If dirOverride is set, check if that directory is already registered
      // under a different collection name. If so, alias to it.
      if (expandedOverride) {
        const resolvedDir = expandedOverride.replace(/\/$/, "");
        // Extract collection names from the list output
        const collectionNames = [...stdout.matchAll(/^(\S+)\s+\(qmd:\/\//gm)].map(m => m[1]);

        for (const existingName of collectionNames) {
          try {
            const { stdout: showOut } = await execFileAsync(
              QMD_BIN,
              ["collection", "show", existingName],
              { timeout: SEARCH_TIMEOUT_MS },
            );
            const pathMatch = showOut.match(/Path:\s+(.+)/);
            if (pathMatch) {
              const existingPath = pathMatch[1].trim().replace(/\/$/, "");
              if (existingPath === resolvedDir) {
                this.collections.set(name, dir);
                this.collectionAliases.set(name, existingName);
                console.log(`[memory] Collection "${name}" → existing QMD collection "${existingName}" at ${dir}`);
                return;
              }
            }
          } catch {
            // Skip this collection if show fails
          }
        }
      }
    } catch {
      // QMD not available or errored — try to add anyway
    }

    this.collections.set(name, dir);

    try {
      await execFileAsync(
        QMD_BIN,
        ["collection", "add", dir, "--name", name],
        { timeout: SEARCH_TIMEOUT_MS },
      );
      console.log(`[memory] QMD collection "${name}" → ${dir}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already")) {
        console.warn(`[memory] Failed to add QMD collection "${name}":`, msg);
      }
    }
  }

  /** Get the directory path for a collection. */
  getCollectionDir(name: string): string | undefined {
    return this.collections.get(name);
  }

  /**
   * Find an existing entity whose slug is fuzzy-similar to `targetSlug`.
   * Strips date prefixes (`YYYY-MM-DD-`) from existing file ids and
   * compares with Levenshtein distance. Returns the actual file id
   * if a sufficiently-similar match exists, else null.
   *
   * Catches typo-style duplicates (claire-elizabeth-daws vs
   * claire-elisabeth-daws) without coalescing logically distinct
   * entities (becca vs betsy stay separate).
   *
   * Threshold: similarity ≥ 0.85 (= 1 - distance/maxLength), with a
   * minimum length of 4 to avoid false matches on tiny slugs.
   */
  findEntityBySimilarSlug(
    collection: string,
    targetSlug: string,
  ): string | null {
    const dir = this.collections.get(collection);
    if (!dir || !existsSync(dir)) return null;
    if (targetSlug.length < 4) return null;

    let bestId: string | null = null;
    let bestSimilarity = 0;

    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[];
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      if (entry.name === "RESOLVER.md") continue;
      const id = entry.name.replace(/\.md$/, "");
      // Exact match — short-circuit.
      if (id === targetSlug) return id;
      const stripped = stripDatePrefix(id);
      if (stripped === targetSlug) return id;
      const dist = levenshtein(stripped, targetSlug);
      const maxLen = Math.max(stripped.length, targetSlug.length);
      const similarity = 1 - dist / maxLen;
      if (similarity >= 0.85 && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestId = id;
      }
    }
    return bestId;
  }

  /**
   * List entity-type files across all registered collections. Used by
   * the enrichment worker to seed the extraction prompt with existing
   * slugs, so the LLM can reuse a known slug instead of inventing a
   * variant for the same logical entity (semantic dedup at extraction
   * time, complementing the post-hoc Levenshtein fallback).
   *
   * Top-level only — entity pages live at the root of each collection.
   * Skips hidden files (`.git/...`), underscore-prefixed (`_enrichment-log.md`),
   * and `RESOLVER.md`. Files with no recognizable entity type are skipped.
   */
  listEntities(): Array<{ collection: string; slug: string; type: string; title: string }> {
    const out: Array<{ collection: string; slug: string; type: string; title: string }> = [];
    for (const [colName, dir] of this.collections.entries()) {
      if (!existsSync(dir)) continue;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[];
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
        if (entry.name === "RESOLVER.md") continue;
        const fullPath = join(dir, entry.name);
        try {
          const raw = readFileSync(fullPath, "utf-8");
          const parsed = parseMemoryFile(raw, fullPath, colName);
          if (!parsed) continue;
          const type = String(parsed.frontmatter.type ?? "");
          if (!ENTITY_TYPES.has(type)) continue;
          out.push({
            collection: colName,
            slug: parsed.id ?? entry.name.replace(/\.md$/, ""),
            type,
            title: parsed.title ?? parsed.id ?? "",
          });
        } catch {
          // Unreadable / malformed — skip.
        }
      }
    }
    return out;
  }

  // ── MemoryProvider interface ─────────────────────────────────────

  async search(
    query: string,
    collection: string,
    limit = 10,
  ): Promise<MemorySearchResult> {
    const qmdCollection = this.resolveCollection(collection);
    try {
      // Use "query" (hybrid search with LLM expansion + reranking) for best results.
      // Falls back to "search" (BM25 keyword) if query fails.
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(
          QMD_BIN,
          ["query", query, "--json", "-c", qmdCollection],
          { timeout: SEARCH_TIMEOUT_MS },
        ));
      } catch {
        // Hybrid query can fail if embeddings aren't ready — fall back to BM25
        ({ stdout } = await execFileAsync(
          QMD_BIN,
          ["search", query, "--json", "-c", qmdCollection],
          { timeout: SEARCH_TIMEOUT_MS },
        ));
      }

      const results = JSON.parse(stdout) as Array<{
        docid: string;
        score: number;
        file: string;
        title: string;
        snippet: string;
      }>;

      const sliced = results.slice(0, limit);
      const entries = sliced.map((r) => ({
        id: extractIdFromFile(r.file),
        title: r.title,
        snippet: cleanSnippet(r.snippet),
        score: r.score,
        file: r.file,
        collection,
      }));

      // Backlink boost: score *= 1 + 0.05 * log(1 + backlink_count). Cheap,
      // bounded, and gives a small lift to highly-connected pages without
      // dominating relevance. Best-effort — skipped silently if db is
      // unavailable. New in v0.5.0.
      if (this.db && entries.length > 0) {
        try {
          const { memoryLinks } = await import("@carsonos/db");
          const { eq, sql } = await import("drizzle-orm");
          for (const e of entries) {
            const [{ cnt }] = await this.db
              .select({ cnt: sql<number>`COUNT(*)` })
              .from(memoryLinks)
              .where(eq(memoryLinks.toSlug, e.id));
            if (cnt > 0) {
              e.score = e.score * (1 + 0.05 * Math.log(1 + cnt));
            }
          }
          // Re-sort after boost so stable ordering reflects the new scores.
          entries.sort((a, b) => b.score - a.score);
        } catch {
          // Silent — boost is non-critical.
        }
      }

      return { entries };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Empty results for missing collections or no matches
      if (msg.includes("no results") || msg.includes("not found")) {
        return { entries: [] };
      }
      console.error(`[memory] Search failed for "${query}" in ${collection}:`, msg);
      return { entries: [] };
    }
  }

  async save(
    collection: string,
    entry: {
      type: MemoryType;
      title: string;
      content: string;
      frontmatter?: Record<string, unknown>;
    },
  ): Promise<{ id: string; filePath: string }> {
    const dir = this.collections.get(collection);
    if (!dir) {
      throw new Error(`Collection "${collection}" not registered`);
    }

    const id = generateMemoryId(entry.title);
    const fileName = `${id}.md`;
    const filePath = join(dir, fileName);

    return this.withFileLock(filePath, async () => {
      // Build YAML frontmatter
      const fm: Record<string, unknown> = {
        id,
        type: entry.type,
        title: entry.title,
        created: new Date().toISOString().slice(0, 10),
        ...entry.frontmatter,
      };

      const yaml = serializeFrontmatterYaml(fm);

      // Strip a leading `# heading` from incoming content. We always emit
      // `# ${title}` ourselves below, so leaving an existing one in place
      // produces a duplicate heading after the first round-trip through
      // save → read → update → save. Surfaced 2026-04-28 via v5 SPIKE.
      const cleanContent = stripLeadingHeading(entry.content);

      const fileContent = `---\n${yaml}\n---\n\n# ${entry.title}\n\n${cleanContent}\n`;
      writeFileSync(filePath, fileContent, "utf-8");

      // Reconcile the [[wikilink]] graph cache. Best-effort — failures
      // don't fail the save.
      if (this.db) {
        const { reconcileMemoryLinks } = await import("./memory-links.js");
        reconcileMemoryLinks(this.db, id, collection, cleanContent).catch((err) => {
          console.warn("[memory-links] reconcile failed on save:", err);
        });
      }

      // Mark the entity dirty for the next compilation tick. Only entity
      // types get compiled views; flat types (fact/preference/etc) don't.
      if (this.compilationAgent && ENTITY_TYPES.has(entry.type as string)) {
        this.compilationAgent.markDirty(id, collection).catch((err) => {
          console.warn("[memory] markDirty failed on save:", err);
        });
      }

      // Trigger QMD reindex in the background (don't block on it)
      this.reindex().catch((err) => {
        console.warn("[memory] Background reindex failed:", err);
      });

      return { id, filePath };
    });
  }

  async update(
    collection: string,
    id: string,
    entry: {
      title?: string;
      content?: string;
      frontmatter?: Record<string, unknown>;
    },
    options?: { triggerCompile?: boolean },
  ): Promise<{ id: string; filePath: string }> {
    const dir = this.collections.get(collection);
    if (!dir) {
      throw new Error(`Collection "${collection}" not registered`);
    }

    // Find the file
    const filePath = this.findMemoryFile(dir, id);
    if (!filePath) {
      throw new Error(`Memory "${id}" not found in collection "${collection}"`);
    }

    return this.withFileLock(filePath, async () => {
      // Read existing file and parse frontmatter
      const existing = readFileSync(filePath, "utf-8");
      const parsed = parseMemoryFile(existing, filePath, collection);
      if (!parsed) {
        throw new Error(`Could not parse memory file: ${filePath}`);
      }

      // Merge updates
      const title = entry.title ?? parsed.title;
      const content = entry.content ?? parsed.content;
      const fm: Record<string, unknown> = {
        ...parsed.frontmatter,
        ...entry.frontmatter,
        id,
        title,
        updated: new Date().toISOString().slice(0, 10),
      };

      const yaml = serializeFrontmatterYaml(fm);

      const cleanContent = stripLeadingHeading(content);
      const fileContent = `---\n${yaml}\n---\n\n# ${title}\n\n${cleanContent}\n`;
      writeFileSync(filePath, fileContent, "utf-8");

      // Reconcile the [[wikilink]] graph cache. Best-effort.
      if (this.db) {
        const { reconcileMemoryLinks } = await import("./memory-links.js");
        reconcileMemoryLinks(this.db, id, collection, cleanContent).catch((err) => {
          console.warn("[memory-links] reconcile failed on update:", err);
        });
      }

      // Mark the entity dirty for the next compilation tick. Skipped when
      // the compilation agent itself is the writer — its compiled-view
      // regeneration shouldn't re-queue the entity (would loop forever).
      const fileType = String(parsed.frontmatter.type ?? "");
      const shouldMarkDirty = options?.triggerCompile !== false;
      if (shouldMarkDirty && this.compilationAgent && ENTITY_TYPES.has(fileType)) {
        this.compilationAgent.markDirty(id, collection).catch((err) => {
          console.warn("[memory] markDirty failed on update:", err);
        });
      }

      // Trigger QMD reindex in the background
      this.reindex().catch((err) => {
        console.warn("[memory] Background reindex failed:", err);
      });

      return { id, filePath };
    });
  }

  /**
   * Find a memory file by ID — checks filename first, then frontmatter.
   * Walks the directory recursively so both flat collections (written by
   * save()) and nested brain-style collections (knowledge/year/foo.md) work.
   */
  private findMemoryFile(dir: string, id: string): string | null {
    const direct = join(dir, `${id}.md`);
    if (existsSync(direct)) return direct;

    // Recursive walk. Skip hidden directories (.git, .obsidian) — they
    // can contain thousands of files and never hold memories.
    const walk = (current: string): string | null => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" }) as import("node:fs").Dirent[];
      } catch {
        return null;
      }
      for (const entry of entries) {
        const name = entry.name;
        if (name.startsWith(".")) continue;
        const full = join(current, name);
        if (entry.isDirectory()) {
          const found = walk(full);
          if (found) return found;
          continue;
        }
        if (!name.endsWith(".md")) continue;
        if (name === `${id}.md`) return full;
        try {
          const content = readFileSync(full, "utf-8");
          if (content.includes(`id: ${id}`)) return full;
        } catch {
          // Skip unreadable files
        }
      }
      return null;
    };

    return walk(dir);
  }

  async read(
    collection: string,
    id: string,
  ): Promise<{ id: string; title: string; content: string; frontmatter: Record<string, unknown>; filePath: string } | null> {
    const dir = this.collections.get(collection);
    if (!dir) return null;

    const filePath = this.findMemoryFile(dir, id);
    if (!filePath) return null;

    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseMemoryFile(raw, filePath, collection);
    return {
      id: parsed?.id ?? id,
      title: parsed?.title ?? id,
      content: parsed?.content ?? raw,
      frontmatter: parsed?.frontmatter ?? {},
      filePath,
    };
  }

  async delete(collection: string, id: string): Promise<void> {
    const dir = this.collections.get(collection);
    if (!dir) {
      throw new Error(`Collection "${collection}" not registered`);
    }

    const filePath = this.findMemoryFile(dir, id);
    if (!filePath) {
      throw new Error(`Memory "${id}" not found in collection "${collection}"`);
    }

    await this.withFileLock(filePath, async () => {
      unlinkSync(filePath);

      // Trigger QMD reindex in the background
      this.reindex().catch((err) => {
        console.warn("[memory] Background reindex failed:", err);
      });
    });
  }

  async list(collection: string, limit = 20): Promise<MemoryEntry[]> {
    const dir = this.collections.get(collection);
    if (!dir || !existsSync(dir)) {
      return [];
    }

    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .slice(0, limit);

    const entries: MemoryEntry[] = [];
    for (const file of files) {
      const filePath = join(dir, file);
      const content = readFileSync(filePath, "utf-8");
      const parsed = parseMemoryFile(content, filePath, collection);
      if (parsed) entries.push(parsed);
    }

    return entries;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /**
   * Trigger a QMD reindex. Coalesces concurrent calls: at most one
   * in-flight subprocess, plus at most one queued follow-up if more
   * requests come in while it runs. All callers awaiting `reindex()`
   * during an in-flight run get the same promise. This fixes
   * SQLITE_CONSTRAINT_PRIMARYKEY collisions when many save/update
   * calls fire in a burst.
   */
  private reindex(): Promise<void> {
    if (this.reindexInFlight) {
      this.reindexQueued = true;
      return this.reindexInFlight;
    }
    this.reindexInFlight = this.runReindex();
    return this.reindexInFlight;
  }

  /**
   * Snapshot of the reindex subprocess health. Read by the /api/health
   * route so the user sees "QMD reindex has failed N times" instead of
   * having to grep stderr.log to find out something was off.
   *
   * `errorCount` increments per failed `qmd update` invocation. The error
   * is self-healing — the next successful run re-iterates the file system
   * and recovers anything missed — but a non-zero count is a signal worth
   * investigating, particularly if it's growing over time.
   */
  getReindexHealth(): {
    errorCount: number;
    lastError: { at: string; message: string } | null;
  } {
    return {
      errorCount: this.reindexErrorCount,
      lastError: this.lastReindexError,
    };
  }

  private async runReindex(): Promise<void> {
    try {
      await execFileAsync(QMD_BIN, ["update"], {
        timeout: UPDATE_TIMEOUT_MS,
      });
    } catch (err) {
      const detailed = formatReindexError(err);
      this.reindexErrorCount += 1;
      this.lastReindexError = { at: new Date().toISOString(), message: detailed };
      console.warn(
        `[memory] QMD reindex error (count=${this.reindexErrorCount}):`,
        detailed,
      );
    }
    this.reindexInFlight = null;
    if (this.reindexQueued) {
      this.reindexQueued = false;
      // Fire-and-forget the queued run. Errors caught inside runReindex.
      // This is also the self-heal path: a transient subprocess failure
      // is recovered by the next successful invocation, since `qmd update`
      // re-iterates the file system on every run.
      void this.reindex();
    }
  }
}

// ── Pure helpers ───────────────────────────────────────────────────

/**
 * Format a thrown error from `execFileAsync(qmd, update)` into a single
 * detailed line that includes the qmd subprocess's stderr trace, when
 * present. The qmd CLI writes the full SQLite error stack (including
 * SQLITE_CONSTRAINT_PRIMARYKEY context — which collection, which file
 * triggered it) to stderr, and `child_process` exposes that as `err.stderr`.
 *
 * Without this, runReindex used to log just the top-level message
 * ("Command failed: qmd update"), making post-hoc debugging impossible.
 *
 * Pure function so tests can pin the format without spawning subprocesses.
 */
export function formatReindexError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const stderr = (err as { stderr?: Buffer | string } | undefined)?.stderr;
  const stderrText =
    typeof stderr === "string"
      ? stderr
      : Buffer.isBuffer(stderr)
        ? stderr.toString("utf8")
        : "";
  return stderrText.trim()
    ? `${msg}\n--- qmd stderr ---\n${stderrText.trim()}`
    : msg;
}

/**
 * Strip a single leading `# heading` line from a body, plus any blank
 * lines that follow. Used by save/update to prevent duplicate `# title`
 * lines: we always emit `# ${title}` ourselves, so any leading heading
 * in the incoming content (typically left over from the previous save's
 * own emission) must be removed first.
 */
export function stripLeadingHeading(body: string): string {
  return body.replace(/^\s*#\s+[^\n]*\n+/, "");
}

/** Strip the `YYYY-MM-DD-` date prefix from a memory id, if present. */
export function stripDatePrefix(id: string): string {
  return id.replace(/^\d{4}-\d{2}-\d{2}-/, "");
}

/**
 * Levenshtein distance between two strings. Used to detect typo-style
 * entity-slug duplicates in `findEntityBySimilarSlug`. Iterative DP,
 * O(m*n) time and O(min(m,n)) memory.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Ensure b is the shorter — keeps memory smaller.
  if (a.length < b.length) [a, b] = [b, a];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,       // insertion
        prev[j] + 1,           // deletion
        prev[j - 1] + cost,    // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Serialize a frontmatter object to YAML lines. Skips entries whose
 * value is `null` or `undefined` so they don't end up as the literal
 * string "undefined" or "null" in the file. Surfaced 2026-04-28 via
 * v5 SPIKE: enrichment worker passing `aliases: undefined` for non-
 * entity types produced 35 broken files in the brain.
 */
export function serializeFrontmatterYaml(fm: Record<string, unknown>): string {
  // gray-matter parses YAML date strings into Date objects on read. If a
  // caller round-trips frontmatter (read → modify → write), `${val}`
  // would call Date.toString() and emit `Tue Apr 28 2026 20:00:00 GMT-0400`,
  // which is not valid YAML and corrupts the file. Coerce Dates back to
  // ISO date strings (YYYY-MM-DD) before formatting.
  const formatScalar = (val: unknown): string => {
    if (val instanceof Date) return val.toISOString().slice(0, 10);
    return String(val);
  };
  return Object.entries(fm)
    .filter(([, val]) => val !== undefined && val !== null)
    .map(([key, val]) => {
      if (Array.isArray(val)) {
        if (val.length === 0) return `${key}: []`;
        return `${key}:\n${val.map((v) => `  - ${formatScalar(v)}`).join("\n")}`;
      }
      return `${key}: ${formatScalar(val)}`;
    })
    .join("\n");
}

function generateMemoryId(title: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  // Defensive: if the title already starts with a YYYY-MM-DD date (the LLM
  // emitting a slug it copied from the existing-entities list), strip it so
  // we don't double-prefix the file id (`2026-04-29-2026-04-29-claire`).
  const stripped = slug.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  return `${date}-${stripped}`;
}

function extractIdFromFile(qmdFile: string): string {
  // qmd://collection/path/to/file.md → file (without .md)
  const parts = qmdFile.split("/");
  const last = parts[parts.length - 1];
  return last.replace(/\.md$/, "");
}

function cleanSnippet(snippet: string): string {
  // Strip @@ line markers and leading frontmatter
  return snippet
    .replace(/@@\s*-?\d+,?\d*\s*@@.*$/m, "")
    .replace(/^\(\d+ before, \d+ after\)\n?/, "")
    .replace(/^---[\s\S]*?---\n*/, "")
    .trim()
    .slice(0, 500);
}

/**
 * Parse a memory file into its structured pieces. Backed by `gray-matter`
 * since v0.5.0 — handles multi-line strings, nested arrays, escaped
 * characters, and the variety of YAML shapes the v0.4 hand-rolled parser
 * couldn't. Returns null when the file has no frontmatter (so non-memory
 * markdown notes living in the dir are skipped, not corrupted).
 */
function parseMemoryFile(
  content: string,
  filePath: string,
  collection: string,
): MemoryEntry | null {
  // Skip files that don't begin with a frontmatter fence — we don't want
  // to rewrite arbitrary markdown notes that happen to live in the dir.
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return null;
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch {
    return null;
  }

  const fm = parsed.data as Record<string, unknown>;
  const body = parsed.content.trim();

  // Extract title: prefer frontmatter, then first heading, then filename.
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title =
    (typeof fm.title === "string" ? fm.title : undefined) ??
    titleMatch?.[1] ??
    basename(filePath, ".md");

  return {
    id: (typeof fm.id === "string" ? fm.id : undefined) ?? basename(filePath, ".md"),
    type: ((fm.type as MemoryType) ?? "fact") as MemoryType,
    title,
    content: body,
    frontmatter: fm,
    filePath,
    collection,
    createdAt: typeof fm.created === "string" ? fm.created : undefined,
  };
}
