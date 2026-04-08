/**
 * Household routes -- CRUD for the household entity.
 *
 * MVP: single household. GET /current returns the first (only) one.
 */

import { Router } from "express";
import { eq, and } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { households, familyMembers, staffAgents, constitutions, staffAssignments } from "@carsonos/db";

export function createHouseholdRoutes(db: Db): Router {
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
    const membersWithProfiles = members.filter((m) => m.profileContent !== null);
    const agentsWithSoul = familyStaff.filter((s) => s.soulContent !== null);
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
        { key: "telegram", label: "Connect Telegram bots", required: false, complete: agentsWithTelegram.length === familyStaff.length && familyStaff.length > 0 },
        { key: "assignments", label: "Assign agents to family members", required: false, complete: membersWithAssignments.size === nonParentMembers.length && nonParentMembers.length > 0 },
      ],
      completedCount: 0,
      totalCount: 6,
    };
    checklist.completedCount = checklist.items.filter((i) => i.complete).length;

    res.json({
      household,
      members,
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
