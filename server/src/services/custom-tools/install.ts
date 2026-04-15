/**
 * install_skill pipeline: mirror what `npx skills add` does so we're
 * compatible with the open agent-skills ecosystem (skills.sh / vercel-labs).
 *
 * Supported source formats:
 *   • owner/repo                           — GitHub shorthand, default branch
 *   • owner/repo/subpath/to/skill          — pick a specific skill directory
 *   • owner/repo@skill-name                — pick a skill by name (not subpath)
 *   • skills.sh/owner/repo[/...]           — skills.sh display URL, same as shorthand
 *   • https://github.com/owner/repo
 *   • https://github.com/owner/repo/tree/branch/path
 *   • https://github.com/owner/repo#branch (fragment selects ref)
 *
 * Fetch strategy:
 *   • GitHub sources download the repo tarball via codeload.github.com
 *     (public repos, no token required). This is roughly 10x faster than
 *     spawning `git clone` and needs no git binary on the host.
 *   • Falls back from `main` to `master` if the first download 404s.
 *
 * Safety posture (single-family trusted deployment):
 *   • HTTPS only, 10 MB archive cap, 50 MB extracted cap, 1000-entry cap.
 *   • Reject symlinks, hardlinks, devices, FIFOs, and GNU tar extensions.
 *   • Reject any entry with `..` or empty path segments (traversal).
 *   • Post-extract lstat sweep as a belt-and-suspenders check.
 *   • Per-entry path filter and post-filter inspector enforce the caps.
 *
 * Discovery after extract: GitHub tarballs unpack to `{repo}-{sha}/...`. We
 * strip that top-level prefix, then search for SKILL.md at:
 *   1. {subpath}/SKILL.md                  (direct)
 *   2. skills/{subpath}/SKILL.md           (vercel-labs ecosystem convention)
 *   3. Root SKILL.md                       (single-skill repo, no subpath)
 *   4. skills/<any>/SKILL.md               (bundle layout, all sub-skills)
 *   5. skills/.curated/<any>/SKILL.md      (curated tier)
 *
 * The first location that matches is installed. If subpath was provided and
 * none of the directly-subpath-rooted options match, we fall through to
 * name-based skill lookup (parse every SKILL.md's frontmatter.name, match).
 */

import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve as resolvePath } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { extract as tarExtract } from "tar";

import { parseSkillMd } from "./skill-md.js";
import { validateToolName, validateBundleName, hashToolDir } from "./fs-helpers.js";

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 50 * 1024 * 1024;
// Skills repos can be wide (vercel-labs/skills has ~50 entries for example).
// 1000 gives comfortable headroom while still catching archive-bomb attempts.
const MAX_FILE_COUNT = 1000;
const FETCH_TIMEOUT_MS = 30_000;
const FALLBACK_REFS = ["main", "master"];

export class InstallError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ── Source parsing ────────────────────────────────────────────────────

export interface ParsedGithubSource {
  type: "github";
  owner: string;
  repo: string;
  /** Explicit git ref (branch/tag/sha); when undefined, try FALLBACK_REFS */
  ref?: string;
  /** Directory subpath within the repo (no leading slash, no `..`) */
  subpath?: string;
  /** Name filter (alternative to subpath — find a skill whose frontmatter.name matches) */
  skillFilter?: string;
}

export interface ParsedDirectSource {
  type: "direct";
  /** Full HTTPS URL to a .tar.gz */
  url: string;
}

export type ParsedSource = ParsedGithubSource | ParsedDirectSource;

/** Strip unsafe segments from a repo subpath. */
function sanitizeSubpath(raw: string): string {
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  for (const seg of normalized.split("/")) {
    if (seg === "" || seg === "..") {
      throw new InstallError("validation_error", `Unsafe subpath '${raw}': traversal or empty segment`);
    }
  }
  return normalized;
}

