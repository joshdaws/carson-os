/**
 * Household routes -- CRUD for the household entity.
 *
 * MVP: single household. GET /current returns the first (only) one.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { households, familyMembers, staffAgents } from "@carsonos/db";

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

    res.json({
      household,
      members,
      memberCount: members.length,
      staffCount: staff.length,
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
