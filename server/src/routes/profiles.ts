/**
 * Profile routes -- per-member profile CRUD + interview wizard.
 *
 * Mounted at /api/members/:memberId/profile
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { familyMembers, profileInterviewState } from "@carsonos/db";
import type { ProfileInterviewEngine } from "../services/profile-interview.js";

export interface ProfileRouteDeps {
  db: Db;
  profileInterviewEngine: ProfileInterviewEngine;
}

export function createProfileRoutes(deps: ProfileRouteDeps): Router {
  const { db, profileInterviewEngine } = deps;
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

    res.json({
      memberId: member.id,
      memberName: member.name,
      profileContent: member.profileContent ?? null,
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

    const [updated] = await db
      .update(familyMembers)
      .set({
        profileContent,
        profileUpdatedAt: new Date(),
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
