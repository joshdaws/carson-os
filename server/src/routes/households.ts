/**
 * Household routes -- CRUD for the household entity.
 *
 * MVP: single household. GET /current returns the first (only) one.
 */

import { Router } from "express";
import { eq, and } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { households, familyMembers, staffAgents, constitutions, staffAssignments } from "@carsonos/db";
import {
  getAgentSlug,
  getMemberSlug,
  hasIdentityContent,
  loadPersonalityMd,
  loadUserMd,
} from "../services/identity-files.js";

export function createHouseholdRoutes(db: Db, dataDir?: string | null): Router {
  const router = Router();

  // GET /current -- return the current (only) household with counts
  router.get("/current", async (_req, res) => {
    const household = await db.select().from(households).limit(1).get();

    if (!household) {
      res.status(404).json({ error: "No household found" });
      return;
    }

    const members = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.householdId, household.id))
      .all();

    const staff = await db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.householdId, household.id))
      .all();

    // Compute onboarding checklist
    const activeConstitution = await db
      .select()
      .from(constitutions)
      .where(
        and(
          eq(constitutions.householdId, household.id),
          eq(constitutions.isActive, true),
        ),
      )
      .limit(1)
      .get();

    const familyStaff = staff.filter((s) => s.visibility === "family");
    // v0.5+ stores profiles/personalities on disk as USER.md / PERSONALITY.md;
    // the DB columns remain as fallback. Consult both so disk-only identity
    // content doesn't leave the onboarding checklist falsely incomplete.
    // Same per-member computation drives the response's `hasProfile` field
    // below (UI uses it to gate the View/Edit CTA), so a disk-only profile
    // doesn't get misrendered as "Build profile".
    const memberProfileStatus = new Map<string, boolean>();
    for (const m of members) {
      memberProfileStatus.set(
        m.id,
        hasIdentityContent(
          dataDir ? loadUserMd(dataDir, getMemberSlug(m)) : null,
          m.profileContent,
        ),
      );
    }
    const membersWithProfiles = members.filter(
      (m) => memberProfileStatus.get(m.id) === true,
    );
    const agentsWithSoul = familyStaff.filter((s) =>
      hasIdentityContent(
        dataDir ? loadPersonalityMd(dataDir, getAgentSlug(s)) : null,
        s.soulContent,
      ),
    );
    const agentsWithTelegram = familyStaff.filter((s) => s.telegramBotToken !== null);

    // Count assignments for non-parent members
    const nonParentMembers = members.filter((m) => m.role !== "parent");
    const allAssignments = await db.select().from(staffAssignments).all();
    const nonParentMemberIds = new Set(nonParentMembers.map((m) => m.id));
    const membersWithAssignments = new Set(
      allAssignments
        .filter((a) => nonParentMemberIds.has(a.memberId))
        .map((a) => a.memberId),
    );

    const checklist = {
      items: [
        { key: "household", label: "Set up household", required: true, complete: true },
        { key: "constitution", label: "Create family constitution", required: true, complete: !!activeConstitution },
        { key: "profiles", label: "Build member profiles", required: false, complete: membersWithProfiles.length === members.length && members.length > 0 },
        { key: "personalities", label: "Configure agent personalities", required: false, complete: agentsWithSoul.length === familyStaff.length && familyStaff.length > 0 },
        { key: "telegram", label: "Connect Telegram bots", required: false, complete: agentsWithTelegram.length > 0 },
        { key: "assignments", label: "Assign agents to family members", required: false, complete: allAssignments.length > 0 },
        { key: "google", label: "Connect Google (Calendar, Gmail, Drive)", required: false, complete: false },
      ],
      completedCount: 0,
      totalCount: 7,
    };
    checklist.completedCount = checklist.items.filter((i) => i.complete).length;

    // Enrich each member with `hasProfile` so the UI doesn't have to
    // re-derive it from the (possibly null) DB column alone. A disk-only
    // profile reads as hasProfile=true here.
    const membersWithStatus = members.map((m) => ({
      ...m,
      hasProfile: memberProfileStatus.get(m.id) === true,
    }));

    res.json({
      household,
      members: membersWithStatus,
      memberCount: members.length,
      staffCount: staff.length,
      checklist,
    });
  });

  // POST / -- create household
  router.post("/", async (req, res) => {
    const { name, timezone } = req.body;

    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const [household] = await db
      .insert(households)
      .values({ name, timezone: timezone ?? "America/New_York" })
      .returning();

    res.status(201).json({ household });
  });

  // PUT /:id -- update household
  router.put("/:id", async (req, res) => {
    const { name, timezone } = req.body;
    const existing = await db
      .select()
      .from(households)
      .where(eq(households.id, req.params.id))
      .get();

    if (!existing) {
      res.status(404).json({ error: "Household not found" });
      return;
    }

    const [updated] = await db
      .update(households)
      .set({
        ...(name !== undefined && { name }),
        ...(timezone !== undefined && { timezone }),
        updatedAt: new Date(),
      })
      .where(eq(households.id, req.params.id))
      .returning();

    res.json({ household: updated });
  });

  return router;
}
