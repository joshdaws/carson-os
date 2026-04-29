/**
 * Migrate CarsonOS memory from v0.4 (flat typed memories) to v5.0
 * (two-layer entity pages, atoms below `---`, compiled view above).
 *
 * Idempotent. Detects already-migrated files via the `migration_version`
 * frontmatter field (per eng review issue 1.4) — does not rely on `---`
 * heuristics, which would false-trigger on memories that legitimately
 * use `---` as a horizontal rule in body content.
 *
 * Usage as CLI:
 *   tsx server/src/services/memory/migrate-v04-to-v50.ts [--data-dir <path>] [--memory-dir <path>] [--collection <name>] [--dry-run]
 *   tsx server/src/services/memory/migrate-v04-to-v50.ts --restore-from-backup <tarball> [--data-dir <path>] [--memory-dir <path>] [--force-version-mismatch]
 *
 * Boot integration: imported from server/src/index.ts and invoked after
 * the pre-migration auto-backup step. Idempotent on subsequent boots.
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

const TARGET_VERSION = "0.5";
/**
 * Legacy migration_version values that should be treated as
 * already-current. Earlier builds wrote `5.0` (string) or `5` (number,
 * after gray-matter parsing) into frontmatter. Files with those values
 * are in v0.5 shape — don't re-migrate them.
 */
const LEGACY_VERSIONS = new Set<number>([5, 5.0, 0.5]);

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

/**
 * Folds gbrain-style and other external type vocabularies into v5's 14
 * canonical types. The original type name is preserved as a `topics`
 * entry so search/filter by the old name still works.
 *
 * Rationale: many external brains (gbrain, Obsidian-style vaults) use
 * operational distinctions (`session` vs `meeting` vs `transcript`) or
 * fine-grained semantic tags (`insight` vs `map` vs `concept`) that
 * collapse cleanly into v5's coarser type system. Keeping 14 types
 * preserves agent classification accuracy; preserving the old type name
 * as a topic preserves filter precision. SPIKE finding 2026-04-28.
 */
const TYPE_TRANSLATIONS: Record<string, { to: string; topic: string }> = {
  contact: { to: "person", topic: "contact" },
  meeting: { to: "event", topic: "meeting" },
  session: { to: "event", topic: "session" },
  transcript: { to: "event", topic: "transcript" },
  insight: { to: "concept", topic: "insight" },
  map: { to: "concept", topic: "map" },
  reference: { to: "media", topic: "reference" },
  content: { to: "media", topic: "content" },
};

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
  /** Absolute path the memory dir lived at when the backup was taken. Set when `memoryDir` was overridden via CARSONOS_MEMORY_DIR or --memory-dir. Used by restore to put the dir back where it came from. */
  memoryDirAbsPath?: string;
}

interface MigrateOptions {
  dataDir: string;
  /** Absolute path to the memory root to walk. Defaults to `${dataDir}/memory`. Set this when CARSONOS_MEMORY_DIR is overridden (e.g., gbrain-style brains living at `~/projects/brain`). */
  memoryDir?: string;
  /** When set, only walk `${memoryDir}/${collection}` instead of every collection. SPIKE step 2 uses this to scope the live test to one family member. */
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
  const memoryRoot = options.memoryDir ?? join(options.dataDir, "memory");
  const memoryRootIsExternal = options.memoryDir !== undefined;

  if (!existsSync(memoryRoot)) {
    log(`[migrate-v50] No memory dir at ${memoryRoot} — nothing to migrate.`);
    return { migrated: 0, skipped: 0, errors: [], backupPath: null };
  }

  // Scope the walk: full tree by default, or a single collection when
  // `collection` is set. The pre-migration backup still captures the
  // entire memory root + DB regardless of scope — restore is all-or-nothing.
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
    backupPath = await createPreV50Backup(
      options.dataDir,
      memoryRootIsExternal ? memoryRoot : undefined,
      log,
    );
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
    /** Override the memory dir destination. If omitted, uses the path stored in the backup's manifest (memoryDirAbsPath if external, else `${dataDir}/memory`). */
    memoryDir?: string;
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
  const liveMemoryDir =
    options.memoryDir ?? manifest.memoryDirAbsPath ?? join(options.dataDir, "memory");
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
  log(`[restore-v50] Restored from ${tarballPath}. Memory at ${liveMemoryDir}; previous saved with .bak.${swapTimestamp} suffix.`);
}

// ── Backup creation ─────────────────────────────────────────────────

