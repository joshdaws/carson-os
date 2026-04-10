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
  staffAssignments,
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

  // POST /complete -- simplified onboarding (3-step flow)
  router.post("/complete", async (req, res) => {
    const { householdName, members, agent } = req.body;

    if (!householdName || !members || !Array.isArray(members) || members.length === 0) {
      res.status(400).json({ error: "householdName and members are required" });
      return;
    }

    // 1. Create household
    const [household] = await db
      .insert(households)
      .values({ name: householdName })
      .returning();

    // 2. Create family members
    const createdMembers = [];
    for (const m of members) {
      if (!m.name) continue;
      const [member] = await db
        .insert(familyMembers)
        .values({
          householdId: household.id,
          name: m.name,
          role: m.role === "parent" ? "parent" : "kid",
          age: m.age || 0,
          telegramUserId: m.telegramUserId || null,
        })
        .returning();
      createdMembers.push(member);
    }

    // 3. Create the Chief of Staff agent
    const agentName = agent?.name || "Carson";
    const [chiefOfStaff] = await db
      .insert(staffAgents)
      .values({
        householdId: household.id,
        name: agentName,
        staffRole: "personal",
        visibility: "family",
        model: "claude-sonnet-4-20250514",
        status: "active",
        isHeadButler: true,
        autonomyLevel: "trusted",
        trustLevel: "full",
        telegramBotToken: agent?.botToken || null,
        roleContent: [
          `You are ${agentName}, the family's Chief of Staff.`,
          "You help every member of the household with whatever they need.",
          "You're reliable, warm, and practical. You remember things.",
          "Always be age-appropriate. Match your tone to who you're talking to.",
        ].join("\n"),
      })
      .returning();

    // 4. Create staff assignments
    if (agent?.assignTo) {
      // Assign to specific member
      const targetMember = createdMembers.find((m) => m.name === agent.assignTo);
      if (targetMember) {
        await db.insert(staffAssignments).values({
          agentId: chiefOfStaff.id,
          memberId: targetMember.id,
          relationship: "primary",
        });
      }
    } else {
      // Assign to everyone
      for (const member of createdMembers) {
        await db.insert(staffAssignments).values({
          agentId: chiefOfStaff.id,
          memberId: member.id,
          relationship: "primary",
        });
      }
    }

    res.status(201).json({
      household: { id: household.id, name: household.name },
      members: createdMembers,
      agent: chiefOfStaff,
    });
  });

  return router;
}
