/**
 * Verifies the /api/members/:id/profile route mirrors profile content
 * to USER.md on PUT and prefers USER.md over the DB column on GET.
 * The disk file is the v0.5+ source of truth; the DB column is a
 * fallback. Reads must surface disk content so that direct file edits
 * are visible in the dashboard.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import {
  createDb,
  familyMembers,
  households,
  type Db,
} from "@carsonos/db";
import { createProfileRoutes } from "../profiles.js";
import type { ProfileInterviewEngine } from "../../services/profile-interview.js";
import { userMdPath } from "../../services/identity-files.js";

let tmpDataDir: string;
let db: Db;
let memberId: string;
let server: Server;
let baseUrl: string;

const stubEngine = {} as ProfileInterviewEngine;

async function startServer(dataDir: string | null): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/members",
    createProfileRoutes({
      db,
      profileInterviewEngine: stubEngine,
      dataDir,
    }),
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "carsonos-profile-route-"));
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
      profileContent: "# About Josh\n\nFrom DB column.",
    })
    .returning();
  memberId = member.id;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("PUT /:id/profile mirrors to USER.md", () => {
  it("writes the profileContent body to USER.md on disk", async () => {
    await startServer(tmpDataDir);
    const newContent = "# About Josh\n\nUpdated from API.";
    const res = await fetch(`${baseUrl}/api/members/${memberId}/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileContent: newContent }),
    });
    expect(res.status).toBe(200);

    const path = userMdPath(tmpDataDir, "josh");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(newContent);
  });

  it("does NOT write to disk when dataDir is null (DB still updated)", async () => {
    await startServer(null);
    const res = await fetch(`${baseUrl}/api/members/${memberId}/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileContent: "# new" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(userMdPath(tmpDataDir, "josh"))).toBe(false);
  });

  it("returns 500 and leaves DB unchanged when disk write fails", async () => {
    // Point dataDir at a path under a regular FILE (not a directory)
    // so mkdirSync inside writeUserMd throws ENOTDIR. Reproduces the
    // dual-write-rollback contract: disk failure must NOT silently
    // succeed at the DB layer.
    const bogusFile = join(tmpDataDir, "bogus-file");
    writeFileSync(bogusFile, "i am a file, not a directory");

    await startServer(bogusFile);
    const res = await fetch(`${baseUrl}/api/members/${memberId}/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileContent: "# should not persist" }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/disk/i);

    // DB column is unchanged
    const member = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, memberId))
      .get();
    expect(member?.profileContent).toBe("# About Josh\n\nFrom DB column.");
  });

  it("backfills profile_slug on first successful disk write", async () => {
    // Member was created in beforeEach without an explicit profileSlug,
    // simulating an existing (pre-migration) row.
    await db
      .update(familyMembers)
      .set({ profileSlug: null })
      .where(eq(familyMembers.id, memberId));

    await startServer(tmpDataDir);
    const res = await fetch(`${baseUrl}/api/members/${memberId}/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileContent: "# fresh" }),
    });
    expect(res.status).toBe(200);

    const member = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, memberId))
      .get();
    expect(member?.profileSlug).toBe("josh");
  });
});

describe("GET /:id/profile prefers USER.md over DB column", () => {
  it("returns USER.md content when the file exists", async () => {
    // File on disk wins over the seeded DB content.
    mkdirSync(join(tmpDataDir, "members", "josh"), { recursive: true });
    writeFileSync(
      join(tmpDataDir, "members", "josh", "USER.md"),
      "# About Josh\n\nFrom disk file.",
    );
    await startServer(tmpDataDir);

    const res = await fetch(`${baseUrl}/api/members/${memberId}/profile`);
    const body = await res.json();
    expect(body.profileContent).toBe("# About Josh\n\nFrom disk file.");
  });

  it("falls back to DB column when USER.md is missing", async () => {
    await startServer(tmpDataDir);
    const res = await fetch(`${baseUrl}/api/members/${memberId}/profile`);
    const body = await res.json();
    expect(body.profileContent).toBe("# About Josh\n\nFrom DB column.");
  });

  it("returns DB column when dataDir is null", async () => {
    await startServer(null);
    const res = await fetch(`${baseUrl}/api/members/${memberId}/profile`);
    const body = await res.json();
    expect(body.profileContent).toBe("# About Josh\n\nFrom DB column.");
  });
});
