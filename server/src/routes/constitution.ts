/**
 * Constitution routes -- manage the household constitution + clauses.
 *
 * Version management: updating the document creates a new version
 * and deactivates the old one.
 */

import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { constitutions, constitutionClauses, households } from "@carsonos/db";
import type { ConstitutionEngine } from "../services/constitution-engine.js";
import type { InterviewEngine } from "../services/interview.js";

export interface ConstitutionRouteDeps {
  db: Db;
  constitutionEngine: ConstitutionEngine;
  interviewEngine?: InterviewEngine;
}

export function createConstitutionRoutes(deps: ConstitutionRouteDeps): Router {
  const { db, constitutionEngine, interviewEngine } = deps;
  const router = Router();

  // Helper: get the single household ID (MVP: one household)
  async function getHouseholdId(): Promise<string | null> {
    const household = await db.select().from(households).limit(1).get();
    return household?.id ?? null;
  }

  // GET / -- active constitution with clauses
  router.get("/", async (_req, res) => {
    const householdId = await getHouseholdId();
    if (!householdId) {
      res.status(404).json({ error: "No household found" });
      return;
    }

    const constitution = await db
      .select()
      .from(constitutions)
      .where(
        and(
          eq(constitutions.householdId, householdId),
          eq(constitutions.isActive, true),
        ),
      )
      .orderBy(desc(constitutions.version))
      .get();

    if (!constitution) {
      res.status(404).json({ error: "No active constitution found" });
      return;
    }

    const clauses = await db
      .select()
      .from(constitutionClauses)
      .where(eq(constitutionClauses.constitutionId, constitution.id))
      .orderBy(constitutionClauses.sortOrder)
      .all();

    res.json({ constitution, clauses });
  });

  // PUT /document -- update the constitution document (creates new version)
  router.put("/document", async (req, res) => {
    const { document } = req.body;
    const householdId = await getHouseholdId();

    if (!householdId) {
      res.status(404).json({ error: "No household found" });
      return;
    }

    if (!document || typeof document !== "string") {
      res.status(400).json({ error: "document (string) is required" });
      return;
    }

    // Deactivate current constitution
    const current = await db
      .select()
      .from(constitutions)
      .where(
        and(
          eq(constitutions.householdId, householdId),
          eq(constitutions.isActive, true),
        ),
      )
      .get();

    const newVersion = current ? current.version + 1 : 1;

    if (current) {
      await db
        .update(constitutions)
        .set({ isActive: false })
        .where(eq(constitutions.id, current.id));
    }

    // Create new constitution version
    const [constitution] = await db
      .insert(constitutions)
      .values({
        householdId,
        version: newVersion,
        document,
        isActive: true,
      })
      .returning();

    // Copy existing clauses to new version if upgrading
    if (current) {
      const existingClauses = await db
        .select()
        .from(constitutionClauses)
        .where(eq(constitutionClauses.constitutionId, current.id))
        .all();

      if (existingClauses.length > 0) {
        await db.insert(constitutionClauses).values(
          existingClauses.map((c) => ({
            constitutionId: constitution.id,
            householdId,
            category: c.category,
            clauseText: c.clauseText,
            enforcementLevel: c.enforcementLevel,
            evaluationType: c.evaluationType,
            evaluationConfig: c.evaluationConfig,
            appliesToRoles: c.appliesToRoles,
            appliesToAgents: c.appliesToAgents,
            appliesToMinAge: c.appliesToMinAge,
            appliesToMaxAge: c.appliesToMaxAge,
            sortOrder: c.sortOrder,
          })),
        );
      }
    }

    // Invalidate engine cache
    constitutionEngine.invalidateCache(householdId);

    res.json({ constitution });
  });

  // GET /versions -- version history
  router.get("/versions", async (_req, res) => {
    const householdId = await getHouseholdId();
    if (!householdId) {
      res.status(404).json({ error: "No household found" });
      return;
    }

    const versions = await db
      .select()
      .from(constitutions)
      .where(eq(constitutions.householdId, householdId))
      .orderBy(desc(constitutions.version))
      .all();

    res.json({ versions });
  });

  // -- Interview endpoints (rebuild constitution via interview) --------

  // GET /interview -- current constitution interview state
  router.get("/interview", async (_req, res) => {
    if (!interviewEngine) {
      res.status(501).json({ error: "Interview engine not configured" });
      return;
    }

    const householdId = await getHouseholdId();
    if (!householdId) {
      res.status(404).json({ error: "No household found" });
      return;
    }

    try {
      const state = await interviewEngine.getOrCreateState(householdId);
      res.json({
        phase: state.phase,
        messageCount: (state.interviewMessages ?? []).length,
        messages: (state.interviewMessages ?? []).map(
          (m: { role: string; content: string }) => ({ role: m.role, content: m.content }),
        ),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to get interview state";
      res.status(500).json({ error: msg });
    }
  });

  // POST /interview -- send message to constitution interview
  router.post("/interview", async (req, res) => {
    if (!interviewEngine) {
      res.status(501).json({ error: "Interview engine not configured" });
      return;
    }

    const { message } = req.body;
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message (string) is required" });
      return;
    }

    const householdId = await getHouseholdId();
    if (!householdId) {
      res.status(404).json({ error: "No household found" });
      return;
    }

    try {
      const result = await interviewEngine.processMessage(householdId, message);

      // If a constitution document was generated, save it
      if (result.constitutionDocument) {
        // Deactivate current constitution
        const current = await db
          .select()
          .from(constitutions)
          .where(
            and(
              eq(constitutions.householdId, householdId),
              eq(constitutions.isActive, true),
            ),
          )
          .get();

        const newVersion = current ? current.version + 1 : 1;

        if (current) {
          await db
            .update(constitutions)
            .set({ isActive: false })
            .where(eq(constitutions.id, current.id));
        }

        await db
          .insert(constitutions)
          .values({
            householdId,
            version: newVersion,
            document: result.constitutionDocument,
            isActive: true,
          });

        constitutionEngine.invalidateCache(householdId);
      }

      res.json({
        response: result.response,
        phase: result.phase,
        constitutionDocument: result.constitutionDocument,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Interview failed";
      res.status(500).json({ error: msg });
    }
  });

  // -- Clause CRUD ---------------------------------------------------

  // POST /clauses -- add a clause to the active constitution
  router.post("/clauses", async (req, res) => {
    const householdId = await getHouseholdId();
    if (!householdId) {
      res.status(404).json({ error: "No household found" });
      return;
    }

    const constitution = await db
      .select()
      .from(constitutions)
      .where(
        and(
          eq(constitutions.householdId, householdId),
          eq(constitutions.isActive, true),
        ),
      )
      .get();

    if (!constitution) {
      res.status(404).json({ error: "No active constitution found" });
      return;
    }

    const clause = req.body;
    if (!clause.category || !clause.clauseText) {
      res
        .status(400)
        .json({ error: "category and clauseText are required" });
      return;
    }

    const [inserted] = await db
      .insert(constitutionClauses)
      .values({
        constitutionId: constitution.id,
        householdId,
        category: clause.category,
        clauseText: clause.clauseText,
        enforcementLevel: clause.enforcementLevel ?? "soft",
        evaluationType: clause.evaluationType ?? "behavioral",
        evaluationConfig: clause.evaluationConfig ?? null,
        appliesToRoles: clause.appliesToRoles ?? null,
        appliesToAgents: clause.appliesToAgents ?? null,
        appliesToMinAge: clause.appliesToMinAge ?? null,
        appliesToMaxAge: clause.appliesToMaxAge ?? null,
        sortOrder: clause.sortOrder ?? 0,
      })
      .returning();

    // Invalidate engine cache
    constitutionEngine.invalidateCache(householdId);

    res.status(201).json({ clause: inserted });
  });

  // PUT /clauses/:id -- update a clause
  router.put("/clauses/:id", async (req, res) => {
    const householdId = await getHouseholdId();
    if (!householdId) {
      res.status(404).json({ error: "No household found" });
      return;
    }

    const existing = await db
      .select()
      .from(constitutionClauses)
      .where(
        and(
          eq(constitutionClauses.id, req.params.id),
          eq(constitutionClauses.householdId, householdId),
        ),
      )
      .get();

    if (!existing) {
      res.status(404).json({ error: "Clause not found" });
      return;
    }

    const {
      category,
      clauseText,
      enforcementLevel,
      evaluationType,
      evaluationConfig,
      appliesToRoles,
      appliesToAgents,
      appliesToMinAge,
      appliesToMaxAge,
      sortOrder,
    } = req.body;

    const [updated] = await db
      .update(constitutionClauses)
      .set({
        ...(category !== undefined && { category }),
        ...(clauseText !== undefined && { clauseText }),
        ...(enforcementLevel !== undefined && { enforcementLevel }),
        ...(evaluationType !== undefined && { evaluationType }),
        ...(evaluationConfig !== undefined && { evaluationConfig }),
        ...(appliesToRoles !== undefined && { appliesToRoles }),
        ...(appliesToAgents !== undefined && { appliesToAgents }),
        ...(appliesToMinAge !== undefined && { appliesToMinAge }),
        ...(appliesToMaxAge !== undefined && { appliesToMaxAge }),
        ...(sortOrder !== undefined && { sortOrder }),
      })
      .where(eq(constitutionClauses.id, req.params.id))
      .returning();

    // Invalidate engine cache
    constitutionEngine.invalidateCache(householdId);

    res.json({ clause: updated });
  });

  // DELETE /clauses/:id -- delete a clause
  router.delete("/clauses/:id", async (req, res) => {
    const householdId = await getHouseholdId();
    if (!householdId) {
      res.status(404).json({ error: "No household found" });
      return;
    }

    const existing = await db
      .select()
      .from(constitutionClauses)
      .where(
        and(
          eq(constitutionClauses.id, req.params.id),
          eq(constitutionClauses.householdId, householdId),
        ),
      )
      .get();

    if (!existing) {
      res.status(404).json({ error: "Clause not found" });
      return;
    }

    await db
      .delete(constitutionClauses)
      .where(eq(constitutionClauses.id, req.params.id));

    // Invalidate engine cache
    constitutionEngine.invalidateCache(householdId);

    res.json({ deleted: true });
  });

  return router;
}
