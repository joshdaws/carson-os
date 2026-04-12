/**
 * Staff agent routes -- CRUD for agents + assignment management.
 *
 * Guards:
 *   - Only one Chief of Staff allowed per household
 *   - Chief of Staff cannot be deleted
 */

import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import {
  staffAgents,
  staffAssignments,
  familyMembers,
  conversations,
  delegationEdges,
  personalityInterviewState,
} from "@carsonos/db";
import type { PersonalityInterviewEngine } from "../services/personality-interview.js";
import type { MultiRelayManager } from "../services/multi-relay-manager.js";

export interface StaffRouteDeps {
  db: Db;
  personalityInterviewEngine: PersonalityInterviewEngine;
  multiRelay?: MultiRelayManager;
}

export function createStaffRoutes(deps: StaffRouteDeps): Router {
  const { db, personalityInterviewEngine, multiRelay } = deps;
  const router = Router();

  // GET / -- list all staff agents (scoped to household)
  router.get("/", async (req, res) => {
    const householdId = req.query.householdId as string;
    const visibility = req.query.visibility as string | undefined;

    const conditions = householdId
      ? [eq(staffAgents.householdId, householdId)]
      : [];

    if (visibility) {
      conditions.push(eq(staffAgents.visibility, visibility));
    }

    const agents = await db
      .select()
      .from(staffAgents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(staffAgents.createdAt))
      .all();

    // Include assignments with member names for dashboard display
    const agentsWithAssignments = await Promise.all(
      agents.map(async (agent) => {
        const assignments = await db
          .select({
            memberId: staffAssignments.memberId,
            memberName: familyMembers.name,
            relationship: staffAssignments.relationship,
          })
          .from(staffAssignments)
          .innerJoin(familyMembers, eq(familyMembers.id, staffAssignments.memberId))
          .where(eq(staffAssignments.agentId, agent.id))
          .all();
        return { ...agent, assignments };
      }),
    );

    res.json({ staff: agentsWithAssignments });
  });

  // GET /:id -- staff detail with assignments
  router.get("/:id", async (req, res) => {
    const agent = await db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, req.params.id))
      .get();

    if (!agent) {
      res.status(404).json({ error: "Staff agent not found" });
      return;
    }

    // Get assignments with member info
    const assignments = await db
      .select({
        id: staffAssignments.id,
        memberId: staffAssignments.memberId,
        relationship: staffAssignments.relationship,
        memberName: familyMembers.name,
        memberRole: familyMembers.role,
        memberAge: familyMembers.age,
      })
      .from(staffAssignments)
      .innerJoin(
        familyMembers,
        eq(familyMembers.id, staffAssignments.memberId),
      )
      .where(eq(staffAssignments.agentId, agent.id))
      .all();

    // Get recent conversations
    const recentConversations = await db
      .select()
      .from(conversations)
      .where(eq(conversations.agentId, agent.id))
      .orderBy(desc(conversations.startedAt))
      .limit(10)
      .all();

    res.json({ agent, assignments, recentConversations });
  });

  // POST / -- create staff agent
  router.post("/", async (req, res) => {
    const {
      householdId,
      name,
      staffRole,
      specialty,
      roleContent,
      soulContent,
      visibility,
      telegramBotToken,
      model,
      trustLevel,
      isHeadButler,
      autonomyLevel,
    } = req.body;

    if (!householdId || !name || !staffRole) {
      res
        .status(400)
        .json({ error: "householdId, name, and staffRole are required" });
      return;
    }

    // Block if trying to create a head butler when one already exists
    if (isHeadButler) {
      const existingButler = await db
        .select()
        .from(staffAgents)
        .where(
          and(
            eq(staffAgents.householdId, householdId),
            eq(staffAgents.isHeadButler, true),
          ),
        )
        .get();

      if (existingButler) {
        res
          .status(409)
          .json({ error: "A Chief of Staff already exists for this household" });
        return;
      }
    }

    const [agent] = await db
      .insert(staffAgents)
      .values({
        householdId,
        name,
        staffRole,
        specialty: specialty ?? null,
        roleContent: roleContent ?? "",
        soulContent: soulContent ?? null,
        visibility: visibility ?? "family",
        telegramBotToken: telegramBotToken ?? null,
        model: model ?? "claude-sonnet-4-6",
        trustLevel: trustLevel ?? "restricted",
        isHeadButler: isHeadButler ?? false,
        autonomyLevel: autonomyLevel ?? "supervised",
      })
      .returning();

    // If created with a bot token, start the Telegram bot immediately
    if (telegramBotToken && multiRelay) {
      multiRelay.startBot(agent.id).catch((err) => {
        console.error(`[staff] Failed to start bot for new agent:`, err);
      });
    }

    res.status(201).json({ agent });
  });

  // PUT /:id -- update staff agent
  router.put("/:id", async (req, res) => {
    const existing = await db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, req.params.id))
      .get();

    if (!existing) {
      res.status(404).json({ error: "Staff agent not found" });
      return;
    }

    const {
      name,
      staffRole,
      specialty,
      roleContent,
      soulContent,
      visibility,
      telegramBotToken,
      model,
      status,
      autonomyLevel,
    } = req.body;

    const [updated] = await db
      .update(staffAgents)
      .set({
        ...(name !== undefined && { name }),
        ...(staffRole !== undefined && { staffRole }),
        ...(specialty !== undefined && { specialty }),
        ...(roleContent !== undefined && { roleContent }),
        ...(soulContent !== undefined && { soulContent }),
        ...(visibility !== undefined && { visibility }),
        ...(telegramBotToken !== undefined && { telegramBotToken }),
        ...(model !== undefined && { model }),
        ...(status !== undefined && { status }),
        ...(autonomyLevel !== undefined && { autonomyLevel }),
        updatedAt: new Date(),
      })
      .where(eq(staffAgents.id, req.params.id))
      .returning();

    // If bot token was added or changed, start/restart the Telegram bot
    if (telegramBotToken && multiRelay) {
      multiRelay.startBot(req.params.id).catch((err) => {
        console.error(`[staff] Failed to start bot after token update:`, err);
      });
    }

    res.json({ agent: updated });
  });

  // DELETE /:id -- delete staff agent (block if Chief of Staff)
  router.delete("/:id", async (req, res) => {
    const existing = await db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, req.params.id))
      .get();

    if (!existing) {
      res.status(404).json({ error: "Staff agent not found" });
      return;
    }

    if (existing.isHeadButler) {
      res.status(403).json({ error: "Cannot delete the Chief of Staff" });
      return;
    }

    // Delete assignments first (FK constraint)
    await db
      .delete(staffAssignments)
      .where(eq(staffAssignments.agentId, req.params.id));

    // Delete agent
    await db.delete(staffAgents).where(eq(staffAgents.id, req.params.id));

    res.json({ deleted: true });
  });

  // -- Assignments ---------------------------------------------------

  // POST /:id/assignments -- assign agent to member
  router.post("/:id/assignments", async (req, res) => {
    const { memberId, relationship } = req.body;
    const agentId = req.params.id;

    if (!memberId) {
      res.status(400).json({ error: "memberId is required" });
      return;
    }

    // Verify agent exists
    const agent = await db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, agentId))
      .get();

    if (!agent) {
      res.status(404).json({ error: "Staff agent not found" });
      return;
    }

    // Verify member exists
    const member = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, memberId))
      .get();

    if (!member) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    try {
      const [assignment] = await db
        .insert(staffAssignments)
        .values({
          agentId,
          memberId,
          relationship: relationship ?? "primary",
        })
        .returning();

      res.status(201).json({ assignment });
    } catch (err) {
      // Unique constraint violation = already assigned
      const message =
        err instanceof Error ? err.message : "Assignment failed";
      if (message.includes("UNIQUE") || message.includes("unique")) {
        res
          .status(409)
          .json({ error: "This agent is already assigned to this member" });
        return;
      }
      throw err;
    }
  });

  // DELETE /:agentId/assignments/:memberId -- remove assignment
  router.delete("/:agentId/assignments/:memberId", async (req, res) => {
    const { agentId, memberId } = req.params;

    const existing = await db
      .select()
      .from(staffAssignments)
      .where(
        and(
          eq(staffAssignments.agentId, agentId),
          eq(staffAssignments.memberId, memberId),
        ),
      )
      .get();

    if (!existing) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }

    await db
      .delete(staffAssignments)
      .where(eq(staffAssignments.id, existing.id));

    res.json({ deleted: true });
  });

  // -- Personality Interview -------------------------------------------

  // GET /:id/personality -- interview state + soulContent
  router.get("/:id/personality", async (req, res) => {
    const agent = await db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, req.params.id))
      .get();

    if (!agent) {
      res.status(404).json({ error: "Staff agent not found" });
      return;
    }

    // Get interview state if exists
    const [interviewState] = await db
      .select()
      .from(personalityInterviewState)
      .where(eq(personalityInterviewState.agentId, req.params.id))
      .limit(1);

    res.json({
      agentId: agent.id,
      agentName: agent.name,
      soulContent: agent.soulContent,
      interview: interviewState
        ? {
            phase: interviewState.phase,
            messageCount: ((interviewState.interviewMessages as unknown[]) ?? []).length,
            messages: ((interviewState.interviewMessages as Array<{ role: string; content: string }>) ?? []).map(
              (m) => ({ role: m.role, content: m.content }),
            ),
          }
        : null,
    });
  });

  // POST /:id/personality/interview -- send message
  router.post("/:id/personality/interview", async (req, res) => {
    const { message } = req.body;
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message (string) is required" });
      return;
    }

    try {
      const result = await personalityInterviewEngine.processMessage(
        req.params.id,
        message,
      );
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Interview failed";
      res.status(500).json({ error: msg });
    }
  });

  // POST /:id/personality/reset -- reset interview
  router.post("/:id/personality/reset", async (req, res) => {
    try {
      await personalityInterviewEngine.resetInterview(req.params.id);
      res.json({ reset: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Reset failed";
      res.status(500).json({ error: msg });
    }
  });

  // -- Delegation Edges -----------------------------------------------

  // GET /:id/delegations -- list delegation edges from this agent
  router.get("/:id/delegations", async (req, res) => {
    const edges = await db
      .select({
        id: delegationEdges.id,
        fromAgentId: delegationEdges.fromAgentId,
        toAgentId: delegationEdges.toAgentId,
        allowedTaskTypes: delegationEdges.allowedTaskTypes,
        relayProgress: delegationEdges.relayProgress,
        toAgentName: staffAgents.name,
        toAgentRole: staffAgents.staffRole,
        toAgentSpecialty: staffAgents.specialty,
      })
      .from(delegationEdges)
      .innerJoin(staffAgents, eq(staffAgents.id, delegationEdges.toAgentId))
      .where(eq(delegationEdges.fromAgentId, req.params.id))
      .all();

    res.json({ delegations: edges });
  });

  // POST /:id/delegations -- add delegation edge
  router.post("/:id/delegations", async (req, res) => {
    const { toAgentId, allowedTaskTypes, relayProgress } = req.body;
    const fromAgentId = req.params.id;

    if (!toAgentId) {
      res.status(400).json({ error: "toAgentId is required" });
      return;
    }

    // Verify both agents exist
    const fromAgent = await db.select().from(staffAgents).where(eq(staffAgents.id, fromAgentId)).get();
    const toAgent = await db.select().from(staffAgents).where(eq(staffAgents.id, toAgentId)).get();

    if (!fromAgent) { res.status(404).json({ error: "Source agent not found" }); return; }
    if (!toAgent) { res.status(404).json({ error: "Target agent not found" }); return; }

    try {
      const [edge] = await db
        .insert(delegationEdges)
        .values({
          fromAgentId,
          toAgentId,
          allowedTaskTypes: allowedTaskTypes ?? null,
          relayProgress: relayProgress ?? false,
        })
        .returning();

      res.status(201).json({ delegation: edge });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed";
      if (message.includes("UNIQUE") || message.includes("unique")) {
        res.status(409).json({ error: "Delegation edge already exists" });
        return;
      }
      throw err;
    }
  });

  // DELETE /:fromId/delegations/:toId -- remove delegation edge
  router.delete("/:fromId/delegations/:toId", async (req, res) => {
    const { fromId, toId } = req.params;

    const existing = await db
      .select()
      .from(delegationEdges)
      .where(
        and(
          eq(delegationEdges.fromAgentId, fromId),
          eq(delegationEdges.toAgentId, toId),
        ),
      )
      .get();

    if (!existing) {
      res.status(404).json({ error: "Delegation edge not found" });
      return;
    }

    await db.delete(delegationEdges).where(eq(delegationEdges.id, existing.id));
    res.json({ deleted: true });
  });

  return router;
}
