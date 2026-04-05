import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import {
  families,
  familyMembers,
  agents,
  constitutions,
  constitutionRules,
  onboardingState,
} from "@carsonos/db";
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

export function createOnboardingRoutes(db: Db): Router {
  const router = Router();

  // POST / — process full onboarding in a transaction
  router.post("/", async (req, res) => {
    const { familyName, timezone, members, rules } = req.body;

    if (!familyName || !members || !Array.isArray(members) || members.length === 0) {
      res.status(400).json({
        error: "familyName and at least one member are required",
      });
      return;
    }

    const validRoles: MemberRole[] = ["parent", "student", "child"];
    for (const m of members) {
      if (!m.name || !m.role || m.age === undefined) {
        res.status(400).json({ error: "Each member needs name, role, and age" });
        return;
      }
      if (!validRoles.includes(m.role)) {
        res
          .status(400)
          .json({ error: `Invalid role "${m.role}". Must be: ${validRoles.join(", ")}` });
        return;
      }
    }

    // SQLite transactions are synchronous with better-sqlite3/Drizzle
    // So we run inserts outside a manual transaction wrapper
    // (Drizzle's SQLite driver handles this correctly with individual inserts)

    // 1. Create family
    const [family] = db
      .insert(families)
      .values({
        name: familyName,
        timezone: timezone ?? "America/New_York",
      })
      .returning()
      .all();

    // 2. Create members + agents
    const createdMembers = [];
    const createdAgents = [];

    for (const m of members) {
      const [member] = db
        .insert(familyMembers)
        .values({
          familyId: family.id,
          name: m.name,
          role: m.role,
          age: m.age,
          telegramUserId: m.telegramUserId ?? null,
        })
        .returning()
        .all();

      createdMembers.push(member);

      const model = DEFAULT_MODELS[m.role] ?? DEFAULT_MODELS.child;
      const budget = DEFAULT_BUDGETS[m.role] ?? DEFAULT_BUDGETS.child;

      const [agent] = db
        .insert(agents)
        .values({
          familyId: family.id,
          memberId: member.id,
          model,
          budgetMonthlyCents: budget,
        })
        .returning()
        .all();

      createdAgents.push(agent);
    }

    // 3. Create constitution + rules
    let constitution = null;
    let createdRules: any[] = [];

    if (rules && Array.isArray(rules) && rules.length > 0) {
      [constitution] = db
        .insert(constitutions)
        .values({
          familyId: family.id,
          version: 1,
          content: "Constitution v1",
          isActive: true,
        })
        .returning()
        .all();

      createdRules = db
        .insert(constitutionRules)
        .values(
          rules.map((rule: any, idx: number) => ({
            constitutionId: constitution!.id,
            familyId: family.id,
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
        .returning()
        .all();
    }

    // 4. Record onboarding state
    db.insert(onboardingState).values({
      familyId: family.id,
      step: rules && rules.length > 0 ? 3 : 2,
      answers: { familyName, timezone, memberCount: members.length, ruleCount: rules?.length ?? 0 },
    }).run();

    res.status(201).json({
      family,
      members: createdMembers,
      agents: createdAgents,
      constitution,
      rules: createdRules,
    });
  });

  // GET /state/:familyId — return onboarding progress
  router.get("/state/:familyId", async (req, res) => {
    const state = await db
      .select()
      .from(onboardingState)
      .where(eq(onboardingState.familyId, req.params.familyId))
      .get();

    if (!state) {
      res.json({ completed: false, step: 0, answers: {} });
      return;
    }

    res.json({
      completed: state.step >= 3,
      step: state.step,
      answers: state.answers,
      updatedAt: state.updatedAt,
    });
  });

  return router;
}
