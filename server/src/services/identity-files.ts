/**
 * Identity files — USER.md per family member and PERSONALITY.md per
 * agent. v0.5.0 moves these off the DB columns (`profile_content`,
 * `soul_content`) and onto disk as editable markdown files. Files are
 * the source of truth; DB columns remain as fallback for one release.
 *
 * Layout:
 *   ${dataDir}/members/{slug}/USER.md
 *   ${dataDir}/agents/{slug}/PERSONALITY.md
 *
 * Slugs are derived from `name` (lowercase, spaces → hyphens, strip non
 * `[a-z0-9-]`) — same rule used elsewhere in the codebase.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { familyMembers, staffAgents } from "@carsonos/db";

/**
 * Slugify a name into a kebab-case identifier suitable for filesystem
 * paths. Lowercase + spaces-to-hyphens + strip non-`[a-z0-9-]` + trim
 * leading/trailing hyphens. The trim is a v0.5.0 polish on the prior
 * boot.ts rule which left ugly artifacts on names with leading/trailing
 * whitespace or punctuation.
 */
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");
}

export function userMdPath(dataDir: string, memberSlug: string): string {
  return join(dataDir, "members", memberSlug, "USER.md");
}

export function personalityMdPath(dataDir: string, agentSlug: string): string {
  return join(dataDir, "agents", agentSlug, "PERSONALITY.md");
}

/**
 * Predicate: does either source supply non-whitespace identity content?
 * v0.5+ stores USER.md / PERSONALITY.md on disk; the DB columns
 * (`profile_content`, `soul_content`) remain as a fallback during the
 * transition window. Either source counts. Used wherever code needs to
 * answer "does this member have a profile?" / "does this agent have a
 * personality?" without baking in assumptions about storage.
 */
export function hasIdentityContent(
  diskContent: string | null | undefined,
  dbContent: string | null | undefined,
): boolean {
  return !!(diskContent?.trim() || dbContent?.trim());
}

/**
 * Read USER.md for a member. Returns null if the file doesn't exist —
 * caller should fall back to the DB column for the one-release back-
 * compat window.
 */
export function loadUserMd(dataDir: string, memberSlug: string): string | null {
  const path = userMdPath(dataDir, memberSlug);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read PERSONALITY.md for an agent. Returns null if the file doesn't
 * exist — caller should fall back to the DB column.
 */
export function loadPersonalityMd(
  dataDir: string,
  agentSlug: string,
): string | null {
  const path = personalityMdPath(dataDir, agentSlug);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Resolve the on-disk slug for a member's identity files.
 * Uses the stable `profileSlug` column when set; falls back to
 * `slugifyName(name)`, and finally to an id-derived slug for names
 * whose slugify collapses to empty (emoji-only, all-stripped, etc.).
 * The id-derived branch is deterministic so the same member always
 * maps to the same path. Callers that write should lazily backfill
 * `profile_slug` so the slug sticks across future renames.
 */
export function getMemberSlug(member: {
  id: string;
  name: string;
  profileSlug?: string | null;
}): string {
  const stable = member.profileSlug?.trim();
  if (stable) return stable;
  const fromName = slugifyName(member.name);
  if (fromName) return fromName;
  // Name doesn't slugify (all-emoji, only stripped chars, etc.) —
  // fall back to a stable id-derived slug. Same rule as the migration
  // backfill in packages/db/src/client.ts so paths stay consistent.
  return `m-${member.id.replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Compute a unique `profile_slug` for a member. Used at every create path
 * (members route POST, onboarding routes) and the lazy-backfill path
 * (profiles route PUT, interview completion) so two same-name members
 * never share a USER.md path.
 *
 * Uniqueness is GLOBAL across `family_members`, not per-household — the
 * disk namespace `${dataDir}/members/{slug}/USER.md` is flat (not
 * household-scoped), so the slug invariant must match the namespace it
 * protects. CarsonOS is single-household today (CONTEXT.md: "the unit of
 * tenancy — a single family"), so this is equivalent in practice, but
 * global scoping removes the latent cross-household collision if a second
 * household is ever created.
 *
 * If the member already has a non-empty `profileSlug`, returns it
 * unchanged (no-op for already-assigned rows). Otherwise computes the
 * name-derived (or id-fallback) base slug, then appends a 4-hex id
 * suffix on collision.
 */
export async function assignUniqueMemberSlug(
  db: Db,
  member: {
    id: string;
    name: string;
    profileSlug?: string | null;
  },
): Promise<string> {
  const existing = member.profileSlug?.trim();
  if (existing) return existing;

  const idHex = member.id.replace(/-/g, "");
  const baseSlug = slugifyName(member.name) || `m-${idHex.slice(0, 12)}`;
  const collision = await db
    .select({ id: familyMembers.id })
    .from(familyMembers)
    .where(eq(familyMembers.profileSlug, baseSlug))
    .limit(1);
  return collision.length > 0 ? `${baseSlug}-${idHex.slice(0, 4)}` : baseSlug;
}

/** Write USER.md atomically (tempfile + rename) so a crash mid-write
 *  can't truncate the canonical file. */
export function writeUserMd(
  dataDir: string,
  memberSlug: string,
  content: string,
): void {
  if (!memberSlug) {
    throw new Error("writeUserMd: memberSlug must be non-empty");
  }
  const dir = join(dataDir, "members", memberSlug);
  mkdirSync(dir, { recursive: true });
  const finalPath = userMdPath(dataDir, memberSlug);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, finalPath);
}

/** Write PERSONALITY.md, creating parent dirs as needed. */
export function writePersonalityMd(
  dataDir: string,
  agentSlug: string,
  content: string,
): void {
  const path = personalityMdPath(dataDir, agentSlug);
  mkdirSync(join(dataDir, "agents", agentSlug), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

/**
 * One-time migration from DB columns to files. Idempotent: skips
 * files that already exist. Skips members/agents whose DB column is
 * empty (no content to migrate). Run from boot after the v0.4 → v5.0
 * memory migration.
 */
export async function migrateIdentityToFiles(
  db: Db,
  dataDir: string,
): Promise<{ usersWritten: number; personalitiesWritten: number }> {
  let usersWritten = 0;
  let personalitiesWritten = 0;

  const members = await db.select().from(familyMembers);
  for (const m of members) {
    if (!m.profileContent || m.profileContent.trim().length === 0) continue;
    // Use getMemberSlug so emoji-only/all-stripped names fall back to the
    // id-derived slug instead of writeUserMd throwing on empty input.
    // Also respects any stable profile_slug already backfilled by the
    // db/client.ts migration so paths stay consistent.
    const slug = getMemberSlug(m);
    if (existsSync(userMdPath(dataDir, slug))) continue;
    writeUserMd(dataDir, slug, m.profileContent);
    usersWritten++;
  }

  const agents = await db.select().from(staffAgents);
  for (const a of agents) {
    if (!a.soulContent || a.soulContent.trim().length === 0) continue;
    const slug = slugifyName(a.name);
    if (existsSync(personalityMdPath(dataDir, slug))) continue;
    writePersonalityMd(dataDir, slug, a.soulContent);
    personalitiesWritten++;
  }

  return { usersWritten, personalitiesWritten };
}
