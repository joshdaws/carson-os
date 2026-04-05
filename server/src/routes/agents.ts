import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { agents, familyMembers, conversations, policyEvents, constitutionRules } from "@carsonos/db";

export function createAgentRoutes(db: Db): Router {
  const router = Router();

  // GET /:id — return agent with member info, recent conversations, budget usage
  router.get("/:id", async (req, res) => {
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, req.params.id))
      .get();

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const member = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, agent.memberId))
      .get();

    const recentConversations = await db
      .select()
      .from(conversations)
      .where(eq(conversations.agentId, agent.id))
      .orderBy(desc(conversations.startedAt))
      .limit(10)
      .all();

    const budgetRemaining = agent.budgetMonthlyCents - agent.spentMonthlyCents;

    res.json({
      agent,
      member,
      recentConversations,
      budget: {
        monthlyCents: agent.budgetMonthlyCents,
        spentCents: agent.spentMonthlyCents,
        remainingCents: budgetRemaining,
      },
    });
  });

  // PATCH /:id — update agent
  router.patch("/:id", async (req, res) => {
    const { soulContent, model, status, budgetMonthlyCents } = req.body;

    const existing = await db
      .select()
      .from(agents)
      .where(eq(agents.id, req.params.id))
      .get();

    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const [updated] = await db
      .update(agents)
      .set({
        ...(soulContent !== undefined && { soulContent }),
        ...(model !== undefined && { model }),
        ...(status !== undefined && { status }),
        ...(budgetMonthlyCents !== undefined && { budgetMonthlyCents }),
      })
      .where(eq(agents.id, req.params.id))
      .returning();

    res.json({ agent: updated });
  });

  // GET /:id/conversations — list conversations for this agent
  router.get("/:id/conversations", async (req, res) => {
    const agentConversations = await db
      .select()
      .from(conversations)
      .where(eq(conversations.agentId, req.params.id))
      .orderBy(desc(conversations.startedAt))
      .all();

    res.json({ conversations: agentConversations });
  });

  // GET /:id/policy-events — policy events for this agent
  router.get("/:id/policy-events", async (req, res) => {
    const events = await db
      .select({
        id: policyEvents.id,
        familyId: policyEvents.familyId,
        agentId: policyEvents.agentId,
        conversationId: policyEvents.conversationId,
        ruleId: policyEvents.ruleId,
        eventType: policyEvents.eventType,
        context: policyEvents.context,
        createdAt: policyEvents.createdAt,
        ruleText: constitutionRules.ruleText,
        ruleCategory: constitutionRules.category,
      })
      .from(policyEvents)
      .leftJoin(constitutionRules, eq(constitutionRules.id, policyEvents.ruleId))
      .where(eq(policyEvents.agentId, req.params.id))
      .orderBy(desc(policyEvents.createdAt))
      .all();

    res.json({ policyEvents: events });
  });

  return router;
}