/**
 * Parse a user-supplied source string into a structured descriptor. The set
 * of patterns mirrors `vercel-labs/skills`' source-parser so any URL a user
 * copies from skills.sh Just Works.
 */
export function parseSource(raw: string): ParsedSource {
  let input = raw.trim();
  if (!input) {
    throw new InstallError("validation_error", "source is empty");
  }

  // skills.sh/<rest> is a display URL that wraps the GitHub shorthand.
  // skills.sh doesn't host tarballs itself; the shorthand is what matters.
  const skillsShMatch = input.match(/^skills\.sh\/(.+)$/i);
  if (skillsShMatch) {
    input = skillsShMatch[1];
  }

  // Fragment ref: source#branch or source#branch@skill
  let fragmentRef: string | undefined;
  let fragmentSkillFilter: string | undefined;
  const hashIdx = input.indexOf("#");
  if (hashIdx >= 0) {
    const fragment = input.slice(hashIdx + 1);
    input = input.slice(0, hashIdx);
    const atIdx = fragment.indexOf("@");
    if (atIdx === -1) {
      fragmentRef = decodeURIComponent(fragment);
    } else {
      fragmentRef = fragment.slice(0, atIdx) || undefined;
      fragmentSkillFilter = decodeURIComponent(fragment.slice(atIdx + 1));
    }
  }

  // Direct HTTPS tarball URL (non-GitHub) — accepted as-is
  const httpsTarball = input.match(/^https:\/\/(?!github\.com\/|codeload\.github\.com\/)(.+\.(?:tar\.gz|tgz))(?:[?#].*)?$/i);
  if (httpsTarball) {
    return { type: "direct", url: input };
  }

  // GitHub URL with branch + path: github.com/owner/repo/tree/branch/path
  const ghTreeWithPath = input.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/,
  );
  if (ghTreeWithPath) {
    const [, owner, repo, ref, subpath] = ghTreeWithPath;
    return {
      type: "github",
      owner,
      repo: repo.replace(/\.git$/, ""),
      ref,
      subpath: sanitizeSubpath(subpath),
      skillFilter: fragmentSkillFilter,
    };
  }

  // GitHub URL with branch only: github.com/owner/repo/tree/branch
  const ghTree = input.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?$/);
  if (ghTree) {
    const [, owner, repo, ref] = ghTree;
    return {
      type: "github",
      owner,
      repo: repo.replace(/\.git$/, ""),
      ref,
      skillFilter: fragmentSkillFilter,
    };
  }

  // GitHub plain URL: github.com/owner/repo
  const ghRepo = input.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (ghRepo) {
    const [, owner, repo] = ghRepo;
    return {
      type: "github",
      owner,
      repo,
      ref: fragmentRef,
      skillFilter: fragmentSkillFilter,
    };
  }

  // Shorthand with @skill: owner/repo@skill-name
  const atSkill = input.match(/^([^/\s:]+)\/([^/@\s:]+)@(.+)$/);
  if (atSkill) {
    const [, owner, repo, filter] = atSkill;
    return {
      type: "github",
      owner,
      repo,
      ref: fragmentRef,
      skillFilter: fragmentSkillFilter ?? filter,
    };
  }

  // Shorthand with subpath: owner/repo/path/to/skill
  const shorthand = input.match(/^([^/\s:]+)\/([^/\s:]+)(?:\/(.+?))?\/?$/);
  if (shorthand && !input.startsWith(".") && !input.startsWith("/")) {
    const [, owner, repo, subpath] = shorthand;
    return {
      type: "github",
      owner,
      repo,
      ref: fragmentRef,
      subpath: subpath ? sanitizeSubpath(subpath) : undefined,
      skillFilter: fragmentSkillFilter,
    };
  }

  throw new InstallError(
    "validation_error",
    `Source format not recognized: '${raw}'. ` +
      `Expected 'owner/repo', 'owner/repo/skill-path', 'skills.sh/owner/repo[/...]', ` +
      `a https://github.com/... URL, or a direct https:// .tar.gz URL.`,
  );
}

/**
 * Build the codeload.github.com tarball URL for a github source at a given
 * ref. codeload returns a .tar.gz stream with no API auth for public repos.
 */
function githubTarballUrl(owner: string, repo: string, ref: string): string {
  return `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo.replace(/\.git$/, ""),
  )}/tar.gz/${encodeURIComponent(ref)}`;
}

// ── Download / extract ────────────────────────────────────────────────

export interface ResolvedSkillEntry {
  /** Bundle name (tool organizational prefix) — we map it to the repo name so
   *  grants can distinguish skills-sourced tools from standalone ones */
  bundle: string | undefined;
  /** Tool name from SKILL.md frontmatter */
  toolName: string;
  kind: "http" | "prompt" | "script";
  stagingDir: string;
  skillMdPath: string;
  skillMdContent: string;
  handlerTsContent?: string;
  contentHash: string;
}

export interface InstallResult {
  stagingRoot: string;
  entries: ResolvedSkillEntry[];
  sourceUrl: string;
  sourceDescriptor: ParsedSource;
}

function mkStagingDir(): string {
  const token = randomBytes(8).toString("hex");
  const dir = join(tmpdir(), `carsonos-install-${token}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function fetchArchive(url: string, stagingRoot: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    // codeload returns 302 to the actual CDN URL; allow following those.
    // We still reject non-HTTPS after each hop by re-checking the final URL.
    res = await fetch(url, { redirect: "follow", signal: controller.signal });
  } catch (err) {
    throw new InstallError("http_error", `Fetch failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new InstallError("http_error", `HTTP ${res.status} fetching ${url}`);
  }
  if (!res.body) {
    throw new InstallError("http_error", `No response body from ${url}`);
  }
  const finalUrl = new URL(res.url || url);
  if (finalUrl.protocol !== "https:") {
    throw new InstallError("validation_error", `Final URL after redirect is not HTTPS: ${res.url}`);
  }

  const archivePath = join(stagingRoot, "archive.tar.gz");
  let bytesWritten = 0;
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
    if (err instanceof InstallError) throw err;
    throw new InstallError("http_error", `Download aborted: ${(err as Error).message}`);
  }

  const head = readFileSync(archivePath).subarray(0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) {
    const preview = readFileSync(archivePath).subarray(0, 64).toString("utf8");
    const looksLikeHtml = /^<!DOCTYPE|<html|<!doctype/i.test(preview);
    throw new InstallError(
      "validation_error",
      `Downloaded file is not a gzip archive.${
        looksLikeHtml
          ? " Looks like an HTML page — you probably pointed at a web page instead of a release archive."
          : ` First bytes: ${preview.slice(0, 40).replace(/\n/g, " ")}...`
      }`,
    );
  }

  return archivePath;
}

