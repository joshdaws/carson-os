import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { families, familyMembers, agents } from "@carsonos/db";

export function createFamilyRoutes(db: Db): Router {
  const router = Router();

  // Helper: build family response with members + agent info
  async function familyWithMembers(familyId: string) {
    const family = await db
      .select()
      .from(families)
      .where(eq(families.id, familyId))
      .get();

    if (!family) return null;

    const members = await db
      .select({
        id: familyMembers.id,
        name: familyMembers.name,
        role: familyMembers.role,
        age: familyMembers.age,
        telegramUserId: familyMembers.telegramUserId,
        agentId: agents.id,
        agentStatus: agents.status,
      })
      .from(familyMembers)
      .leftJoin(agents, eq(agents.memberId, familyMembers.id))
      .where(eq(familyMembers.familyId, familyId))
      .all();

    return {
      family,
      members: members.map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        age: m.age,
        telegramUserId: m.telegramUserId,
        agent: m.agentId ? { id: m.agentId, status: m.agentStatus } : null,
      })),
    };
  }

  // GET / — return the first family (MVP: single family)
  router.get("/", async (_req, res) => {
    const family = await db.select().from(families).limit(1).get();

    if (!family) {
      res.status(404).json({ error: "No family found" });
      return;
    }

    const result = await familyWithMembers(family.id);
    res.json(result);
  });

  // GET /current — convenience alias
  router.get("/current", async (_req, res) => {
    const family = await db.select().from(families).limit(1).get();

    if (!family) {
      res.status(404).json({ error: "No family found" });
      return;
    }

    const result = await familyWithMembers(family.id);
    res.json(result);
  });

  // GET /:id — return family by ID
  router.get("/:id", async (req, res) => {
    const result = await familyWithMembers(req.params.id);

    if (!result) {
      res.status(404).json({ error: "Family not found" });
      return;
    }

    res.json(result);
  });

  // POST / — create family
  router.post("/", async (req, res) => {
    const { name, timezone } = req.body;

    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const [family] = await db
      .insert(families)
      .values({ name, timezone: timezone ?? "America/New_York" })
      .returning();

    res.status(201).json({ family });
  });

  // PATCH /:id — update family
  router.patch("/:id", async (req, res) => {
    const { name, timezone } = req.body;
    const existing = await db
      .select()
      .from(families)
      .where(eq(families.id, req.params.id))
      .get();

    if (!existing) {
      res.status(404).json({ error: "Family not found" });
      return;
    }

    const [updated] = await db
      .update(families)
      .set({
        ...(name !== undefined && { name }),
        ...(timezone !== undefined && { timezone }),
        updatedAt: new Date(),
      })
      .where(eq(families.id, req.params.id))
      .returning();

    res.json({ family: updated });
  });

  return router;
}
