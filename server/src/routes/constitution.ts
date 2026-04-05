import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { constitutions, constitutionRules } from "@carsonos/db";

export function createConstitutionRoutes(db: Db): Router {
  const router = Router();

  // GET /:familyId/constitution — return active constitution with its rules
  router.get("/:familyId/constitution", async (req, res) => {
    const constitution = await db
      .select()
      .from(constitutions)
      .where(
        and(
          eq(constitutions.familyId, req.params.familyId),
          eq(constitutions.isActive, true)
        )
      )
      .orderBy(desc(constitutions.version))
      .get();

    if (!constitution) {
      res.status(404).json({ error: "No active constitution found" });
      return;
    }

    const rules = await db
      .select()
      .from(constitutionRules)
      .where(eq(constitutionRules.constitutionId, constitution.id))
      .orderBy(constitutionRules.sortOrder)
      .all();

    res.json({ constitution, rules });
  });

  // PUT /:familyId/constitution/rules — bulk update rules (creates new version)
  router.put("/:familyId/constitution/rules", async (req, res) => {
    const { rules } = req.body;
    const { familyId } = req.params;

    if (!Array.isArray(rules) || rules.length === 0) {
      res.status(400).json({ error: "rules array is required" });
      return;
    }

    // Deactivate current constitution
    const current = await db
      .select()
      .from(constitutions)
      .where(
        and(
          eq(constitutions.familyId, familyId),
          eq(constitutions.isActive, true)
        )
      )
      .get();

    const newVersion = current ? current.version + 1 : 1;

    if (current) {
      await db
        .update(constitutions)
        .set({ isActive: false })
        .where(eq(constitutions.id, current.id));
    }

    // Create new constitution
    const [constitution] = await db
      .insert(constitutions)
      .values({
        familyId,
        version: newVersion,
        content: `Constitution v${newVersion}`,
        isActive: true,
      })
      .returning();

    // Insert all rules
    const insertedRules = await db
      .insert(constitutionRules)
      .values(
        rules.map((rule: any, idx: number) => ({
          constitutionId: constitution.id,
          familyId,
          category: rule.category,
          ruleText: rule.ruleText,
          enforcementLevel: rule.enforcementLevel,
          evaluationType: rule.evaluationType,
          evaluationConfig: rule.evaluationConfig ?? null,
          appliesToRoles: rule.appliesToRoles ?? null,
          appliesToMinAge: rule.appliesToMinAge ?? null,
          appliesToMaxAge: rule.appliesToMaxAge ?? null,
          sortOrder: rule.sortOrder ?? idx,
        }))
      )
      .returning();

    res.status(201).json({ constitution, rules: insertedRules });
  });

  // POST /:familyId/constitution/rules — add a single rule to active constitution
  router.post("/:familyId/constitution/rules", async (req, res) => {
    const { familyId } = req.params;
    const rule = req.body;

    if (!rule.category || !rule.ruleText || !rule.enforcementLevel || !rule.evaluationType) {
      res.status(400).json({
        error: "category, ruleText, enforcementLevel, and evaluationType are required",
      });
      return;
    }

    const constitution = await db
      .select()
      .from(constitutions)
      .where(
        and(
          eq(constitutions.familyId, familyId),
          eq(constitutions.isActive, true)
        )
      )
      .get();

    if (!constitution) {
      res.status(404).json({ error: "No active constitution found" });
      return;
    }

    const [inserted] = await db
      .insert(constitutionRules)
      .values({
        constitutionId: constitution.id,
        familyId,
        category: rule.category,
        ruleText: rule.ruleText,
        enforcementLevel: rule.enforcementLevel,
        evaluationType: rule.evaluationType,
        evaluationConfig: rule.evaluationConfig ?? null,
        appliesToRoles: rule.appliesToRoles ?? null,
        appliesToMinAge: rule.appliesToMinAge ?? null,
        appliesToMaxAge: rule.appliesToMaxAge ?? null,
        sortOrder: rule.sortOrder ?? 0,
      })
      .returning();

    res.status(201).json({ rule: inserted });
  });

  // PATCH /:familyId/constitution/rules/:ruleId — update a single rule
  router.patch("/:familyId/constitution/rules/:ruleId", async (req, res) => {
    const existing = await db
      .select()
      .from(constitutionRules)
      .where(
        and(
          eq(constitutionRules.id, req.params.ruleId),
          eq(constitutionRules.familyId, req.params.familyId)
        )
      )
      .get();

    if (!existing) {
      res.status(404).json({ error: "Rule not found" });
      return;
    }

    const {
      category,
      ruleText,
      enforcementLevel,
      evaluationType,
      evaluationConfig,
      appliesToRoles,
      appliesToMinAge,
      appliesToMaxAge,
      sortOrder,
    } = req.body;

    const [updated] = await db
      .update(constitutionRules)
      .set({
        ...(category !== undefined && { category }),
        ...(ruleText !== undefined && { ruleText }),
        ...(enforcementLevel !== undefined && { enforcementLevel }),
        ...(evaluationType !== undefined && { evaluationType }),
        ...(evaluationConfig !== undefined && { evaluationConfig }),
        ...(appliesToRoles !== undefined && { appliesToRoles }),
        ...(appliesToMinAge !== undefined && { appliesToMinAge }),
        ...(appliesToMaxAge !== undefined && { appliesToMaxAge }),
        ...(sortOrder !== undefined && { sortOrder }),
      })
      .where(eq(constitutionRules.id, req.params.ruleId))
      .returning();

    res.json({ rule: updated });
  });

  // DELETE /:familyId/constitution/rules/:ruleId — delete a rule
  router.delete("/:familyId/constitution/rules/:ruleId", async (req, res) => {
    const existing = await db
      .select()
      .from(constitutionRules)
      .where(
        and(
          eq(constitutionRules.id, req.params.ruleId),
          eq(constitutionRules.familyId, req.params.familyId)
        )
      )
      .get();

    if (!existing) {
      res.status(404).json({ error: "Rule not found" });
      return;
    }

    await db
      .delete(constitutionRules)
      .where(eq(constitutionRules.id, req.params.ruleId));

    res.json({ deleted: true });
  });

  return router;
}
