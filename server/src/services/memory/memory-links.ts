/**
 * Wikilinks parser + memory_links reconciliation.
 *
 * Memories can reference other memories via `[[slug]]` or
 * `[[slug|display]]` syntax (Obsidian-compatible). On save/update, the
 * body is parsed and the memory_links table is reconciled: new links
 * are inserted, removed links are deleted. Reconciliation is source-
 * scoped — only `source='markdown'` rows are touched, so any
 * manually-added links (`source='manual'`) survive.
 *
 * Slug grammar: kebab-case ASCII lowercase + digits + hyphens. Slugs
 * containing `/`, `\`, or `.` are rejected as malformed (a parse warning
 * is logged) per the design doc's slug-grammar rule. Underscores are
 * tolerated and normalized to hyphens so that agents emitting
 * `[[user_josh]]` still resolve to the canonical `user-josh` entity.
 */

import type { Db } from "@carsonos/db";
import { memoryLinks } from "@carsonos/db";
import { and, eq } from "drizzle-orm";

const WIKILINK_PATTERN = /\[\[([^\[\]\n]+?)\]\]/g;
const SLUG_FORBIDDEN = /[\/\\.]/;

export interface ParsedLink {
  /** Canonical kebab-case slug (underscores normalized to hyphens). */
  slug: string;
  /**
   * Slug as it appeared in the body (may contain underscores). Used by
   * `inferLinkType` to locate the wikilink in the original text — the
   * normalized slug won't match the raw `[[user_josh]]` form.
   */
  rawSlug: string;
  display: string | null;
}

/**
 * Extract `[[slug]]` and `[[slug|display]]` wikilinks from a body.
 * Returns the unique set of (slug, display) pairs; duplicates collapse.
 * Malformed slugs (containing `/`, `\`, or `.`) are skipped and logged
 * once per call. Underscores are normalized to hyphens.
 */
export function parseWikilinks(body: string): ParsedLink[] {
  const seen = new Map<string, ParsedLink>();
  const warnings: string[] = [];

  for (const m of body.matchAll(WIKILINK_PATTERN)) {
    const inner = m[1].trim();
    let slug: string;
    let display: string | null = null;
    const pipeIdx = inner.indexOf("|");
    if (pipeIdx >= 0) {
      slug = inner.slice(0, pipeIdx).trim();
      display = inner.slice(pipeIdx + 1).trim() || null;
    } else {
      slug = inner;
    }
    if (!slug) continue;
    if (SLUG_FORBIDDEN.test(slug)) {
      warnings.push(slug);
      continue;
    }
    const rawSlug = slug;
    // Normalize underscores to hyphens, then collapse runs of hyphens
    // (so `[[foo__bar]]` → `foo-bar`, not `foo--bar`) and trim leading/
    // trailing hyphens (so `[[_foo_]]` → `foo`, not `-foo-`). Reject if
    // nothing usable is left.
    slug = slug
      .replace(/_/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) {
      warnings.push(rawSlug);
      continue;
    }
    const key = slug;
    if (!seen.has(key)) {
      seen.set(key, { slug, rawSlug, display });
    }
  }

  if (warnings.length > 0) {
    console.warn(
      `[memory-links] Rejected ${warnings.length} malformed slug(s): ${warnings.slice(0, 5).join(", ")}${warnings.length > 5 ? "..." : ""}`,
    );
  }

  return Array.from(seen.values());
}

/**
 * Heuristic: classify a wikilink based on the surrounding ~240 chars
 * of body text. Returns one of: `parent`, `spouse`, `friend`, `lives_at`,
 * `works_at`, `attends_school`, `likes`, or the default `references`.
 *
 * Slim port of gbrain's link-extraction.ts:436 inferLinkType, scoped
 * to family-relationship patterns. Pure regex, zero LLM tokens.
 */
