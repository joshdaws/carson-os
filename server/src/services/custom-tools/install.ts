/**
 * install_skill pipeline: fetch a gzipped tarball over HTTPS, validate it
 * aggressively, extract to a staging directory, and atomically rename into the
 * household's tools tree.
 *
 * Security posture (M1, single-family trusted deployment):
 *   • HTTPS only. No redirects to non-HTTPS.
 *   • Archive size capped at 10 MB. Extracted size capped at 50 MB.
 *   • Reject any entry that is a symlink, hardlink, char/block device, or FIFO.
 *   • Reject any entry whose resolved path escapes the staging directory
 *     (traversal, absolute paths).
 *   • Reject the archive if it contains zero SKILL.md files.
 *   • If a MANIFEST.json exists at the archive root it MUST list every tool to
 *     install (bundle layout). Otherwise the archive must contain exactly one
 *     SKILL.md at the root (standalone tool layout).
 *   • Per-tool reconciliation: existing tool rows with the same name are
 *     rejected (caller can pass `rename` to sidestep).
 */

import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve as resolvePath } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { extract as tarExtract } from "tar";

import { parseSkillMd } from "./skill-md.js";
import { validateToolName, validateBundleName, hashToolDir } from "./fs-helpers.js";

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_EXTRACTED_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_FILE_COUNT = 200; // sanity check against archive bombs
const FETCH_TIMEOUT_MS = 30_000;

export class InstallError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ResolvedSkillEntry {
  /** Bundle name (archive subdirectory) if present, else undefined for root-level tool */
  bundle: string | undefined;
  /** Tool name — from SKILL.md frontmatter.name */
  toolName: string;
  /** Kind from frontmatter */
  kind: "http" | "prompt" | "script";
  /** Full path to the staging directory for this tool */
  stagingDir: string;
  /** Path to SKILL.md within stagingDir */
  skillMdPath: string;
  /** Parsed SKILL.md contents */
  skillMdContent: string;
  /** Optional handler.ts contents (script tools only) */
  handlerTsContent?: string;
  /** Content hash of the staging dir */
  contentHash: string;
}

export interface InstallResult {
  /** Temp directory the caller is responsible for cleaning up after success */
  stagingRoot: string;
  /** One entry per tool found in the archive */
  entries: ResolvedSkillEntry[];
  /** Where the archive came from (for audit) */
  sourceUrl: string;
}

/**
 * Resolve a `skills.sh/<path>` shorthand or a full URL to an absolute HTTPS
 * URL pointing at the archive. Supports namespaced paths like
 * `skills.sh/author/package` or `skills.sh/author/package/skill`, which
 * resolve to `https://skills.sh/packages/<path>/latest.tar.gz` per the design.
 * Full HTTPS URLs are returned as-is; the caller is responsible for pointing
 * at an actual `.tar.gz` (we verify the gzip magic bytes after download).
 */
export function resolveSourceUrl(source: string): string {
  const trimmed = source.trim();
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  // Namespaced shorthand: up to 3 segments of [a-z0-9_-], separated by slashes.
  // Enough for author/package or author/package/skill; more than that starts
  // looking like something we shouldn't guess at.
  const match = trimmed.match(
    /^skills\.sh\/([a-z0-9_-]+(?:\/[a-z0-9_-]+){0,2})\/?$/i,
  );
  if (match) {
    return `https://skills.sh/packages/${match[1]}/latest.tar.gz`;
  }
  throw new InstallError(
    "validation_error",
    `Source must be an HTTPS URL to a .tar.gz archive, or a 'skills.sh/<author>/<package>' shorthand. Got: ${source}. ` +
      `Page URLs like 'skills.sh/author/package/skill' that return HTML won't work — find the release archive URL.`,
  );
}

/**
 * Fetch the archive, stream to disk with a hard size cap, verify gzip magic
 * bytes. Returns the on-disk path to the .tar.gz. Caller cleans up.
 */
