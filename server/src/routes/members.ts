import { Router } from "express";
import { eq, and } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { familyMembers, agents } from "@carsonos/db";
import type { MemberRole } from "@carsonos/shared";

const DEFAULT_MODELS: Record<string, string> = {
  parent: "claude-sonnet-4-20250514",
  student: "claude-haiku-4-5-20251001",
  child: "claude-haiku-4-5-20251001",
};

const DEFAULT_BUDGETS: Record<string, number> = {
  parent: 2000,
  student: 500,
  child: 200,
};

export function createMemberRoutes(db: Db): Router {
  const router = Router();

  // GET /:familyId/members — list members for a family
  router.get("/:familyId/members", async (req, res) => {
    const members = await db
      .select({
        id: familyMembers.id,
        familyId: familyMembers.familyId,
        name: familyMembers.name,
        role: familyMembers.role,
        age: familyMembers.age,
        telegramUserId: familyMembers.telegramUserId,
        createdAt: familyMembers.createdAt,
        agentId: agents.id,
        agentStatus: agents.status,
        agentModel: agents.model,
      })
      .from(familyMembers)
      .leftJoin(agents, eq(agents.memberId, familyMembers.id))
      .where(eq(familyMembers.familyId, req.params.familyId))
      .all();

    res.json({
      members: members.map((m) => ({
        id: m.id,
        familyId: m.familyId,
        name: m.name,
        role: m.role,
        age: m.age,
        telegramUserId: m.telegramUserId,
        createdAt: m.createdAt,
        agent: m.agentId
          ? { id: m.agentId, status: m.agentStatus, model: m.agentModel }
          : null,
      })),
    });
  });

  // POST /:familyId/members — create member + auto-create agent
  router.post("/:familyId/members", async (req, res) => {
    const { name, role, age, telegramUserId } = req.body;
    const { familyId } = req.params;

    if (!name || !role || age === undefined) {
      res.status(400).json({ error: "name, role, and age are required" });
      return;
    }

    const validRoles: MemberRole[] = ["parent", "student", "child"];
    if (!validRoles.includes(role)) {
      res.status(400).json({ error: `role must be one of: ${validRoles.join(", ")}` });
      return;
    }

    const [member] = await db
      .insert(familyMembers)
      .values({
        familyId,
        name,
        role,
        age,
        telegramUserId: telegramUserId ?? null,
      })
      .returning();

    // Auto-create agent for this member
    const model = DEFAULT_MODELS[role] ?? DEFAULT_MODELS.child;
    const budget = DEFAULT_BUDGETS[role] ?? DEFAULT_BUDGETS.child;

    const [agent] = await db
      .insert(agents)
      .values({
        familyId,
        memberId: member.id,
        model,
        budgetMonthlyCents: budget,
      })
      .returning();

    res.status(201).json({ member, agent });
  });

  // PATCH /:familyId/members/:id — update member
  router.patch("/:familyId/members/:id", async (req, res) => {
    const { name, role, age, telegramUserId } = req.body;

    const existing = await db
      .select()
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.id, req.params.id),
          eq(familyMembers.familyId, req.params.familyId)
        )
      )
      .get();

    if (!existing) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    const [updated] = await db
      .update(familyMembers)
      .set({
        ...(name !== undefined && { name }),
        ...(role !== undefined && { role }),
        ...(age !== undefined && { age }),
        ...(telegramUserId !== undefined && { telegramUserId }),
      })
      .where(eq(familyMembers.id, req.params.id))
      .returning();

    res.json({ member: updated });
  });

  // DELETE /:familyId/members/:id — delete member + their agent
  router.delete("/:familyId/members/:id", async (req, res) => {
    const existing = await db
      .select()
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.id, req.params.id),
          eq(familyMembers.familyId, req.params.familyId)
        )
      )
      .get();

    if (!existing) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    // Delete agent first (FK constraint)
    await db
      .delete(agents)
      .where(eq(agents.memberId, req.params.id));

    // Delete member
    await db
      .delete(familyMembers)
      .where(eq(familyMembers.id, req.params.id));

    res.json({ deleted: true });
  });

  return router;
}
