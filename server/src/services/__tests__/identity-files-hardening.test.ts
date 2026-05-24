/**
 * Hardening tests for the identity-file write path, added after the
 * round-6 adversarial review:
 *   - writeUserMd / writePersonalityMd reject empty slugs (would collapse
 *     to a shared members//USER.md or agents//PERSONALITY.md path)
 *   - getAgentSlug mirrors getMemberSlug's id-fallback for empty-slug names
 *   - atomic write leaves no .tmp-* junk on success
 *   - the family_members.profile_slug UNIQUE index rejects duplicate slugs
 *     (the durable backstop for the assignUniqueMemberSlug TOCTOU race)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb, type Db, households, familyMembers } from "@carsonos/db";
import {
  getAgentSlug,
  getMemberSlug,
  userMdPath,
  personalityMdPath,
  writeUserMd,
  writePersonalityMd,
} from "../identity-files.js";

let tmpDataDir: string;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "carsonos-idfiles-"));
});
afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("empty-slug guards", () => {
  it("writeUserMd throws on empty slug", () => {
    expect(() => writeUserMd(tmpDataDir, "", "body")).toThrow(/non-empty/);
  });
  it("writePersonalityMd throws on empty slug", () => {
    expect(() => writePersonalityMd(tmpDataDir, "", "body")).toThrow(/non-empty/);
  });
});

describe("getAgentSlug fallback chain", () => {
  it("uses slugified name when it produces output", () => {
    expect(getAgentSlug({ id: "abc", name: "Bob the Butler" })).toBe("bob-the-butler");
  });
  it("falls back to id-derived slug for names that slugify to empty", () => {
    const id = "11112222-3333-4444-5555-666677778888";
    expect(getAgentSlug({ id, name: "🤖" })).toBe(`a-${id.replace(/-/g, "").slice(0, 12)}`);
  });
});

describe("getMemberSlug fallback chain", () => {
  it("prefers stable profileSlug", () => {
    expect(getMemberSlug({ id: "x", name: "Renamed", profileSlug: "original" })).toBe("original");
  });
  it("falls back to slugified name", () => {
    expect(getMemberSlug({ id: "x", name: "Alex", profileSlug: null })).toBe("alex");
  });
  it("falls back to id-derived slug for emoji-only names", () => {
    const id = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
    expect(getMemberSlug({ id, name: "🚀", profileSlug: null })).toBe(
      `m-${id.replace(/-/g, "").slice(0, 12)}`,
    );
  });
});

describe("atomic write", () => {
  it("writes full content and leaves no .tmp-* junk on success", () => {
    writeUserMd(tmpDataDir, "josh", "# Josh\n\nfull content");
    const dir = join(tmpDataDir, "members", "josh");
    expect(readFileSync(userMdPath(tmpDataDir, "josh"), "utf-8")).toBe("# Josh\n\nfull content");
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
  it("overwrites cleanly on repeated writes (no tmp accumulation)", () => {
    writeUserMd(tmpDataDir, "josh", "v1");
    writeUserMd(tmpDataDir, "josh", "v2");
    writeUserMd(tmpDataDir, "josh", "v3");
    expect(readFileSync(userMdPath(tmpDataDir, "josh"), "utf-8")).toBe("v3");
    expect(readdirSync(join(tmpDataDir, "members", "josh"))).toEqual(["USER.md"]);
  });
  it("writePersonalityMd writes to the agents dir", () => {
    writePersonalityMd(tmpDataDir, "carson", "# Carson personality");
    expect(readFileSync(personalityMdPath(tmpDataDir, "carson"), "utf-8")).toBe(
      "# Carson personality",
    );
  });
});

describe("profile_slug UNIQUE index (TOCTOU backstop)", () => {
  let db: Db;
  beforeEach(async () => {
    db = createDb(":memory:");
    await db
      .insert(households)
      .values({ id: "h1", name: "Test", timezone: "America/New_York" })
      .returning();
  });

  it("rejects a second member with a duplicate profile_slug", async () => {
    await db
      .insert(familyMembers)
      .values({ householdId: "h1", name: "Alex", role: "kid", age: 12, profileSlug: "alex" })
      .returning();

    await expect(
      db
        .insert(familyMembers)
        .values({ householdId: "h1", name: "Alex II", role: "kid", age: 9, profileSlug: "alex" })
        .returning(),
    ).rejects.toThrow(/UNIQUE constraint/);
  });

  it("allows multiple NULL profile_slugs (partial index)", async () => {
    await db
      .insert(familyMembers)
      .values({ householdId: "h1", name: "A", role: "kid", age: 1, profileSlug: null })
      .returning();
    // Second NULL must not trip the unique index.
    await expect(
      db
        .insert(familyMembers)
        .values({ householdId: "h1", name: "B", role: "kid", age: 2, profileSlug: null })
        .returning(),
    ).resolves.toBeDefined();
  });
});
