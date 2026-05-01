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
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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

/** Write USER.md, creating parent dirs as needed. */
export function writeUserMd(
  dataDir: string,
  memberSlug: string,
  content: string,
): void {
  const path = userMdPath(dataDir, memberSlug);
  mkdirSync(join(dataDir, "members", memberSlug), { recursive: true });
  writeFileSync(path, content, "utf-8");
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
    const slug = slugifyName(m.name);
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
