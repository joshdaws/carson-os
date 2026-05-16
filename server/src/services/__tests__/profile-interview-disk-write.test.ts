/**
 * Verifies that the ProfileInterviewEngine mirrors a completed profile
 * to USER.md on disk, alongside the DB write. Regression test for the
 * gap where a build-profile run from the dashboard left only the DB
 * column populated and never produced an editable USER.md.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
    expect(existsSync(userMdPath(tmpDataDir, "josh"))).toBe(false);
  });
});
