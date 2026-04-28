/**
 * Migrate CarsonOS memory from v0.4 (flat typed memories) to v5.0
 * (two-layer entity pages, atoms below `---`, compiled view above).
 *
 * Idempotent. Detects already-migrated files via the `migration_version`
 * frontmatter field (per eng review issue 1.4) — does not rely on `---`
 * heuristics, which would false-trigger on memories that legitimately
 * use `---` as a horizontal rule in body content.
 *
 * Usage:
 *   tsx server/scripts/migrate_v04_to_v50.ts [--data-dir <path>] [--dry-run]
 *   tsx server/scripts/migrate_v04_to_v50.ts --restore-from-backup <tarball> [--data-dir <path>] [--force-version-mismatch]
 *
 * Boot integration: invoked from server/src/index.ts after the
 * pre-migration auto-backup step. See design doc line 135.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { create as tarCreate, extract as tarExtract } from "tar";

const TARGET_VERSION = "5.0";

/** Types that get two-layer pages (compiled view above `---`, atoms below). */
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

const PLACEHOLDER_COMPILED_VIEW = [
  "(Compiled view — provisional. The compilation agent will regenerate this",
  "from the atoms below in v5.1. Until then, treat the timeline below as",
  "canonical.)",
].join("\n");

interface MigrationManifest {
  carsonosVersion: string;
  createdAt: string;
  phase: "pre-v5.0";
  dbFile: string;
  memoryDir: string;
}

interface MigrateOptions {
  dataDir: string;
  /** When set, only walk `${dataDir}/memory/${collection}` instead of every collection. SPIKE step 2 uses this to scope the live test to one family member. */
  collection?: string;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

interface MigrateResult {
  migrated: number;
  skipped: number;
  errors: Array<{ file: string; error: string }>;
  backupPath: string | null;
}

interface ParsedMemoryFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Run the v0.4 → v5.0 migration. Creates a combined DB+memory tarball
 * before touching any memory file, then walks the memory dir
 * recursively and transforms each `.md` file in place.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const memoryRoot = join(options.dataDir, "memory");

  if (!existsSync(memoryRoot)) {
    log(`[migrate-v50] No memory dir at ${memoryRoot} — nothing to migrate.`);
    return { migrated: 0, skipped: 0, errors: [], backupPath: null };
  }

  // Scope the walk: full tree by default, or a single collection when
  // `collection` is set. The pre-migration backup still captures the
  // entire memory dir + DB regardless of scope — restore is all-or-nothing.
  const walkRoot = options.collection
    ? join(memoryRoot, options.collection)
    : memoryRoot;

  if (options.collection && !existsSync(walkRoot)) {
    log(`[migrate-v50] Collection "${options.collection}" not found at ${walkRoot} — nothing to migrate.`);
    return { migrated: 0, skipped: 0, errors: [], backupPath: null };
  }

  // 1. Combined DB+memory backup. Skipped on --dry-run because the
  // backup itself writes to disk.
  let backupPath: string | null = null;
  if (!options.dryRun) {
    backupPath = await createPreV50Backup(options.dataDir, log);
  } else {
    log(`[migrate-v50] --dry-run: skipping backup`);
  }

  // 2. Walk memory dir and migrate each .md file.
  const result: MigrateResult = {
    migrated: 0,
    skipped: 0,
    errors: [],
    backupPath,
  };

  const files = walkMarkdownFiles(walkRoot);
  log(`[migrate-v50] Found ${files.length} markdown file(s) under ${walkRoot}`);

  for (const file of files) {
    try {
      const outcome = migrateFile(file, options.dryRun ?? false);
      if (outcome === "migrated") result.migrated++;
      else result.skipped++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ file, error: msg });
      log(`[migrate-v50] ERROR ${file}: ${msg}`);
    }
  }

  log(
    `[migrate-v50] Done. migrated=${result.migrated} skipped=${result.skipped} errors=${result.errors.length}` +
      (options.dryRun ? " (dry run)" : ""),
  );

  return result;
}