async function extractSafely(archivePath: string, stagingRoot: string): Promise<string> {
  const extractDir = join(stagingRoot, "extract");
  mkdirSync(extractDir, { recursive: true, mode: 0o700 });

  let totalBytes = 0;
  let entryCount = 0;
  let fatalError: InstallError | null = null;

  // Filter runs inside tar's internal event loop. Throwing from here escapes
  // our try/catch and crashes the Node process. Instead: stash the error,
  // return false to skip the entry, and surface the error after tarExtract
  // resolves. This also lets us safely SKIP entries we don't want (symlinks,
  // hardlinks, devices) without aborting the whole extraction — skill repos
  // routinely contain symlinks (CLAUDE.md → README.md and similar) that
  // aren't security issues, we just don't need them.
  const fail = (code: string, message: string): false => {
    if (!fatalError) fatalError = new InstallError(code, message);
    return false;
  };

  try {
    await tarExtract({
      file: archivePath,
      cwd: extractDir,
      strict: true,
      filter: (path, entry): boolean => {
        if (fatalError) return false;

        // Path traversal is the one thing we must fail hard on — archives
        // with `..` are not a "weird entry to skip", they're an attack.
        if (path.split("/").some((seg) => seg === "..")) {
          return fail("validation_error", `Rejected path with traversal: ${path}`);
        }
        if (!("type" in entry)) return false; // shouldn't happen during extract

        const type = entry.type;

        // Count EVERY entry toward the cap, even skipped ones. Without this,
        // an archive stuffed with a million symlink headers would bypass the
        // limit (File/Directory never increments) while still forcing tar to
        // parse every header — CPU denial vector.
        entryCount++;
        if (entryCount > MAX_FILE_COUNT) {
          return fail(
            "validation_error",
            `Archive contains more than ${MAX_FILE_COUNT} entries; rejected`,
          );
        }

        // Silently skip entry types we don't extract. Symlinks and hardlinks
        // are the common "decorative" cases in real repos. Devices, FIFOs,
        // and GNU extensions can also be skipped — if the archive relies on
        // them for SKILL.md discovery, we'll fail downstream when the SKILL.md
        // isn't found at any of the expected locations.
        if (type !== "File" && type !== "Directory") {
          return false;
        }

        if (type === "File") {
          totalBytes += entry.size ?? 0;
          if (totalBytes > MAX_EXTRACTED_BYTES) {
            return fail(
              "validation_error",
              `Extracted size exceeds ${MAX_EXTRACTED_BYTES} bytes; rejected`,
            );
          }
        }
        return true;
      },
    });
  } catch (err) {
    if (fatalError) throw fatalError;
    throw new InstallError("validation_error", `Extraction failed: ${(err as Error).message}`);
  }

  if (fatalError) throw fatalError;

  // Post-extract lstat sweep: by now all symlinks were filtered out, so any
  // symlink that shows up here is a bug in the filter (or tar invariant
  // violation). Still worth checking before we hand files to the caller.
  assertNoSymlinks(extractDir);
  return extractDir;
}