async function createPreV50Backup(
  dataDir: string,
  externalMemoryDir: string | undefined,
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
      memoryDirAbsPath: externalMemoryDir,
    };
    writeFileSync(join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

    const dbPath = join(dataDir, "carsonos.db");
    if (existsSync(dbPath)) {
      copyFileSync(dbPath, join(stageDir, "carsonos.db"));
    }

    const memorySource = externalMemoryDir ?? join(dataDir, "memory");
    if (existsSync(memorySource)) {
      cpSync(memorySource, join(stageDir, "memory"), { recursive: true });
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
 *
 * A file at `migration_version: 5.0` is normally skipped, but is
 * re-migrated when its `type` matches the TYPE_TRANSLATIONS table —
 * that way an earlier conservative pass can be revisited as the
 * translation rules expand.
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

  const originalType = String(parsed.frontmatter.type ?? "");
  const translation = TYPE_TRANSLATIONS[originalType];
  /**
   * Match either string `"5.0"` or numeric `5` / `5.0` — gray-matter
   * round-trips an unquoted YAML `5.0` value as the JS number `5`,
   * which fails strict-string equality and caused every entity file
   * to be re-wrapped on every boot (surfaced 2026-04-29 via the Claire
   * spelling correction; ~15 files doubly-wrapped before fix).
   */
  const verRaw = parsed.frontmatter.migration_version;
  const verNum = verRaw === undefined || verRaw === null ? NaN : Number(verRaw);
  const alreadyAtTarget = !Number.isNaN(verNum) && LEGACY_VERSIONS.has(verNum);

  // Idempotency: skip if already at target AND type doesn't need translation.
  // Per eng review 1.4, we do NOT rely on a `---` heuristic — body content
  // can legitimately contain `---` as a horizontal rule.
  if (alreadyAtTarget && !translation) {
    return "skipped";
  }

  // Apply type translation if applicable: rewrite the type and add the
  // original name as a topic for filter preservation.
  const finalType = translation ? translation.to : originalType;
  const isEntity = ENTITY_TYPES.has(finalType);

  // Build new frontmatter: preserve everything (including unknown keys),
  // apply translation if any, add migration_version + sensible defaults.
  const newFrontmatter: Record<string, unknown> = {
    ...parsed.frontmatter,
    type: finalType,
    migration_version: TARGET_VERSION,
  };

  if (translation) {
    const existingTopics = Array.isArray(parsed.frontmatter.topics)
      ? (parsed.frontmatter.topics as string[])
      : typeof parsed.frontmatter.topics === "string"
        ? [parsed.frontmatter.topics as string]
        : [];
    if (!existingTopics.includes(translation.topic)) {
      newFrontmatter.topics = [...existingTopics, translation.topic];
    }
  }

  if (isEntity && newFrontmatter.aliases === undefined) {
    newFrontmatter.aliases = [];
  }

  // Build new body. If the file is already at target (re-migrating for
  // type translation only), preserve the existing body shape — don't
  // rebuild the two-layer split, since that would re-wrap an already-
  // wrapped page. Translation alone is a frontmatter change.
  const title = String(parsed.frontmatter.title ?? basename(filePath, ".md"));
  let newBody: string;
  if (alreadyAtTarget) {
    newBody = parsed.body.trim() + "\n";
  } else if (isEntity) {
    newBody = buildTwoLayerBody(title, parsed, newFrontmatter);
  } else {
    newBody = buildFlatBody(title, parsed.body);
  }

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

  const memoryDirIdx = args.indexOf("--memory-dir");
  const memoryDir =
    memoryDirIdx >= 0
      ? args[memoryDirIdx + 1]
      : process.env.CARSONOS_MEMORY_DIR;

  const restoreIdx = args.indexOf("--restore-from-backup");
  if (restoreIdx >= 0) {
    const tarballPath = args[restoreIdx + 1];
    if (!tarballPath) {
      console.error("--restore-from-backup requires a tarball path");
      process.exit(2);
    }
    await restoreFromBackup(tarballPath, {
      dataDir,
      memoryDir,
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
    memoryDir,
    collection,
    dryRun: args.includes("--dry-run"),
  });

  if (result.errors.length > 0) {
    process.exit(1);
  }
}

// Only run main when invoked directly (not when imported by boot or tests).
const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith("migrate-v04-to-v50.ts");
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[migrate-v50] FATAL:", err);
    process.exit(1);
  });
}