// Patterns require the keyword to be CLOSE to the end of the window
// (anchored with `$` after the lookahead) so a sentence like "AD is
// employed by [[shopify]] and loves [[blue-bottle]]" classifies each
// link by its own preceding context — not by the FIRST keyword in the
// sentence. The window ends right before the target slug's `[[`.
const INFER_PATTERNS: Array<{ type: string; re: RegExp }> = [
  { type: "parent", re: /\b(?:parent|mother|father|mom|dad|stepmother|stepfather)\b[^.\[\]]{0,80}$/i },
  { type: "spouse", re: /\b(?:spouse|husband|wife|partner|married)\b[^.\[\]]{0,80}$/i },
  { type: "friend", re: /\b(?:friend|buddy|pal)\b[^.\[\]]{0,80}$/i },
  { type: "lives_at", re: /\b(?:lives? at|lives? in|home (?:is|address))\b[^.\[\]]{0,80}$/i },
  { type: "works_at", re: /\b(?:works? at|employed (?:by|at)|day job at)\b[^.\[\]]{0,80}$/i },
  { type: "attends_school", re: /\b(?:attends|enrolled at|student at|goes to)\b[^.\[\]]{0,80}$/i },
  { type: "likes", re: /\b(?:likes?|loves?|enjoys?|favou?rite)\b[^.\[\]]{0,80}$/i },
];

export function inferLinkType(body: string, slug: string): string {
  // Window ends right before the target's `[[`, so the patterns can
  // match the keyword nearest to THIS link without picking up earlier
  // links' context. Match either `[[slug]]` or `[[slug|display]]` — the
  // only legal terminators — so a search for "josh" doesn't match
  // `[[josh-daws]]` by prefix.
  const idxClose = body.indexOf(`[[${slug}]]`);
  const idxPipe = body.indexOf(`[[${slug}|`);
  let idx: number;
  if (idxClose < 0 && idxPipe < 0) return "references";
  if (idxClose < 0) idx = idxPipe;
  else if (idxPipe < 0) idx = idxClose;
  else idx = Math.min(idxClose, idxPipe);
  const start = Math.max(0, idx - 240);
  const window = body.slice(start, idx);
  for (const { type, re } of INFER_PATTERNS) {
    if (re.test(window)) return type;
  }
  return "references";
}

/**
 * Reconcile memory_links rows for a given (fromSlug, fromCollection)
 * with the wikilinks present in `body`. Source-scoped: only rows with
 * `source='markdown'` are touched.
 */
export async function reconcileMemoryLinks(
  db: Db,
  fromSlug: string,
  fromCollection: string,
  body: string,
): Promise<{ added: number; removed: number }> {
  const parsed = parseWikilinks(body);
  const desired = new Set(parsed.map((p) => p.slug));

  // Fetch existing markdown-sourced links for this from-slug.
  const existing = await db
    .select({ id: memoryLinks.id, toSlug: memoryLinks.toSlug })
    .from(memoryLinks)
    .where(
      and(
        eq(memoryLinks.fromSlug, fromSlug),
        eq(memoryLinks.fromCollection, fromCollection),
        eq(memoryLinks.source, "markdown"),
      ),
    );

  const existingSlugs = new Set(existing.map((r) => r.toSlug));

  // Delete links that no longer appear in body.
  const toRemove = existing.filter((r) => !desired.has(r.toSlug));
  let removed = 0;
  for (const r of toRemove) {
    await db.delete(memoryLinks).where(eq(memoryLinks.id, r.id));
    removed++;
  }

  // Insert links that are new.
  let added = 0;
  for (const link of parsed) {
    if (existingSlugs.has(link.slug)) continue;
    const linkType = inferLinkType(body, link.rawSlug);
    await db.insert(memoryLinks).values({
      fromSlug,
      fromCollection,
      toSlug: link.slug,
      linkType,
      source: "markdown",
    });
    added++;
  }

  return { added, removed };
}

/**
 * Return all memories that link TO the given slug. Used by the
 * `get_backlinks` MCP tool and the search-ranking backlink boost.
 */
export async function getBacklinks(
  db: Db,
  toSlug: string,
): Promise<Array<{ fromSlug: string; fromCollection: string; linkType: string; source: string }>> {
  return db
    .select({
      fromSlug: memoryLinks.fromSlug,
      fromCollection: memoryLinks.fromCollection,
      linkType: memoryLinks.linkType,
      source: memoryLinks.source,
    })
    .from(memoryLinks)
    .where(eq(memoryLinks.toSlug, toSlug));
}
