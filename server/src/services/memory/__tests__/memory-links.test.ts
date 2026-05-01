/**
 * Tests for memory-links: [[wikilink]] parser, link-type inference,
 * and reconciliation against the memory_links table.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb, type Db, memoryLinks } from "@carsonos/db";
import {
  parseWikilinks,
  inferLinkType,
  reconcileMemoryLinks,
  getBacklinks,
} from "../memory-links.js";

describe("parseWikilinks", () => {
  it("extracts simple [[slug]] references", () => {
    expect(parseWikilinks("Hello [[grant-daws]] world")).toEqual([
      { slug: "grant-daws", display: null },
    ]);
  });

  it("extracts [[slug|display]] references", () => {
    expect(parseWikilinks("See [[grant-daws|Grant]] for details")).toEqual([
      { slug: "grant-daws", display: "Grant" },
    ]);
  });

  it("collapses duplicate slugs", () => {
    const links = parseWikilinks("[[ad-robles]] and [[ad-robles|AD]] both refer to him");
    expect(links).toHaveLength(1);
    expect(links[0].slug).toBe("ad-robles");
  });

  it("returns multiple distinct links", () => {
    const links = parseWikilinks("[[grant-daws]] attends [[lincoln-elementary]]");
    expect(links.map((l) => l.slug)).toEqual(["grant-daws", "lincoln-elementary"]);
  });

  it("rejects malformed slugs (slash, dot, underscore)", () => {
    const links = parseWikilinks(
      "Bad: [[some/slug]] [[has.dot]] [[under_score]]. Good: [[ok-slug]]",
    );
    expect(links.map((l) => l.slug)).toEqual(["ok-slug"]);
  });

  it("returns empty for body without wikilinks", () => {
    expect(parseWikilinks("Just plain text with no links.")).toEqual([]);
  });

  it("ignores empty [[]] brackets", () => {
    expect(parseWikilinks("Empty [[]] should not match")).toEqual([]);
  });
});

describe("inferLinkType", () => {
  const slug = "grant-daws";

  it("returns 'parent' when 'mother' / 'father' precedes the link", () => {
    expect(
      inferLinkType("Becca is the mother of [[grant-daws]]", slug),
    ).toBe("parent");
  });

  it("returns 'spouse' for 'married to'", () => {
    expect(
      inferLinkType("Josh is married to [[becca-daws]]", "becca-daws"),
    ).toBe("spouse");
  });

  it("returns 'friend' when phrasing matches", () => {
    expect(
      inferLinkType("AD is a friend of [[grant-daws]]", slug),
    ).toBe("friend");
  });

  it("returns 'lives_at' for 'lives in'", () => {
    expect(
      inferLinkType("Family lives in [[austin-tx]]", "austin-tx"),
    ).toBe("lives_at");
  });

  it("returns 'works_at' for 'employed by'", () => {
    expect(
      inferLinkType("AD is employed by [[shopify]]", "shopify"),
    ).toBe("works_at");
  });

  it("returns 'attends_school' for 'enrolled at'", () => {
    expect(
      inferLinkType("Grant is enrolled at [[lincoln-elementary]]", "lincoln-elementary"),
    ).toBe("attends_school");
  });

  it("returns 'likes' for 'loves'", () => {
    expect(
      inferLinkType("Grant loves [[wonderland-musical]]", "wonderland-musical"),
    ).toBe("likes");
  });

  it("falls back to 'references' when no pattern matches", () => {
    expect(
      inferLinkType("Mention of [[grant-daws]] in a neutral context.", slug),
    ).toBe("references");
  });
});

describe("reconcileMemoryLinks + getBacklinks", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "memlinks-test-"));
    dbPath = join(dir, "test.db");
    db = createDb(dbPath);
  });

  afterEach(() => {
    rmSync(dbPath.replace(/test\.db$/, ""), { recursive: true, force: true });
  });

  it("inserts new links on first reconcile", async () => {
    const result = await reconcileMemoryLinks(
      db,
      "ad-robles",
      "household",
      "[[grant-daws]] is connected via [[josh-daws]]",
    );
    expect(result.added).toBe(2);
    expect(result.removed).toBe(0);

    const grantBacklinks = await getBacklinks(db, "grant-daws");
    expect(grantBacklinks).toHaveLength(1);
    expect(grantBacklinks[0].fromSlug).toBe("ad-robles");
  });

  it("removes links that are no longer in the body", async () => {
    await reconcileMemoryLinks(db, "ad-robles", "household", "[[grant-daws]] [[josh-daws]]");

    // Update: only grant-daws remains.
    const result = await reconcileMemoryLinks(db, "ad-robles", "household", "Only [[grant-daws]] now");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(1);

    expect(await getBacklinks(db, "josh-daws")).toHaveLength(0);
    expect(await getBacklinks(db, "grant-daws")).toHaveLength(1);
  });

  it("preserves manual links during reconciliation", async () => {
    await reconcileMemoryLinks(db, "ad-robles", "household", "[[grant-daws]]");
    // Insert a manual link directly.
    await db.insert(memoryLinks).values({
      fromSlug: "ad-robles",
      fromCollection: "household",
      toSlug: "manual-target",
      linkType: "references",
      source: "manual",
    });

    // Re-reconcile with body that drops grant-daws.
    await reconcileMemoryLinks(db, "ad-robles", "household", "Body without links");

    const allFromAd = await db
      .select()
      .from(memoryLinks);
    // manual-target should still be there.
    expect(allFromAd.some((l) => l.toSlug === "manual-target" && l.source === "manual")).toBe(true);
    // grant-daws should be gone.
    expect(allFromAd.some((l) => l.toSlug === "grant-daws")).toBe(false);
  });

  it("classifies link types based on context", async () => {
    await reconcileMemoryLinks(
      db,
      "page-about-ad",
      "household",
      "AD is employed by [[shopify]] and loves [[blue-bottle]].",
    );
    const backlinks = await getBacklinks(db, "shopify");
    expect(backlinks[0].linkType).toBe("works_at");
    const blueBottleBacklinks = await getBacklinks(db, "blue-bottle");
    expect(blueBottleBacklinks[0].linkType).toBe("likes");
  });
});