/**
 * Restore a combined DB+memory backup created by createPreV50Backup.
 * Atomic via a `.restore-staging/` dir + rename: a crash mid-restore
 * leaves the staging dir untouched and the live data intact.
 *
 * Validates that the backup was created against the same CarsonOS
 * version unless --force-version-mismatch is passed. Pass
 * `currentVersion` from package.json so this stays accurate per release.
 */
export async function restoreFromBackup(
  tarballPath: string,
  options: {
    dataDir: string;
    currentVersion: string;
    forceVersionMismatch?: boolean;
    log?: (msg: string) => void;
  },
): Promise<void> {
  const log = options.log ?? ((msg: string) => console.log(msg));

  if (!existsSync(tarballPath)) {
    throw new Error(`Backup not found: ${tarballPath}`);
  }

  const stagingDir = join(options.dataDir, ".restore-staging");
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  mkdirSync(stagingDir, { recursive: true });

  log(`[restore-v50] Extracting ${tarballPath} → ${stagingDir}`);
  await tarExtract({ file: tarballPath, cwd: stagingDir });

  const manifestPath = join(stagingDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Backup is missing manifest.json — refusing to restore`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as MigrationManifest;

  if (manifest.carsonosVersion !== options.currentVersion && !options.forceVersionMismatch) {
    throw new Error(
      `Version mismatch: backup is from CarsonOS v${manifest.carsonosVersion}, ` +
        `running v${options.currentVersion}. Pass --force-version-mismatch to override.`,
    );
  }

  // Atomic swap: rename live → .bak, rename staging → live.
  const swapTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const liveMemoryDir = join(options.dataDir, "memory");
  const liveDbPath = join(options.dataDir, "carsonos.db");

  const stagedMemoryDir = join(stagingDir, "memory");
  const stagedDbPath = join(stagingDir, basename(manifest.dbFile));

  if (existsSync(liveMemoryDir)) {
    renameSync(liveMemoryDir, `${liveMemoryDir}.bak.${swapTimestamp}`);
  }
  renameSync(stagedMemoryDir, liveMemoryDir);

  if (existsSync(stagedDbPath)) {
    if (existsSync(liveDbPath)) {
      renameSync(liveDbPath, `${liveDbPath}.bak.${swapTimestamp}`);
    }
    renameSync(stagedDbPath, liveDbPath);
  }

  rmSync(stagingDir, { recursive: true, force: true });
  log(`[restore-v50] Restored from ${tarballPath}. Live state replaced; previous saved with .bak.${swapTimestamp} suffix.`);
}

// ── Backup creation ─────────────────────────────────────────────────

async function createPreV50Backup(
  dataDir: string,
  log: (msg: string) => void,
): Promise<string> {
  const { copyFileSync, cpSync } = await import("node:fs");

  const backupDir = join(dataDir, "backups");
  mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tarballPath = join(backupDir, `pre-v50-${timestamp}.tar.gz`);
  const stageDir = join(backupDir, `.pre-v50-stage-${timestamp}`);

  try {
    mkdirSync(stageDir, { recursive: true });

    const manifest: MigrationManifest = {
      carsonosVersion: getCarsonosVersion(),
      createdAt: new Date().toISOString(),
      phase: "pre-v5.0",
      dbFile: "carsonos.db",
      memoryDir: "memory",
    };
    writeFileSync(join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

    const dbPath = join(dataDir, "carsonos.db");
    if (existsSync(dbPath)) {
      copyFileSync(dbPath, join(stageDir, "carsonos.db"));
    }

    const memoryDir = join(dataDir, "memory");
    if (existsSync(memoryDir)) {
      cpSync(memoryDir, join(stageDir, "memory"), { recursive: true });
    }

    await tarCreate(
      { file: tarballPath, gzip: true, cwd: stageDir },
      readdirSync(stageDir),
    );

    log(`[migrate-v50] Backup created: ${tarballPath}`);
    return tarballPath;
  } finally {
    if (existsSync(stageDir)) {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }
}

// ── Per-file migration ──────────────────────────────────────────────

/**
 * Migrate a single memory file in place. Returns "migrated" if the
 * file was rewritten, "skipped" if it was already at v5.0 or empty.
 */
export function migrateFile(filePath: string, dryRun: boolean): "migrated" | "skipped" {
  const raw = readFileSync(filePath, "utf-8");

  // Empty or zero-byte file — skip with no error.
  if (raw.trim().length === 0) {
    return "skipped";
  }

  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    // No frontmatter at all — this isn't a recognizable v0.4 memory.
    // Skip so we don't corrupt notes that happen to live in the dir.
    return "skipped";
  }

  // Idempotency check: migration_version field. Per eng review 1.4,
  // we do NOT rely on a `---` heuristic — body content can legitimately
  // contain `---` as a horizontal rule.
  if (parsed.frontmatter.migration_version === TARGET_VERSION) {
    return "skipped";
  }

  const type = String(parsed.frontmatter.type ?? "");
  const isEntity = ENTITY_TYPES.has(type);

  // Build new frontmatter: preserve everything (including unknown keys),
  // add migration_version + sensible defaults.
  const newFrontmatter: Record<string, unknown> = {
    ...parsed.frontmatter,
    migration_version: TARGET_VERSION,
  };
  if (isEntity && newFrontmatter.aliases === undefined) {
    newFrontmatter.aliases = [];
  }

  // Build new body.
  const title = String(parsed.frontmatter.title ?? basename(filePath, ".md"));
  const newBody = isEntity
    ? buildTwoLayerBody(title, parsed, newFrontmatter)
    : buildFlatBody(title, parsed.body);

  const newContent = serializeMemoryFile(newFrontmatter, newBody);

  if (dryRun) {
    return "migrated";
  }

  writeFileSync(filePath, newContent, "utf-8");
  return "migrated";
}

function buildTwoLayerBody(
  title: string,
  parsed: ParsedMemoryFile,
  frontmatter: Record<string, unknown>,
): string {
  const created = String(frontmatter.created ?? new Date().toISOString().slice(0, 10));
  const source = String(frontmatter.source ?? "migration-v04");
  const capturedBy = String(frontmatter.captured_by ?? "legacy");

  // Strip the `# title` heading from the body if it leads — we re-add
  // it at the page top. This keeps the migrated atom from having a
  // duplicate heading.
  const bodyWithoutTitleHeading = stripLeadingTitleHeading(parsed.body, title);

  const compiledView = `# ${title}\n\n${PLACEHOLDER_COMPILED_VIEW}`;
  const atomHeader = `### ${created} | source: ${source} | by: ${capturedBy} | importance: 5`;
  const timeline = `## Timeline\n\n${atomHeader}\n\n${bodyWithoutTitleHeading.trim()}`;

  return `${compiledView}\n\n---\n\n${timeline}\n`;
}

function buildFlatBody(title: string, body: string): string {
  // Flat memories keep their existing shape. We just normalize the
  // heading: ensure exactly one `# title` at the top.
  const stripped = stripLeadingTitleHeading(body, title).trim();
  return `# ${title}\n\n${stripped}\n`;
}

function stripLeadingTitleHeading(body: string, title: string): string {
  const lines = body.split("\n");
  // Skip leading blank lines.
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length) {
    const first = lines[i].trim();
    if (first === `# ${title}` || first.startsWith("# ")) {
      // Drop the heading line and one trailing blank if present.
      lines.splice(0, i + 1);
      if (lines[0]?.trim() === "") lines.shift();
      return lines.join("\n");
    }
  }
  return body;
}

