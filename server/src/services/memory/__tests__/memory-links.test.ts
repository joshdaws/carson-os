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
      { slug: "grant-daws", rawSlug: "grant-daws", display: null },
    ]);
  });

  it("extracts [[slug|display]] references", () => {
    expect(parseWikilinks("See [[grant-daws|Grant]] for details")).toEqual([
      { slug: "grant-daws", rawSlug: "grant-daws", display: "Grant" },
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

  it("rejects malformed slugs (slash, dot)", () => {
    const links = parseWikilinks(
      "Bad: [[some/slug]] [[has.dot]]. Good: [[ok-slug]]",
    );
    expect(links.map((l) => l.slug)).toEqual(["ok-slug"]);
  });

  it("normalizes underscores to hyphens but preserves rawSlug", () => {
    const links = parseWikilinks("[[user_josh]] and [[project_carsonos|Carson]]");
    expect(links).toEqual([
      { slug: "user-josh", rawSlug: "user_josh", display: null },
      { slug: "project-carsonos", rawSlug: "project_carsonos", display: "Carson" },
    ]);
  });

  it("collapses underscore + hyphen variants of the same slug", () => {
    const links = parseWikilinks("[[user_josh]] and [[user-josh]]");
    expect(links).toHaveLength(1);
    expect(links[0].slug).toBe("user-josh");
  });

  it("normalizes pathological underscore forms to clean kebab", () => {
    // Adversarial review: naive `_` → `-` produces invalid kebab slugs
    // for double underscores and leading/trailing underscores.
    // `[[__foo]]` and `[[foo__]]` both normalize to "foo" and collapse
    // via the Map key (same as the existing dedup behavior).
    const links = parseWikilinks(
      "[[foo__bar]] [[__foo]] [[foo__]] [[a___b]]",
    );
    expect(links.map((l) => l.slug)).toEqual([
      "foo-bar",
      "foo",
      "a-b",
    ]);
  });

  it("rejects slugs that normalize to empty string", () => {
    const links = parseWikilinks("Bad: [[___]] [[_]]. Good: [[ok]]");
    expect(links.map((l) => l.slug)).toEqual(["ok"]);
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

  it("locates wikilinks by raw slug, including underscore form", () => {
    // Regression: when an agent emits [[user_josh]] in a body, parseWikilinks
    // normalizes the slug to "user-josh" — but inferLinkType has to find the
    // wikilink in the ORIGINAL body to read the surrounding context. Using
    // the raw underscore form keeps that lookup working.
    expect(
      inferLinkType("Josh is married to [[becca_daws]]", "becca_daws"),
    ).toBe("spouse");
  });

  it("does not prefix-match a shorter slug into a longer wikilink", () => {
    // Adversarial review: previous code did `body.indexOf("[[" + slug)`
    // (open bracket prefix only). Searching for "josh" matched
    // `[[josh-daws]]` — wrong context window.
    const body = "Josh is married to [[josh-daws]] and works at [[josh]].";
    // [[josh]] follows "works at" — should classify as works_at, not spouse
    // (spouse precedes [[josh-daws]], a DIFFERENT slug).
    expect(inferLinkType(body, "josh")).toBe("works_at");
    // [[josh-daws]] is the spouse target.
    expect(inferLinkType(body, "josh-daws")).toBe("spouse");
  });

  it("matches wikilinks with display text (`[[slug|display]]`)", () => {
    expect(
      inferLinkType("Becca is the mother of [[grant-daws|Grant]]", "grant-daws"),
    ).toBe("parent");
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

  it("classifies underscore-form wikilinks correctly (slug normalizes, link type still infers)", async () => {
    // End-to-end regression: agents emit [[user_josh]] which parseWikilinks
    // normalizes to "user-josh" before insertion. The link type inference
    // must still see "married to" preceding [[user_josh]] in the body, even
    // though the persisted slug is the hyphen form.
    await reconcileMemoryLinks(
      db,
      "page-about-becca",
      "household",
      "Becca is married to [[josh_daws]] and is the mother of [[grant_daws]].",
    );
    const joshBacklinks = await getBacklinks(db, "josh-daws");
    expect(joshBacklinks).toHaveLength(1);
    expect(joshBacklinks[0].linkType).toBe("spouse");

    const grantBacklinks = await getBacklinks(db, "grant-daws");
    expect(grantBacklinks).toHaveLength(1);
    expect(grantBacklinks[0].linkType).toBe("parent");
  });
});
