/**
 * Activity routes -- merged activity log + policy events.
 *
 * Returns recent activity sorted by time, combining both
 * general activity log entries and policy enforcement events.
 */

import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import {
  activityLog,
  policyEvents,
  constitutionClauses,
  households,
} from "@carsonos/db";

export function createActivityRoutes(db: Db): Router {
  const router = Router();

  // GET / -- recent activity log + policy events merged
  router.get("/", async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    // MVP: single household
    const household = await db.select().from(households).limit(1).get();
    if (!household) {
      res.json({ activity: [] });
      return;
    }

    const householdId = household.id;

    // Fetch both streams in parallel
    const [activityEntries, policyEntries] = await Promise.all([
      db
        .select()
        .from(activityLog)
        .where(eq(activityLog.householdId, householdId))
        .orderBy(desc(activityLog.createdAt))
        .limit(limit)
        .all(),

      db
        .select({
          id: policyEvents.id,
          householdId: policyEvents.householdId,
          agentId: policyEvents.agentId,
          conversationId: policyEvents.conversationId,
          taskId: policyEvents.taskId,
          clauseId: policyEvents.clauseId,
          eventType: policyEvents.eventType,
          context: policyEvents.context,
          createdAt: policyEvents.createdAt,
          clauseText: constitutionClauses.clauseText,
          clauseCategory: constitutionClauses.category,
          enforcementLevel: constitutionClauses.enforcementLevel,
        })
        .from(policyEvents)
        .leftJoin(
          constitutionClauses,
          eq(constitutionClauses.id, policyEvents.clauseId),
        )
        .where(eq(policyEvents.householdId, householdId))
        .orderBy(desc(policyEvents.createdAt))
        .limit(limit)
        .all(),
    ]);

    // Normalize into a common shape and merge
    const normalized = [
      ...activityEntries.map((a) => ({
        id: a.id,
        type: "activity" as const,
        action: a.action,
        agentId: a.agentId,
        details: a.details,
        createdAt: a.createdAt,
      })),
      ...policyEntries.map((p) => ({
        id: p.id,
        type: "policy" as const,
        action: p.eventType,
        agentId: p.agentId,
        details: {
          conversationId: p.conversationId,
          taskId: p.taskId,
          clauseId: p.clauseId,
          clauseText: p.clauseText,
          clauseCategory: p.clauseCategory,
          enforcementLevel: p.enforcementLevel,
          context: p.context,
        },
        createdAt: p.createdAt,
      })),
    ];

    // Sort by createdAt descending, then take the top `limit`
    normalized.sort((a, b) => {
      const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : Number(a.createdAt);
      const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : Number(b.createdAt);
      return bTime - aTime;
    });

    res.json({ activity: normalized.slice(0, limit) });
  });

  return router;
}
