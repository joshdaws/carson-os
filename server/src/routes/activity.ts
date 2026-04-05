import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { activityLog, policyEvents, constitutionRules } from "@carsonos/db";

export function createActivityRoutes(db: Db): Router {
  const router = Router();

  // GET /:familyId/activity — activity log entries, paginated
  router.get("/:familyId/activity", async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    const entries = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.familyId, req.params.familyId))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit)
      .offset(offset)
      .all();

    res.json({
      activity: entries,
      pagination: { limit, offset, count: entries.length },
    });
  });

  // GET /:familyId/policy-events — policy events, paginated, with rule text
  router.get("/:familyId/policy-events", async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

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
        enforcementLevel: constitutionRules.enforcementLevel,
      })
      .from(policyEvents)
      .leftJoin(constitutionRules, eq(constitutionRules.id, policyEvents.ruleId))
      .where(eq(policyEvents.familyId, req.params.familyId))
      .orderBy(desc(policyEvents.createdAt))
      .limit(limit)
      .offset(offset)
      .all();

    res.json({
      policyEvents: events,
      pagination: { limit, offset, count: events.length },
    });
  });

  return router;
}
