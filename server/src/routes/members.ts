/**
 * Family member routes -- CRUD for family members within a household.
 *
 * Mounted under /api/households so all paths are relative to /:householdId.
 */

import { Router } from "express";
import { eq, and } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { familyMembers, staffAssignments } from "@carsonos/db";
import type { MemberRole } from "@carsonos/shared";

export function createMemberRoutes(db: Db): Router {
  const router = Router();

  // GET /:householdId/members -- list members for a household
  router.get("/:householdId/members", async (req, res) => {
    const members = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.householdId, req.params.householdId))
      .all();

    res.json({ members });
  });

  // POST /:householdId/members -- create member
  router.post("/:householdId/members", async (req, res) => {
    const { name, role, age, telegramUserId, memoryDir, signalNumber, signalUuid } = req.body;
    const { householdId } = req.params;

    if (!name || !role || age === undefined) {
      res.status(400).json({ error: "name, role, and age are required" });
      return;
    }

    const validRoles: MemberRole[] = ["parent", "kid"];
    if (!validRoles.includes(role)) {
      res
        .status(400)
        .json({ error: `role must be one of: ${validRoles.join(", ")}` });
      return;
    }

    try {
      const [member] = await db
        .insert(familyMembers)
        .values({
          householdId,
          name,
          role,
          age,
          telegramUserId: telegramUserId ?? null,
          signalNumber: signalNumber ?? null,
          signalUuid: signalUuid ?? null,
          memoryDir: memoryDir ?? null,
        })
        .returning();

      res.status(201).json({ member });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint")) {
        res.status(409).json({ error: "That Telegram ID, Signal number, or Signal UUID is already assigned to another member." });
      } else {
        throw err;
      }
    }
  });

  // PUT /:householdId/members/:id -- update member
  router.put("/:householdId/members/:id", async (req, res) => {
    const { name, role, age, telegramUserId, memoryDir, signalNumber, signalUuid } = req.body;

    const existing = await db
      .select()
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.id, req.params.id),
          eq(familyMembers.householdId, req.params.householdId),
        ),
      )
      .get();

    if (!existing) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    try {
      const [updated] = await db
        .update(familyMembers)
        .set({
          ...(name !== undefined && { name }),
          ...(role !== undefined && { role }),
          ...(age !== undefined && { age }),
          ...(telegramUserId !== undefined && { telegramUserId }),
          ...(signalNumber !== undefined && { signalNumber }),
          ...(signalUuid !== undefined && { signalUuid }),
          ...(memoryDir !== undefined && { memoryDir }),
        })
        .where(eq(familyMembers.id, req.params.id))
        .returning();

      res.json({ member: updated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint")) {
        res.status(409).json({ error: "That Telegram ID, Signal number, or Signal UUID is already assigned to another member." });
      } else {
        throw err;
      }
    }
  });

  // DELETE /:householdId/members/:id -- delete member
  router.delete("/:householdId/members/:id", async (req, res) => {
    const existing = await db
      .select()
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.id, req.params.id),
          eq(familyMembers.householdId, req.params.householdId),
        ),
      )
      .get();

    if (!existing) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    // Delete assignments first (FK constraint)
    await db
      .delete(staffAssignments)
      .where(eq(staffAssignments.memberId, req.params.id));

    // Delete member
    await db
      .delete(familyMembers)
      .where(eq(familyMembers.id, req.params.id));

    res.json({ deleted: true });
  });

  return router;
}
