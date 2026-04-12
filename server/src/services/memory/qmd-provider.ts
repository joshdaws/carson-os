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

// ── QMD Provider ───────────────────────────────────────────────────

export class QmdMemoryProvider implements MemoryProvider {
  private rootDir: string;
  private collections = new Map<string, string>(); // name → directory path
  private collectionAliases = new Map<string, string>(); // name → existing QMD collection name

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    mkdirSync(rootDir, { recursive: true });
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
    const dir = dirOverride ?? join(this.rootDir, name);
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
      if (dirOverride) {
        const resolvedDir = dirOverride.replace(/\/$/, "");
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

      return {
        entries: results.slice(0, limit).map((r) => ({
          id: extractIdFromFile(r.file),
          title: r.title,
          snippet: cleanSnippet(r.snippet),
          score: r.score,
          file: r.file,
          collection,
        })),
      };
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

    // Build YAML frontmatter
    const fm: Record<string, unknown> = {
      id,
      type: entry.type,
      title: entry.title,
      created: new Date().toISOString().slice(0, 10),
      ...entry.frontmatter,
    };

    const yaml = Object.entries(fm)
      .map(([key, val]) => {
        if (Array.isArray(val)) {
          return `${key}:\n${val.map((v) => `  - ${v}`).join("\n")}`;
        }
        return `${key}: ${val}`;
      })
      .join("\n");

    const fileContent = `---\n${yaml}\n---\n\n# ${entry.title}\n\n${entry.content}\n`;
    writeFileSync(filePath, fileContent, "utf-8");

    // Trigger QMD reindex in the background (don't block on it)
    this.reindex().catch((err) => {
      console.warn("[memory] Background reindex failed:", err);
    });

    return { id, filePath };
  }

  async update(
    collection: string,
    id: string,
    entry: {
      title?: string;
      content?: string;
      frontmatter?: Record<string, unknown>;
    },
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

    const yaml = Object.entries(fm)
      .map(([key, val]) => {
        if (Array.isArray(val)) {
          return `${key}:\n${val.map((v) => `  - ${v}`).join("\n")}`;
        }
        return `${key}: ${val}`;
      })
      .join("\n");

    const fileContent = `---\n${yaml}\n---\n\n# ${title}\n\n${content}\n`;
    writeFileSync(filePath, fileContent, "utf-8");

    // Trigger QMD reindex in the background
    this.reindex().catch((err) => {
      console.warn("[memory] Background reindex failed:", err);
    });

    return { id, filePath };
  }

  /** Find a memory file by ID — checks filename first, then frontmatter. */
  private findMemoryFile(dir: string, id: string): string | null {
    const direct = join(dir, `${id}.md`);
    if (existsSync(direct)) return direct;

    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const content = readFileSync(join(dir, file), "utf-8");
      if (content.includes(`id: ${id}`)) {
        return join(dir, file);
      }
    }
    return null;
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
    unlinkSync(filePath);

    // Trigger QMD reindex in the background
    this.reindex().catch((err) => {
      console.warn("[memory] Background reindex failed:", err);
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

  private async reindex(): Promise<void> {
    try {
      await execFileAsync(QMD_BIN, ["update"], {
        timeout: UPDATE_TIMEOUT_MS,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[memory] QMD reindex error:", msg);
    }
  }
}

// ── Pure helpers ───────────────────────────────────────────────────

function generateMemoryId(title: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${date}-${slug}`;
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

function parseMemoryFile(
  content: string,
  filePath: string,
  collection: string,
): MemoryEntry | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const fmBlock = fmMatch[1];
  const body = fmMatch[2].trim();

  // Simple YAML parsing (good enough for our frontmatter)
  const fm: Record<string, unknown> = {};
  let currentKey = "";
  let currentArray: string[] | null = null;

  for (const line of fmBlock.split("\n")) {
    const arrayItem = line.match(/^\s+-\s+(.+)$/);
    if (arrayItem && currentKey) {
      if (!currentArray) currentArray = [];
      currentArray.push(arrayItem[1]);
      fm[currentKey] = currentArray;
      continue;
    }

    if (currentArray) {
      currentArray = null;
    }

    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      const val = kv[2].trim();
      if (val) {
        fm[currentKey] = val;
      }
      // If val is empty, it might be a list header — wait for array items
      if (!val) {
        currentArray = [];
      }
    }
  }

  // Extract title from first heading or frontmatter
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title =
    (fm.title as string) ?? titleMatch?.[1] ?? basename(filePath, ".md");

  return {
    id: (fm.id as string) ?? basename(filePath, ".md"),
    type: (fm.type as MemoryType) ?? "fact",
    title,
    content: body,
    frontmatter: fm,
    filePath,
    collection,
    createdAt: fm.created as string | undefined,
  };
}