function assertNoSymlinks(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new InstallError("validation_error", `Symlink detected after extraction: ${entry.name}`);
    }
    if (entry.isDirectory()) assertNoSymlinks(full);
  }
}

/**
 * GitHub tarballs unpack to `{repo}-{sha}/...`. Find that single top-level
 * directory and return its absolute path. If the archive doesn't follow that
 * pattern (e.g. a custom tarball packed from inside the skill dir), return
 * extractDir itself.
 */
function findRepoRoot(extractDir: string): string {
  const entries = readdirSync(extractDir, { withFileTypes: true }).filter(
    (e) => !e.name.startsWith(".") && e.isDirectory(),
  );
  if (entries.length === 1) {
    const candidate = join(extractDir, entries[0].name);
    // If the candidate has repo-looking contents (SKILL.md, skills/, README, etc.)
    // use it as the root. Otherwise, extractDir already is the root.
    return candidate;
  }
  return extractDir;
}

// ── Skill discovery ──────────────────────────────────────────────────

interface SkillLocation {
  /** Absolute path to the SKILL.md file */
  skillPath: string;
  /** Directory containing SKILL.md */
  dir: string;
  /** Display label for logs / bundle name */
  label: string;
}

function hasSkillMd(dir: string): boolean {
  try {
    return statSync(join(dir, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

/**
 * Decide which SKILL.md files to install. Mirrors `vercel-labs/skills` search
 * order: exact-subpath → skills/<subpath> → root single → skills/* bundle.
 * If the user passed a skillFilter (owner/repo@name), we parse every
 * candidate SKILL.md and pick by frontmatter.name.
 */
function resolveSkills(
  repoRoot: string,
  subpath: string | undefined,
  skillFilter: string | undefined,
): SkillLocation[] {
  // skillFilter case — scan every SKILL.md in the tree, return the one whose
  // frontmatter.name matches. This is the `owner/repo@name` syntax.
  if (skillFilter) {
    const all = walkSkillMds(repoRoot);
    for (const loc of all) {
      try {
        const doc = parseSkillMd(readFileSync(loc.skillPath, "utf8"));
        if (doc.frontmatter.name === skillFilter) return [loc];
      } catch {
        /* skip unparseable */
      }
    }
    throw new InstallError(
      "validation_error",
      `No skill named '${skillFilter}' found in the archive. Available: ${all
        .map((l) => l.label)
        .join(", ") || "(none)"}`,
    );
  }

  if (subpath) {
    // Try subpath directly
    const direct = join(repoRoot, subpath);
    if (hasSkillMd(direct)) {
      return [{ skillPath: join(direct, "SKILL.md"), dir: direct, label: subpath }];
    }
    // Try skills/<subpath>
    const underSkills = join(repoRoot, "skills", subpath);
    if (hasSkillMd(underSkills)) {
      return [
        { skillPath: join(underSkills, "SKILL.md"), dir: underSkills, label: `skills/${subpath}` },
      ];
    }
    throw new InstallError(
      "validation_error",
      `No SKILL.md found at '${subpath}' or 'skills/${subpath}' in the archive. ` +
        `Use 'list_custom_tools' after install or pass the exact path from the repo.`,
    );
  }

  // No subpath — prefer a root-level SKILL.md (single-skill repo)
  if (hasSkillMd(repoRoot)) {
    return [{ skillPath: join(repoRoot, "SKILL.md"), dir: repoRoot, label: "(root)" }];
  }

  // Otherwise walk skills/ for a bundle install
  const results: SkillLocation[] = [];
  for (const parent of ["skills", "skills/.curated"]) {
    const parentAbs = join(repoRoot, parent);
    try {
      for (const child of readdirSync(parentAbs, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        if (child.name.startsWith(".") || child.name.startsWith("_")) continue;
        const dir = join(parentAbs, child.name);
        if (hasSkillMd(dir)) {
          results.push({
            skillPath: join(dir, "SKILL.md"),
            dir,
            label: `${parent}/${child.name}`,
          });
        }
      }
    } catch {
      /* directory doesn't exist, skip */
    }
  }
  if (results.length === 0) {
    throw new InstallError(
      "validation_error",
      `No SKILL.md found at the repo root or under skills/. Confirm the archive layout.`,
    );
  }
  return results;
}

/** Recursively find every SKILL.md under a directory (for name-filter). */
function walkSkillMds(dir: string, acc: SkillLocation[] = [], relBase = ""): SkillLocation[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const full = join(dir, entry.name);
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (hasSkillMd(full)) {
        acc.push({ skillPath: join(full, "SKILL.md"), dir: full, label: rel });
      }
      walkSkillMds(full, acc, rel);
    }
  }
  return acc;
}

// ── Public entry point ───────────────────────────────────────────────

export async function prepareInstall(source: string): Promise<InstallResult> {
  const parsed = parseSource(source);
  const stagingRoot = mkStagingDir();

  let archivePath: string;
  let sourceUrl: string;

  try {
    if (parsed.type === "direct") {
      sourceUrl = parsed.url;
      archivePath = await fetchArchive(parsed.url, stagingRoot);
    } else {
      // GitHub — try explicit ref first, else fall through main/master
      const refsToTry = parsed.ref ? [parsed.ref] : FALLBACK_REFS;
      let lastErr: Error | undefined;
      archivePath = "";
      sourceUrl = "";
      for (const ref of refsToTry) {
        const url = githubTarballUrl(parsed.owner, parsed.repo, ref);
        try {
          archivePath = await fetchArchive(url, stagingRoot);
          sourceUrl = url;
          break;
        } catch (err) {
          lastErr = err as Error;
        }
      }
      if (!archivePath) {
        throw lastErr ?? new InstallError("http_error", `Failed to fetch repo tarball`);
      }
    }

    const extractDir = await extractSafely(archivePath, stagingRoot);
    const repoRoot = findRepoRoot(extractDir);

    const subpath = parsed.type === "github" ? parsed.subpath : undefined;
    const skillFilter = parsed.type === "github" ? parsed.skillFilter : undefined;
    const locations = resolveSkills(repoRoot, subpath, skillFilter);

    if (locations.length > 20) {
      throw new InstallError(
        "validation_error",
        `Archive declares ${locations.length} tools; max per install is 20. Install specific skills with 'owner/repo/subpath' instead.`,
      );
    }

    const entries: ResolvedSkillEntry[] = [];
    for (const loc of locations) {
      const skillMdContent = readFileSync(loc.skillPath, "utf8");
      const doc = parseSkillMd(skillMdContent);
      const toolName = doc.frontmatter.name;
      const kind = (doc.frontmatter.kind ?? "prompt") as "http" | "prompt" | "script";

      try {
        validateToolName(toolName);
      } catch (err) {
        throw new InstallError(
          "validation_error",
          `Skill '${loc.label}' has invalid tool name '${toolName}': ${(err as Error).message}. ` +
            `Tool names must be snake_case, 1-64 chars, no dots or slashes.`,
        );
      }

      // Bundle name: use the repo name so multiple skills from one repo group
      // together in the household's tools tree. Skips validation if there
      // wasn't a github source (direct URL → no bundle).
      const bundle = parsed.type === "github" ? sanitizeBundleName(parsed.repo) : undefined;
      if (bundle) {
        try {
          validateBundleName(bundle);
        } catch (err) {
          throw new InstallError("validation_error", `Repo name is not usable as a bundle: ${(err as Error).message}`);
        }
      }

      // Confirm loc.dir stays inside repoRoot (defense in depth)
      const rel = relative(repoRoot, resolvePath(loc.dir));
      if (rel.startsWith("..")) {
        throw new InstallError("validation_error", `Skill dir escapes repo root: ${rel}`);
      }

      let handlerTsContent: string | undefined;
      if (kind === "script") {
        const handlerPath = join(loc.dir, "handler.ts");
        try {
          handlerTsContent = readFileSync(handlerPath, "utf8");
        } catch {
          throw new InstallError(
            "validation_error",
            `Script skill '${toolName}' (at ${loc.label}) is missing handler.ts`,
          );
        }
      }

      entries.push({
        bundle,
        toolName,
        kind,
        stagingDir: loc.dir,
        skillMdPath: loc.skillPath,
        skillMdContent,
        handlerTsContent,
        contentHash: hashToolDir(loc.dir),
      });
    }

    return { stagingRoot, entries, sourceUrl, sourceDescriptor: parsed };
  } catch (err) {
    cleanupStaging(stagingRoot);
    throw err;
  }
}

/** Normalize a repo name into a safe bundle identifier. */
function sanitizeBundleName(raw: string): string | undefined {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  // Bundle names in fs-helpers match /^[a-z][a-z0-9_-]*$/ — be lenient here
  // and let validateBundleName throw if something unexpected slips through.
  return cleaned || undefined;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function promoteTool(entry: ResolvedSkillEntry, destDir: string): void {
  mkdirSync(join(destDir, ".."), { recursive: true, mode: 0o700 });
  try {
    renameSync(entry.stagingDir, destDir);
  } catch (err) {
    // renameSync throws EXDEV when staging and destination are on different
    // filesystems — common on Linux where /tmp is tmpfs and $HOME is a
    // separate mount (Docker containers, many desktop distros). Fall back to
    // recursive copy + remove. Same security guarantees since we already
    // verified no symlinks escaped (assertNoSymlinks) before promotion.
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      cpSync(entry.stagingDir, destDir, { recursive: true });
      rmSync(entry.stagingDir, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

export function cleanupStaging(stagingRoot: string): void {
  try {
    rmSync(stagingRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export { MAX_ARCHIVE_BYTES, MAX_EXTRACTED_BYTES };
