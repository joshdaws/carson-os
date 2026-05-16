/**
 * Profile routes -- per-member profile CRUD + interview wizard.
 *
 * Mounted at /api/members/:memberId/profile
 *
 * Reads are disk-first (USER.md) with the DB column as a fallback; writes
 * update both. The DB column existed before v0.5 and is kept in sync so
 * older code paths and the boot migration continue to work.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { familyMembers, profileInterviewState } from "@carsonos/db";
import type { ProfileInterviewEngine } from "../services/profile-interview.js";
import {
  getMemberSlug,
  loadUserMd,
  writeUserMd,
} from "../services/identity-files.js";

export interface ProfileRouteDeps {
  db: Db;
  profileInterviewEngine: ProfileInterviewEngine;
  /** Data directory root. When set, GET reads USER.md first and PUT
   * mirrors the saved content to USER.md. Null disables disk I/O. */
  dataDir?: string | null;
}

export function createProfileRoutes(deps: ProfileRouteDeps): Router {
  const { db, profileInterviewEngine } = deps;
  const dataDir = deps.dataDir ?? null;
  const router = Router();

  // GET /:memberId/profile -- get profile + interview state
  router.get("/:memberId/profile", async (req, res) => {
    const { memberId } = req.params;

    const member = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, memberId))
      .get();

    if (!member) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    // Get interview state if it exists
    const [interviewState] = await db
      .select()
      .from(profileInterviewState)
      .where(eq(profileInterviewState.memberId, memberId))
      .limit(1);

    // Disk-first read: USER.md is the v0.5+ source of truth. Fall back
    // to the DB column when the file doesn't exist (older members or
    // pre-migration state).
    const diskContent = dataDir
      ? loadUserMd(dataDir, getMemberSlug(member))
      : null;
    const profileContent = diskContent ?? member.profileContent ?? null;

    res.json({
      memberId: member.id,
      memberName: member.name,
      profileContent,
      profileUpdatedAt: member.profileUpdatedAt ?? null,
      interview: interviewState
        ? {
            phase: interviewState.phase,
            messageCount: ((interviewState.interviewMessages as unknown[]) ?? []).length,
            messages: interviewState.interviewMessages ?? [],
          }
        : null,
    });
  });

  // PUT /:memberId/profile -- directly edit profile text
  router.put("/:memberId/profile", async (req, res) => {
    const { memberId } = req.params;
    const { profileContent } = req.body;

    if (profileContent === undefined) {
      res.status(400).json({ error: "profileContent is required" });
      return;
    }

    const member = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, memberId))
      .get();

    if (!member) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    // Disk-first ordering: write USER.md before the DB column. If disk
    // fails we return 500 and leave the DB untouched, so we never end up
    // with a "saved" toast while the canonical (disk) source is stale.
    // The DB column is the mirror; it's safe to update only after disk wins.
    let resolvedSlug: string | null = null;
    if (dataDir) {
      try {
        resolvedSlug = getMemberSlug(member);
        writeUserMd(dataDir, resolvedSlug, profileContent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[profiles] USER.md write failed for ${member.name}; aborting save:`,
          err,
        );
        res.status(500).json({
          error: "Failed to write profile to disk; nothing was saved.",
          detail: msg,
        });
        return;
      }
    }

    // Lazy-backfill profile_slug so this member's disk path becomes stable
    // across future renames. Only set when we actually wrote to disk and
    // the column is currently null.
    const slugBackfill =
      resolvedSlug && !member.profileSlug ? { profileSlug: resolvedSlug } : {};

    const [updated] = await db
      .update(familyMembers)
      .set({
        profileContent,
        profileUpdatedAt: new Date(),
        ...slugBackfill,
      })
      .where(eq(familyMembers.id, memberId))
      .returning();

    res.json({
      memberId: updated.id,
      profileContent: updated.profileContent,
      profileUpdatedAt: updated.profileUpdatedAt,
    });
  });

  // POST /:memberId/profile/interview -- send interview message
  router.post("/:memberId/profile/interview", async (req, res) => {
    const { memberId } = req.params;
    const { message } = req.body;

    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    try {
      const result = await profileInterviewEngine.processMessage(memberId, message);
      res.json({
        response: result.response,
        phase: result.phase,
        profileDocument: result.profileDocument,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Interview failed";
      if (msg === "Family member not found") {
        res.status(404).json({ error: msg });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  // POST /:memberId/profile/reset -- reset interview to start over
  router.post("/:memberId/profile/reset", async (req, res) => {
    const { memberId } = req.params;

    const member = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, memberId))
      .get();

    if (!member) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    await profileInterviewEngine.resetInterview(memberId);
    res.json({ reset: true });
  });

  return router;
}
