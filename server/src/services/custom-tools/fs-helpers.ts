/**
 * Filesystem helpers for custom tools: atomic writes, path validation,
 * content hashing, tree walking for SKILL.md discovery.
 *
 * All paths are scoped to ~/.carsonos/tools/{householdId}/. The loader and
 * writer validate that no path escapes this root.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

export const TOOLS_ROOT = process.env.CARSONOS_TOOLS_DIR ?? join(homedir(), ".carsonos", "tools");

// ── Path validation ───────────────────────────────────────────────────

// Tool names accept lowercase letters, numbers, underscores, and hyphens.
// Hyphens are necessary for ecosystem compatibility — skills in the broader
// agent-skills world (vercel-labs/skills, skills.sh packages) routinely use
// hyphenated names like 'find-skills' or 'youtube-transcript'. MCP tool
// calls, file paths, and DB columns all handle hyphens fine.
const TOOL_NAME_RE = /^[a-z][a-z0-9_-]*$/;
// Bundle name regex mirrors tool name rules — lowercase-only to avoid silent
// directory collisions on case-insensitive filesystems (HFS+/APFS default,
// Windows). A repo containing both `Foo/bar` and `foo/bar` would otherwise
// race for the same on-disk path.
const BUNDLE_NAME_RE = /^[a-z0-9_-]+$/;
const MAX_NAME_LEN = 64;

export function validateToolName(name: string): void {
  if (!name) throw new PathError("Tool name cannot be empty");
  if (name.length > MAX_NAME_LEN) throw new PathError(`Tool name exceeds ${MAX_NAME_LEN} chars`);
  if (!TOOL_NAME_RE.test(name)) {
    throw new PathError(
      `Tool name '${name}' must start with a lowercase letter, then use lowercase letters, numbers, underscores, or hyphens`,
    );
  }
  if (name === "_shared") throw new PathError("'_shared' is reserved for bundle helper files");
}

export function validateBundleName(bundle: string | undefined): void {
  if (bundle === undefined || bundle === "") return;
  if (bundle.length > MAX_NAME_LEN) throw new PathError(`Bundle name exceeds ${MAX_NAME_LEN} chars`);
  if (!BUNDLE_NAME_RE.test(bundle)) {
    throw new PathError(
      `Bundle name '${bundle}' must contain only letters, numbers, underscores, hyphens`,
    );
  }
  if (bundle.startsWith(".")) throw new PathError("Bundle name cannot start with '.'");
}

/** Build the absolute directory path for a tool, validating against escape. */
export function toolDirPath(householdId: string, bundle: string | undefined, name: string): string {
  validateBundleName(bundle);
  validateToolName(name);
  const parts = [TOOLS_ROOT, householdId];
  if (bundle) parts.push(bundle);
  parts.push(name);
  const full = resolve(join(...parts));
  const root = resolve(TOOLS_ROOT);
  if (!full.startsWith(root + sep) && full !== root) {
    throw new PathError(`Resolved path '${full}' escapes tools root`);
  }
  return full;
}

/** Get the relative path under ~/.carsonos/tools/{householdId}/ for a tool. */
export function toolRelPath(bundle: string | undefined, name: string): string {
  return bundle ? `${bundle}/${name}` : name;
}

export function bundleFromPath(path: string): string | undefined {
  const parts = path.split("/");
  return parts.length > 1 ? parts[0] : undefined;
}

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

// ── Atomic writes ─────────────────────────────────────────────────────

/**
 * Write a file atomically: write to a .tmp sibling, fsync, rename.
 * Rejects symlinks at the target location.
 */
export function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new PathError(`Refusing to overwrite symlink at ${path}`);
    }
  }
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o644 });
  renameSync(tmpPath, path);
}

/** Remove a tool's directory recursively. Refuses to follow symlinks. */
export function removeToolDir(absPath: string): void {
  if (!existsSync(absPath)) return;
  const stat = lstatSync(absPath);
  if (stat.isSymbolicLink()) {
    throw new PathError(`Refusing to remove symlink at ${absPath}`);
  }
  rmSync(absPath, { recursive: true, force: true });
}

/** Ensure the tools root and household dir exist with mode 0700. */
export function ensureToolsDir(householdId: string): string {
  const root = resolve(TOOLS_ROOT);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
  } catch {
    /* ignore */
  }
  const hh = join(root, householdId);
  mkdirSync(hh, { recursive: true, mode: 0o700 });
  try {
    chmodSync(hh, 0o700);
  } catch {
    /* ignore */
  }
  return hh;
}

// ── Content hashing ───────────────────────────────────────────────────

/**
 * Compute SHA-256 over all files in a tool directory, in sorted order.
 * Used for tamper detection. Directories are traversed one level (tool dirs
 * don't have nested subdirs in M1 aside from handlers being siblings of SKILL.md).
 */
export function hashToolDir(absPath: string): string {
  const hash = createHash("sha256");
  const files: string[] = [];
  collectFiles(absPath, files);
  files.sort();
  for (const file of files) {
    const rel = relative(absPath, file);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) {
      throw new PathError(`Refusing to hash symlink at ${file}`);
    }
    const content = readFileSync(file);
    hash.update(rel);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function collectFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // skip symlinks, don't follow
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

// ── Tree walking for SKILL.md discovery ───────────────────────────────

export interface FoundSkill {
  absPath: string; // absolute path to SKILL.md
  bundle: string | undefined; // bundle name if nested one level, else undefined
  toolName: string; // from directory name
}

/** Walk a household's tools directory looking for SKILL.md files. */
export function walkForSkills(householdDir: string): FoundSkill[] {
  if (!existsSync(householdDir)) return [];
  const found: FoundSkill[] = [];

  for (const entry of readdirSync(householdDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "_shared") continue;

    const firstLevel = join(householdDir, entry.name);
    const directSkill = join(firstLevel, "SKILL.md");

    if (existsSync(directSkill) && statSync(directSkill).isFile()) {
      // Tool directly under household root (no bundle)
      found.push({ absPath: directSkill, bundle: undefined, toolName: entry.name });
      continue;
    }

    // Otherwise treat as bundle directory; look one level deeper
    for (const inner of readdirSync(firstLevel, { withFileTypes: true })) {
      if (inner.isSymbolicLink()) continue;
      if (!inner.isDirectory()) continue;
      if (inner.name.startsWith(".") || inner.name === "_shared") continue;

      const skillPath = join(firstLevel, inner.name, "SKILL.md");
      if (existsSync(skillPath) && statSync(skillPath).isFile()) {
        found.push({ absPath: skillPath, bundle: entry.name, toolName: inner.name });
      }
    }
  }
  return found;
}

/** Delete temp (.tmp.*) files left from crashed writes. */
export function cleanupTmpFiles(householdDir: string): void {
  if (!existsSync(householdDir)) return;
  walkAllFiles(householdDir, (file) => {
    if (basename(file).includes(".tmp.")) {
      try {
        unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  });
}

function walkAllFiles(dir: string, fn: (file: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkAllFiles(full, fn);
    else if (entry.isFile()) fn(full);
  }
}