// ── Frontmatter parser ──────────────────────────────────────────────

/**
 * Permissive frontmatter parser that mirrors the v0.4 hand-rolled
 * shape in qmd-provider.ts:parseMemoryFile. Handles flat keys + array
 * items. Designed to read what v0.4 produced; the proper gray-matter
 * swap is a separate Phase 1 task and lives in qmd-provider.ts.
 */
function parseFrontmatter(content: string): ParsedMemoryFile | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const fmBlock = match[1];
  const body = match[2];
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

    if (currentArray) currentArray = null;

    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      const val = kv[2].trim();
      if (val) {
        fm[currentKey] = stripQuotes(val);
      } else {
        currentArray = [];
      }
    }
  }

  return { frontmatter: fm, body };
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
    const quote = value[0];
    if (value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}

function serializeMemoryFile(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yaml = serializeFrontmatter(frontmatter);
  const trimmedBody = body.endsWith("\n") ? body : `${body}\n`;
  return `---\n${yaml}\n---\n\n${trimmedBody}`;
}

function serializeFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(fm)) {
    if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of val) lines.push(`  - ${item}`);
      }
    } else if (val === null || val === undefined) {
      // Skip null/undefined to keep the file clean.
      continue;
    } else if (typeof val === "string" && needsQuoting(val)) {
      lines.push(`${key}: ${JSON.stringify(val)}`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  return lines.join("\n");
}

function needsQuoting(value: string): boolean {
  // Quote strings that the simple parser would misread: contains a
  // colon followed by space, leading/trailing whitespace, or starts
  // with a YAML-significant character.
  if (/^\s|\s$/.test(value)) return true;
  if (/:\s/.test(value)) return true;
  if (/^[#&*!|>%@`]/.test(value)) return true;
  if (value === "" || value === "true" || value === "false" || value === "null") return true;
  return false;
}

// ── Filesystem walk ─────────────────────────────────────────────────

function walkMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Skip hidden dirs (.git, .obsidian, .restore-staging, etc).
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        // Skip the household-level RESOLVER.md and any future _-prefixed
        // operational files (e.g., _disagreements.md, _enrichment-log.md
        // in Phase 2). These aren't memory entries.
        if (entry.name.startsWith("_") || entry.name === "RESOLVER.md") continue;
        out.push(full);
      }
    }
  }
  return out;
}

