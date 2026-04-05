import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { agents, familyMembers, budgetLedger } from "@carsonos/db";

export function createBudgetRoutes(db: Db): Router {
  const router = Router();

  // GET /:familyId/budget — budget overview
  router.get("/:familyId/budget", async (req, res) => {
    const { familyId } = req.params;

    // Get all agents with their member info for this family
    const agentsWithMembers = await db
      .select({
        agentId: agents.id,
        memberId: agents.memberId,
        memberName: familyMembers.name,
        memberRole: familyMembers.role,
        model: agents.model,
        budgetMonthlyCents: agents.budgetMonthlyCents,
        spentMonthlyCents: agents.spentMonthlyCents,
      })
      .from(agents)
      .innerJoin(familyMembers, eq(familyMembers.id, agents.memberId))
      .where(eq(agents.familyId, familyId))
      .all();

    const totalBudgetCents = agentsWithMembers.reduce(
      (sum, a) => sum + a.budgetMonthlyCents,
      0
    );
    const totalSpentCents = agentsWithMembers.reduce(
      (sum, a) => sum + a.spentMonthlyCents,
      0
    );

    const memberBreakdown = agentsWithMembers.map((a) => ({
      agentId: a.agentId,
      memberId: a.memberId,
      memberName: a.memberName,
      memberRole: a.memberRole,
      model: a.model,
      budgetCents: a.budgetMonthlyCents,
      spentCents: a.spentMonthlyCents,
      remainingCents: a.budgetMonthlyCents - a.spentMonthlyCents,
    }));

    // Recent ledger entries
    const recentLedger = await db
      .select()
      .from(budgetLedger)
      .where(eq(budgetLedger.familyId, familyId))
      .orderBy(desc(budgetLedger.createdAt))
      .limit(50)
      .all();

    res.json({
      totalBudgetCents,
      totalSpentCents,
      totalRemainingCents: totalBudgetCents - totalSpentCents,
      members: memberBreakdown,
      recentLedger,
    });
  });

  return router;
}
