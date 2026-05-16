/**
 * Verifies that the ProfileInterviewEngine mirrors a completed profile
 * to USER.md on disk, alongside the DB write. Regression test for the
 * gap where a build-profile run from the dashboard left only the DB
 * column populated and never produced an editable USER.md.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb, type Db, households, familyMembers } from "@carsonos/db";
import type {
  AdapterExecuteParams,
  AdapterExecuteResult,
} from "@carsonos/shared";
import { ProfileInterviewEngine } from "../profile-interview.js";
import { userMdPath } from "../identity-files.js";
import type { Adapter } from "../subprocess-adapter.js";

class StubAdapter implements Adapter {
  name = "stub";
  responses: string[] = [];
  async execute(_params: AdapterExecuteParams): Promise<AdapterExecuteResult> {
    const content = this.responses.shift() ?? "";
    return { content };
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

let tmpDataDir: string;
let db: Db;
let memberId: string;

beforeEach(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "carsonos-profile-disk-"));
  db = createDb(":memory:");
  const [household] = await db
    .insert(households)
    .values({ id: "h1", name: "Test", timezone: "America/New_York" })
    .returning();
  const [member] = await db
    .insert(familyMembers)
    .values({
      householdId: household.id,
      name: "Josh",
      role: "parent",
      age: 48,
    })
    .returning();
  memberId = member.id;
});

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("ProfileInterviewEngine writes USER.md on completion", () => {
  it("writes USER.md when [PROFILE_START]..[PROFILE_END] is in the response", async () => {
    const adapter = new StubAdapter();
    adapter.responses.push(
      [
        "Got it — here is your profile.",
        "[PHASE: review_complete]",
        "[PROFILE_START]",
        "# About Josh",
        "",
        "Builder. Loves low latency.",
        "[PROFILE_END]",
      ].join("\n"),
    );

    const engine = new ProfileInterviewEngine({
      db,
      adapter,
      dataDir: tmpDataDir,
    });

    const result = await engine.processMessage(memberId, "I'm a builder.");

    expect(result.profileDocument).toBeDefined();
    expect(result.profileDocument).toContain("# About Josh");

    const filePath = userMdPath(tmpDataDir, "josh");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe(result.profileDocument);
  });

  it("does NOT write USER.md when no profile document is in the response", async () => {
    const adapter = new StubAdapter();
    adapter.responses.push("Tell me more about how Josh handles frustration.\n[PHASE: boundaries]");

    const engine = new ProfileInterviewEngine({
      db,
      adapter,
      dataDir: tmpDataDir,
    });

    await engine.processMessage(memberId, "He's pretty patient.");

    expect(existsSync(userMdPath(tmpDataDir, "josh"))).toBe(false);
  });

  it("skips disk write when dataDir is null (DB still updated)", async () => {
    const adapter = new StubAdapter();
    adapter.responses.push("[PHASE: review_complete][PROFILE_START]# About Josh\nbody[PROFILE_END]");

    const engine = new ProfileInterviewEngine({
      db,
      adapter,
      dataDir: null,
    });

    const result = await engine.processMessage(memberId, "msg");

    expect(result.profileDocument).toContain("# About Josh");

    // The DB column is still written even when the engine has no dataDir
    // — that's the actual contract this test verifies. (Previously this
    // test only asserted existsSync against tmpDataDir, which the engine
    // wasn't given, so it passed trivially.)
    const member = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, memberId))
      .get();
    expect(member?.profileContent).toContain("# About Josh");

    // Sanity: no USER.md was written anywhere we'd expect, since dataDir was null.
    expect(existsSync(userMdPath(tmpDataDir, "josh"))).toBe(false);
  });

  it("survives a member rename via stable profile_slug column", async () => {
    const adapter = new StubAdapter();
    adapter.responses.push(
      "[PHASE: review_complete][PROFILE_START]# About Josh\nfirst-write[PROFILE_END]",
    );

    const engine = new ProfileInterviewEngine({
      db,
      adapter,
      dataDir: tmpDataDir,
    });

    // First save lazy-backfills profile_slug = "josh"
    await engine.processMessage(memberId, "first message");
    expect(existsSync(userMdPath(tmpDataDir, "josh"))).toBe(true);
    const m1 = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, memberId))
      .get();
    expect(m1?.profileSlug).toBe("josh");

    // Rename the member ("Josh" → "Joshua")
    await db
      .update(familyMembers)
      .set({ name: "Joshua" })
      .where(eq(familyMembers.id, memberId));

    // Second save: must keep writing to the ORIGINAL slug, not derive a
    // new one from the new name. Otherwise USER.md gets orphaned and
    // disk-first reads serve stale-or-empty content.
    adapter.responses.push(
      "[PHASE: review_complete][PROFILE_START]# About Joshua\nsecond-write[PROFILE_END]",
    );
    await engine.processMessage(memberId, "second message");

    const stableFile = readFileSync(userMdPath(tmpDataDir, "josh"), "utf-8");
    expect(stableFile).toContain("second-write");
    expect(existsSync(userMdPath(tmpDataDir, "joshua"))).toBe(false);
  });
});