// ── CarsonOS version helper ─────────────────────────────────────────

function getCarsonosVersion(): string {
  // Read the root package.json. Falls back to "unknown" if anything
  // goes wrong — the manifest still records a value for restore-time
  // version-match checks.
  try {
    // Walk up from this file looking for package.json with name carson-os.
    let dir = dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 6; i++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "carson-os") return pkg.version ?? "unknown";
      }
      dir = dirname(dir);
    }
  } catch {
    // Fall through.
  }
  return "unknown";
}

// ── CLI entry point ────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dataDirIdx = args.indexOf("--data-dir");
  const dataDir =
    dataDirIdx >= 0
      ? args[dataDirIdx + 1]
      : process.env.DATA_DIR ?? join(homedir(), ".carsonos");

  const restoreIdx = args.indexOf("--restore-from-backup");
  if (restoreIdx >= 0) {
    const tarballPath = args[restoreIdx + 1];
    if (!tarballPath) {
      console.error("--restore-from-backup requires a tarball path");
      process.exit(2);
    }
    await restoreFromBackup(tarballPath, {
      dataDir,
      currentVersion: getCarsonosVersion(),
      forceVersionMismatch: args.includes("--force-version-mismatch"),
    });
    return;
  }

  const collectionIdx = args.indexOf("--collection");
  const collection =
    collectionIdx >= 0 ? args[collectionIdx + 1] : undefined;

  const result = await migrate({
    dataDir,
    collection,
    dryRun: args.includes("--dry-run"),
  });

  if (result.errors.length > 0) {
    process.exit(1);
  }
}

// Only run main when invoked directly (not when imported by boot or tests).
const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith("migrate_v04_to_v50.ts");
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[migrate-v50] FATAL:", err);
    process.exit(1);
  });
}