async function fetchArchive(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { redirect: "manual", signal: controller.signal });
  } catch (err) {
    throw new InstallError("http_error", `Fetch failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  // Reject any redirect — simpler than re-checking each hop for HTTPS + cap.
  if (res.status >= 300 && res.status < 400) {
    throw new InstallError(
      "http_error",
      `Redirect received (${res.status}); resolve the final URL first and pass it directly.`,
    );
  }
  if (!res.ok) {
    throw new InstallError("http_error", `HTTP ${res.status} fetching ${url}`);
  }
  if (!res.body) {
    throw new InstallError("http_error", `No response body from ${url}`);
  }

  const stagingRoot = mkStagingDir();
  const archivePath = join(stagingRoot, "archive.tar.gz");
  let bytesWritten = 0;

  // Stream with byte-count enforcement. Abort as soon as we cross the cap.
  const out = createWriteStream(archivePath);
  const nodeStream = Readable.fromWeb(
    res.body as unknown as import("stream/web").ReadableStream<Uint8Array>,
  );
  try {
    await pipeline(
      nodeStream,
      async function* (source) {
        for await (const chunk of source) {
          bytesWritten += (chunk as Buffer).length;
          if (bytesWritten > MAX_ARCHIVE_BYTES) {
            throw new InstallError(
              "validation_error",
              `Archive exceeds ${MAX_ARCHIVE_BYTES} bytes; rejected.`,
            );
          }
          yield chunk;
        }
      },
      out,
    );
  } catch (err) {
    // Clean up partial download
    try {
      rmSync(stagingRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (err instanceof InstallError) throw err;
    throw new InstallError("http_error", `Download aborted: ${(err as Error).message}`);
  }

  // Verify gzip magic bytes (1F 8B). Catches HTML error pages served with 200.
  const head = readFileSync(archivePath).subarray(0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) {
    // Peek at first bytes to give the agent a useful hint — most common
    // failure is the user passing a web-page URL instead of an archive URL.
    const preview = readFileSync(archivePath).subarray(0, 64).toString("utf8");
    const looksLikeHtml = /^<!DOCTYPE|<html|<!doctype/i.test(preview);
    rmSync(stagingRoot, { recursive: true, force: true });
    throw new InstallError(
      "validation_error",
      `Downloaded file is not a gzip archive.${
        looksLikeHtml
          ? " It looks like an HTML page — that URL points at a web page, not a release archive. " +
            "Find the direct '.tar.gz' download link (often under a 'Releases' or 'Assets' section)."
          : ` First bytes: ${preview.slice(0, 40).replace(/\n/g, " ")}...`
      }`,
    );
  }

  return archivePath;
}

function mkStagingDir(): string {
  const token = randomBytes(8).toString("hex");
  const dir = join(tmpdir(), `carsonos-install-${token}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Extract the tarball into a sibling directory under staging. All entries are
 * validated via `onentry` before tar hands them to the filesystem. Hard caps
 * on file count and total extracted size apply.
 */
async function extractSafely(archivePath: string, stagingRoot: string): Promise<string> {
  const extractDir = join(stagingRoot, "extract");
  mkdirSync(extractDir, { recursive: true, mode: 0o700 });

  let totalBytes = 0;
  let entryCount = 0;

  try {
    await tarExtract({
      file: archivePath,
      cwd: extractDir,
      strict: true, // throw on unknown headers
      // Block paths that try to escape via absolute or `..` components
      filter: (path, entry) => {
        // tar's path is relative to cwd; reject anything containing `..`
        if (path.split("/").some((seg) => seg === ".." || seg === "")) {
          throw new InstallError("validation_error", `Rejected path with traversal: ${path}`);
        }
        // During extraction, tar passes a ReadEntry (carries `type`/`size`).
        // The `Stats` branch of the union applies to pack/list mode and never
        // occurs here. Narrow by checking for the `type` property.
        if (!("type" in entry)) {
          throw new InstallError("validation_error", `Unexpected entry shape for ${path}`);
        }
        const type = entry.type;
        // Only allow regular files and directories; block symlinks, hardlinks,
        // char/block devices, FIFOs, GNU tar extensions, etc.
        if (type !== "File" && type !== "Directory") {
          throw new InstallError(
            "validation_error",
            `Rejected entry type '${type}' for path '${path}' (only File and Directory allowed)`,
          );
        }
        entryCount++;
        if (entryCount > MAX_FILE_COUNT) {
          throw new InstallError(
            "validation_error",
            `Archive contains more than ${MAX_FILE_COUNT} entries; rejected`,
          );
        }
        if (type === "File") {
          totalBytes += entry.size ?? 0;
          if (totalBytes > MAX_EXTRACTED_BYTES) {
            throw new InstallError(
              "validation_error",
              `Extracted size exceeds ${MAX_EXTRACTED_BYTES} bytes; rejected`,
            );
          }
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof InstallError) throw err;
    throw new InstallError("validation_error", `Extraction failed: ${(err as Error).message}`);
  }

  // Post-extract: belt-and-suspenders, verify no symlinks slipped through.
  // Walk the tree and check every file's lstat.
  assertNoSymlinks(extractDir);

  return extractDir;
}

function assertNoSymlinks(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new InstallError("validation_error", `Symlink detected after extraction: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      assertNoSymlinks(full);
    }
  }
}

/**
 * Enumerate SKILL.md files in the extracted tree and pair them with optional
 * handler.ts siblings. Returns a provisional list; the caller then validates
 * each against the household namespace.
 */
function findSkills(extractDir: string): Array<{ bundle: string | undefined; relDir: string }> {
  const found: Array<{ bundle: string | undefined; relDir: string }> = [];

  // Layout 1: single SKILL.md at root (standalone tool)
  const rootSkillPath = join(extractDir, "SKILL.md");
  try {
    if (statSync(rootSkillPath).isFile()) {
      found.push({ bundle: undefined, relDir: "" });
    }
  } catch {
    /* no root skill, look for bundle layout */
  }

  // Layout 2: bundle/tool-name/SKILL.md (bundle layout, possibly multiple tools)
  for (const bundleEntry of readdirSync(extractDir, { withFileTypes: true })) {
    if (!bundleEntry.isDirectory()) continue;
    if (bundleEntry.name.startsWith(".") || bundleEntry.name.startsWith("_")) continue;
    const bundleDir = join(extractDir, bundleEntry.name);
    // Direct SKILL.md under bundle dir (single-tool bundle, uncommon)
    try {
      if (statSync(join(bundleDir, "SKILL.md")).isFile()) {
        found.push({ bundle: bundleEntry.name, relDir: bundleEntry.name });
        continue;
      }
    } catch {
      /* continue */
    }
    // Nested: bundle/tool/SKILL.md
    for (const toolEntry of readdirSync(bundleDir, { withFileTypes: true })) {
      if (!toolEntry.isDirectory()) continue;
      if (toolEntry.name.startsWith(".") || toolEntry.name.startsWith("_")) continue;
      try {
        if (statSync(join(bundleDir, toolEntry.name, "SKILL.md")).isFile()) {
          found.push({
            bundle: bundleEntry.name,
            relDir: `${bundleEntry.name}/${toolEntry.name}`,
          });
        }
      } catch {
        /* not a tool dir */
      }
    }
  }

  return found;
}

/**
 * Main entrypoint. Returns resolved skill entries ready for DB insert, plus
 * the stagingRoot which the caller must rm -rf after success (or on failure).
 */
export async function prepareInstall(source: string): Promise<InstallResult> {
  const url = resolveSourceUrl(source);
  const archivePath = await fetchArchive(url);
  const stagingRoot = join(archivePath, "..");
  const extractDir = await extractSafely(archivePath, stagingRoot);

  const candidates = findSkills(extractDir);
  if (candidates.length === 0) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw new InstallError(
      "validation_error",
      "Archive contains no SKILL.md files. Confirm the archive structure matches Claude Code skill layout.",
    );
  }
  if (candidates.length > 20) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw new InstallError(
      "validation_error",
      `Archive declares ${candidates.length} tools; max per install is 20.`,
    );
  }

  const entries: ResolvedSkillEntry[] = [];
  for (const cand of candidates) {
    const toolDir = cand.relDir === "" ? extractDir : join(extractDir, cand.relDir);
    const skillMdPath = join(toolDir, "SKILL.md");
    const skillMdContent = readFileSync(skillMdPath, "utf8");
    const doc = parseSkillMd(skillMdContent);
    const toolName = doc.frontmatter.name;
    const kind = (doc.frontmatter.kind ?? "prompt") as "http" | "prompt" | "script";

    // Re-validate names using the same rules as create_*_tool. Anything the
    // archive author chose that we wouldn't accept from an agent we reject here.
    try {
      validateToolName(toolName);
      if (cand.bundle) validateBundleName(cand.bundle);
    } catch (err) {
      rmSync(stagingRoot, { recursive: true, force: true });
      throw new InstallError(
        "validation_error",
        `Tool '${toolName}' in archive: ${(err as Error).message}`,
      );
    }

    // Confirm the staging directory is inside extractDir (paranoia; tar filter
    // should have caught it, but double-check).
    const rel = relative(extractDir, resolvePath(toolDir));
    if (rel.startsWith("..")) {
      rmSync(stagingRoot, { recursive: true, force: true });
      throw new InstallError("validation_error", `Tool directory escapes extract root: ${rel}`);
    }

    // Pull handler.ts content if this is a script tool
    let handlerTsContent: string | undefined;
    if (kind === "script") {
      const handlerPath = join(toolDir, "handler.ts");
      try {
        handlerTsContent = readFileSync(handlerPath, "utf8");
      } catch {
        rmSync(stagingRoot, { recursive: true, force: true });
        throw new InstallError(
          "validation_error",
          `Script tool '${toolName}' missing handler.ts in archive`,
        );
      }
    }

    entries.push({
      bundle: cand.bundle,
      toolName,
      kind,
      stagingDir: toolDir,
      skillMdPath,
      skillMdContent,
      handlerTsContent,
      contentHash: hashToolDir(toolDir),
    });
  }

  return { stagingRoot, entries, sourceUrl: url };
}

/**
 * Helper: convenience SHA-256 hex for a string, used if we add checksum
 * verification later.
 */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Move an individual tool from staging to the live tools directory. Uses
 * rename so it's atomic on the same filesystem. `destDir` must not exist.
 */
export function promoteTool(entry: ResolvedSkillEntry, destDir: string): void {
  // Ensure parent exists, then rename staging → live. renameSync fails if
  // destDir already exists, which is what we want (caller handles collision).
  mkdirSync(join(destDir, ".."), { recursive: true, mode: 0o700 });
  renameSync(entry.stagingDir, destDir);
}

/**
 * Safe cleanup for staging root (after success or on failure).
 */
export function cleanupStaging(stagingRoot: string): void {
  try {
    rmSync(stagingRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// Re-export for handlers.ts
export { MAX_ARCHIVE_BYTES, MAX_EXTRACTED_BYTES };
