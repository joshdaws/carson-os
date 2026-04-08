/**
 * Onboarding routes -- conversational interview + household setup.
 *
 * The interview flow is handled by the InterviewEngine.
 * The /complete endpoint finalizes onboarding by creating
 * household, members, staff, and constitution from interview data.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import {
  households,
  familyMembers,
  staffAgents,
  constitutions,
  constitutionClauses,
  onboardingState,
} from "@carsonos/db";
import type { MemberRole } from "@carsonos/shared";
import type { InterviewEngine } from "../services/interview.js";

export interface OnboardingRouteDeps {
  db: Db;
  interviewEngine: InterviewEngine;
}

export function createOnboardingRoutes(deps: OnboardingRouteDeps): Router {
  const { db, interviewEngine } = deps;
  const router = Router();

  // GET /state -- get current onboarding state
  router.get("/state", async (_req, res) => {
    // Find the first household (MVP: single household)
    const household = await db.select().from(households).limit(1).get();

    if (!household) {
      // No household yet -- return blank state
      res.json({
        phase: "interview",
        hasHousehold: false,
        interviewMessages: [],
      });
      return;
    }

    try {
      const state = await interviewEngine.getOrCreateState(household.id);

      // Check if members already confirmed for this household
      const existingMembers = await db
        .select()
        .from(familyMembers)
        .where(eq(familyMembers.householdId, household.id))
        .all();

      res.json({
        phase: state.phase,
        hasHousehold: true,
        householdId: household.id,
        interviewMessages: state.interviewMessages,
        extractedClauses: state.extractedClauses,
        selectedStaff: state.selectedStaff,
        membersConfirmed: existingMembers.length > 0,
      });
    } catch {
      res.json({
        phase: "interview",
        hasHousehold: true,
        householdId: household.id,
        interviewMessages: [],
      });
    }
  });

  // POST /message -- send an interview message
  router.post("/message", async (req, res) => {
    const { message, householdId } = req.body;

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }

    // Get or create household for the interview
    let effectiveHouseholdId = householdId;
    if (!effectiveHouseholdId) {
      // Check for existing household
      const existing = await db.select().from(households).limit(1).get();
      if (existing) {
        effectiveHouseholdId = existing.id;
      } else {
        // Create a placeholder household for the interview
        const [household] = await db
          .insert(households)
          .values({ name: "My Family" })
          .returning();
        effectiveHouseholdId = household.id;
      }
    }

    const result = await interviewEngine.processMessage(
      effectiveHouseholdId,
      message,
    );

    res.json({
      response: result.response,
      phase: result.phase,
      interviewPhase: result.interviewPhase,
      constitutionDocument: result.constitutionDocument ?? null,
      members: result.members ?? null,
      richContent: result.richContent ?? null,
      questionNumber: result.questionNumber ?? null,
      totalQuestions: result.totalQuestions ?? null,
      householdId: effectiveHouseholdId,
    });
  });

  // POST /confirm-members -- create family members during Phase 1 (interview)
  router.post("/confirm-members", async (req, res) => {
    const { householdId, members } = req.body;

    if (!householdId) {
      res.status(400).json({ error: "householdId is required" });
      return;
    }

    if (!members || !Array.isArray(members) || members.length === 0) {
      res.status(400).json({ error: "members array is required and must not be empty" });
      return;
    }

    // Verify household exists
    const [household] = await db
      .select()
      .from(households)
      .where(eq(households.id, householdId))
      .limit(1);

    if (!household) {
      res.status(404).json({ error: "Household not found" });
      return;
    }

    // Delete any existing members for this household (re-confirmation replaces)
    await db
      .delete(familyMembers)
      .where(eq(familyMembers.householdId, householdId));

    // Create new members
    const createdMembers = [];
    for (const m of members) {
      if (!m.name || !m.role || m.age === undefined) continue;

      const validRole = (["parent", "kid"] as const).find((r) => r === m.role);
      if (!validRole) continue;

      const [member] = await db
        .insert(familyMembers)
        .values({
          householdId,
          name: m.name,
          role: validRole,
          age: m.age,
        })
        .returning();

      createdMembers.push(member);
    }

    res.status(201).json({ members: createdMembers });
  });

  // POST /complete -- finalize onboarding
  router.post("/complete", async (req, res) => {
    const {
      householdId,
      householdName,
      timezone,
      members,
      staff,
      constitutionDocument,
      clauses,
    } = req.body;

    if (!householdId) {
      res.status(400).json({ error: "householdId is required" });
      return;
    }

    // Update household name if provided
    if (householdName) {
      await db
        .update(households)
        .set({
          name: householdName,
          ...(timezone && { timezone }),
          updatedAt: new Date(),
        })
        .where(eq(households.id, householdId));
    }

    // Members are created during the interview via POST /confirm-members.
    // Fetch existing members for the response.
    const createdMembers = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.householdId, householdId))
      .all();

    // Create staff agents if provided
    const createdStaff = [];
    if (staff && Array.isArray(staff)) {
      for (const s of staff) {
        if (!s.name || !s.staffRole) continue;

        const [agent] = await db
          .insert(staffAgents)
          .values({
            householdId,
            name: s.name,
            staffRole: s.staffRole,
            specialty: s.specialty ?? null,
            soulContent: s.soulContent ?? null,
            model: s.model ?? "claude-sonnet-4-20250514",
            isHeadButler: s.isHeadButler ?? false,
            autonomyLevel: s.autonomyLevel ?? "supervised",
          })
          .returning();

        createdStaff.push(agent);
      }
    }

    // Create constitution if document or clauses provided
    let constitution = null;
    let createdClauses: any[] = [];

    if (constitutionDocument || (clauses && clauses.length > 0)) {
      [constitution] = await db
        .insert(constitutions)
        .values({
          householdId,
          version: 1,
          document: constitutionDocument ?? "",
          isActive: true,
        })
        .returning();

      if (clauses && Array.isArray(clauses) && clauses.length > 0) {
        createdClauses = await db
          .insert(constitutionClauses)
          .values(
            clauses.map((clause: any, idx: number) => ({
              constitutionId: constitution!.id,
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
              sortOrder: clause.sortOrder ?? idx,
            })),
          )
          .returning();
      }
    }

    // Update onboarding state to complete
    await db
      .update(onboardingState)
      .set({ phase: "complete", updatedAt: new Date() })
      .where(eq(onboardingState.householdId, householdId));

    res.status(201).json({
      household: { id: householdId },
      members: createdMembers,
      staff: createdStaff,
      constitution,
      clauses: createdClauses,
    });
  });

  return router;
}
