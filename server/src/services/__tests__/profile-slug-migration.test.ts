/**
 * Tests the packages/db profile_slug UNIQUE-index migration block — the
 * new code from the round-6 hardening pass (previously zero-coverage in
 * packages/db, flagged in the coverage audit).
 *
 * Strategy: build a real full-schema DB via createDb, then simulate a
 * pre-index state on disk (drop the unique index, plant duplicate slugs),
 * close, and re-open via createDb. The upgrade block (gated on index
 * existence) then fires: it must dedup the duplicates and recreate the
 * index, after which duplicate inserts are rejected.
 *
 * This exercises the dedup-before-create-index logic directly. The
 * column-ADD + name→slug backfill block (older code, gated on column
 * absence) is covered indirectly by the bootstrap path every other test
 * uses and by profiles-disk-sync / profile-interview-disk-write.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb, type Db, households, familyMembers } from "@carsonos/db";
import { eq } from "drizzle-orm";

// drizzle better-sqlite3 exposes the underlying Database as `$client`.
interface RawSqlite {
  exec(s: string): void;
  prepare(s: string): { run: (...a: unknown[]) => void };
  close(): void;
}
function raw(db: Db): RawSqlite {
  return (db as unknown as { $client: RawSqlite }).$client;
}

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "carsonos-slugmig-"));
  dbPath = join(tmpDir, "carsonos.db");
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("profile_slug UNIQUE-index migration block", () => {
  it("dedups pre-existing duplicate slugs and recreates the index on upgrade", async () => {
    // 1. Fresh full-schema DB.
    const db1 = createDb(dbPath);
    await db1.insert(households).values({ id: "h1", name: "Test", timezone: "America/New_York" });
    await db1
      .insert(familyMembers)
      .values({ id: "m1", householdId: "h1", name: "Alex", role: "kid", age: 12, profileSlug: "x1" });
    await db1
      .insert(familyMembers)
      .values({ id: "m2", householdId: "h1", name: "Alex", role: "kid", age: 9, profileSlug: "x2" });

    // 2. Simulate a pre-index state: drop the unique index, then force both
    //    members onto the SAME slug (only possible with the index gone).
    const c = raw(db1);
    c.exec("DROP INDEX IF EXISTS family_members_profile_slug_unique");
    c.prepare("UPDATE family_members SET profile_slug = 'alex' WHERE id IN ('m1','m2')").run();
    c.close();

    // 3. Re-open — upgradeTables sees the index is missing, dedups, recreates it.
    const db2 = createDb(dbPath);
    const m1 = await db2.select().from(familyMembers).where(eq(familyMembers.id, "m1")).get();
    const m2 = await db2.select().from(familyMembers).where(eq(familyMembers.id, "m2")).get();

    expect(m1?.profileSlug).toBeTruthy();
    expect(m2?.profileSlug).toBeTruthy();
    expect(m1?.profileSlug).not.toBe(m2?.profileSlug); // deduped
    // Earliest-created (m1, created first) keeps "alex"; m2 gets suffixed.
    expect([m1?.profileSlug, m2?.profileSlug].filter((s) => s === "alex")).toHaveLength(1);
    expect([m1?.profileSlug, m2?.profileSlug].some((s) => /^alex-/.test(s ?? ""))).toBe(true);
  });

  it("recreates the index so post-migration duplicate inserts are rejected", async () => {
    const db1 = createDb(dbPath);
    await db1.insert(households).values({ id: "h1", name: "Test", timezone: "America/New_York" });
    await db1
      .insert(familyMembers)
      .values({ id: "m1", householdId: "h1", name: "Alex", role: "kid", age: 12, profileSlug: "alex" });
    raw(db1).exec("DROP INDEX IF EXISTS family_members_profile_slug_unique");
    raw(db1).close();

    const db2 = createDb(dbPath); // recreates the index
    await expect(
      db2
        .insert(familyMembers)
        .values({ id: "m9", householdId: "h1", name: "Dup", role: "kid", age: 5, profileSlug: "alex" })
        .returning(),
    ).rejects.toThrow(/UNIQUE constraint/);
  });

  it("is idempotent — re-opening a healthy DB does not reassign slugs", async () => {
    const db1 = createDb(dbPath);
    await db1.insert(households).values({ id: "h1", name: "Test", timezone: "America/New_York" });
    await db1
      .insert(familyMembers)
      .values({ id: "m1", householdId: "h1", name: "Alex", role: "kid", age: 12, profileSlug: "alex" });
    const before = await db1.select().from(familyMembers).where(eq(familyMembers.id, "m1")).get();
    raw(db1).close();

    const db2 = createDb(dbPath); // index already present → no churn
    const after = await db2.select().from(familyMembers).where(eq(familyMembers.id, "m1")).get();
    expect(after?.profileSlug).toBe(before?.profileSlug);
  });
});
