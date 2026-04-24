/**
 * Staff agent routes -- CRUD for agents + assignment management.
 *
 * Guards:
 *   - Only one Chief of Staff allowed per household
 *   - Chief of Staff cannot be deleted
 */

import { Router } from "express";
import { eq, and, or, desc, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Db } from "@carsonos/db";
import {
  staffAgents,
  staffAssignments,
  familyMembers,
  conversations,
  messages,
  tasks,
  taskEvents,
  policyEvents,
  delegationEdges,
  delegationNotifications,
  activityLog,
  toolGrants,
  scheduledTasks,
  customTools,
  personalityInterviewState,
} from "@carsonos/db";
import type { PersonalityInterviewEngine } from "../services/personality-interview.js";
import type { MultiRelayManager } from "../services/multi-relay-manager.js";
import type { SignalRelayManager } from "../services/signal-relay-manager.js";
import type { DelegationService } from "../services/delegation-service.js";

export interface StaffRouteDeps {
  db: Db;
  personalityInterviewEngine: PersonalityInterviewEngine;
  multiRelay?: MultiRelayManager;
  signalRelay?: SignalRelayManager;
  /** Used by the delegation-edges endpoints to apply topology validation
   * (personal → specialist, no self-grants, no personal→personal). */
  delegationService?: DelegationService;
}

export function createStaffRoutes(deps: StaffRouteDeps): Router {
  const { db, personalityInterviewEngine, multiRelay, signalRelay, delegationService } = deps;
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
        signalAccount: req.body.signal_account ?? null,
        signalDaemonPort: req.body.signal_daemon_port ?? null,
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

    // If created with a Signal account, start the Signal relay immediately
    if (req.body.signal_account && signalRelay) {
      signalRelay.startAccount(agent.id).catch((err) => {
        console.error(`[staff] Failed to start Signal relay for new agent:`, err);
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

    const signalAccount = req.body.signal_account;
    const signalDaemonPort = req.body.signal_daemon_port;

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
        ...(signalAccount !== undefined && { signalAccount }),
        ...(signalDaemonPort !== undefined && { signalDaemonPort }),
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

    // If Signal account was added or changed, start/restart the Signal relay
    if (signalAccount && signalRelay) {
      signalRelay.startAccount(req.params.id).catch((err) => {
        console.error(`[staff] Failed to start Signal relay after account update:`, err);
      });
    }

    res.json({ agent: updated });
  });

  // GET /:id/delegation-edges — who can delegate to this agent (incoming)
  // and who this agent can delegate to (outgoing). Used by the StaffDetail
  // page to render the N:M grant UI introduced in v0.4.
  router.get("/:id/delegation-edges", async (req, res) => {
    const agentId = req.params.id;

    const agent = db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, agentId))
      .get();
    if (!agent) {
      res.status(404).json({ error: "Staff agent not found" });
      return;
    }

    const sFrom = alias(staffAgents, "sa_from");
    const sTo = alias(staffAgents, "sa_to");

    const incoming = await db
      .select({
        edgeId: delegationEdges.id,
        agentId: sFrom.id,
        agentName: sFrom.name,
        agentRole: sFrom.staffRole,
        isHeadButler: sFrom.isHeadButler,
      })
      .from(delegationEdges)
      .innerJoin(sFrom, eq(sFrom.id, delegationEdges.fromAgentId))
      .where(eq(delegationEdges.toAgentId, agentId))
      .all();

    const outgoing = await db
      .select({
        edgeId: delegationEdges.id,
        agentId: sTo.id,
        agentName: sTo.name,
        agentRole: sTo.staffRole,
        isHeadButler: sTo.isHeadButler,
      })
      .from(delegationEdges)
      .innerJoin(sTo, eq(sTo.id, delegationEdges.toAgentId))
      .where(eq(delegationEdges.fromAgentId, agentId))
      .all();

    // Candidate lists power the UI's "add a grant" pickers. Scoped to the
    // same household and filtered to the topology the service enforces.
    const candidates = await db
      .select({
        id: staffAgents.id,
        name: staffAgents.name,
        staffRole: staffAgents.staffRole,
        specialty: staffAgents.specialty,
        isHeadButler: staffAgents.isHeadButler,
      })
      .from(staffAgents)
      .where(
        and(
          eq(staffAgents.householdId, agent.householdId),
          eq(staffAgents.status, "active"),
        ),
      )
      .all();

    const isPersonalAgent = (a: (typeof candidates)[number]) =>
      a.staffRole === "personal" || a.staffRole === "head_butler" || a.isHeadButler;

    const agentIsPersonal = agent.staffRole === "personal" || agent.staffRole === "head_butler" || agent.isHeadButler;

    const incomingCandidates = candidates.filter(
      (a) => a.id !== agent.id && isPersonalAgent(a),
    );
    const outgoingCandidates = candidates.filter(
      (a) => a.id !== agent.id && !isPersonalAgent(a),
    );

    res.json({
      agent: { id: agent.id, name: agent.name, staffRole: agent.staffRole, isPersonalAgent: agentIsPersonal },
      incoming,
      outgoing,
      incomingCandidates: agentIsPersonal ? [] : incomingCandidates,
      outgoingCandidates: agentIsPersonal ? outgoingCandidates : [],
    });
  });

  // POST /:id/delegation-edges/incoming — grant a delegator access to this
  // specialist. Body: { delegatorId }. Returns { created }.
  router.post("/:id/delegation-edges/incoming", async (req, res) => {
    if (!delegationService) {
      res.status(503).json({ error: "delegation service unavailable" });
      return;
    }
    const { delegatorId } = req.body as { delegatorId?: string };
    if (!delegatorId) {
      res.status(400).json({ error: "delegatorId required" });
      return;
    }
    const specialist = db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, req.params.id))
      .get();
    if (!specialist) {
      res.status(404).json({ error: "Specialist not found" });
      return;
    }
    const result = await delegationService.handleGrantDelegation({
      householdId: specialist.householdId,
      delegatorId,
      specialistId: specialist.id,
    });
    if (!result.ok) {
      res.status(400).json({ error: result.error, code: result.code });
      return;
    }
    res.json({ created: result.created });
  });

  // DELETE /:id/delegation-edges/incoming/:delegatorId — revoke a grant.
  router.delete("/:id/delegation-edges/incoming/:delegatorId", async (req, res) => {
    if (!delegationService) {
      res.status(503).json({ error: "delegation service unavailable" });
      return;
    }
    const specialist = db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, req.params.id))
      .get();
    if (!specialist) {
      res.status(404).json({ error: "Specialist not found" });
      return;
    }
    const result = await delegationService.handleRevokeDelegation({
      householdId: specialist.householdId,
      delegatorId: req.params.delegatorId,
      specialistId: specialist.id,
    });
    if (!result.ok) {
      res.status(400).json({ error: result.error, code: result.code });
      return;
    }
    res.json({ removed: result.removed });
  });

  // DELETE /:id -- delete staff agent.
  //
  // FK cleanup: staff_agents.id is referenced by 10 tables, most NOT NULL, and
  // the Drizzle better-sqlite3 driver enables PRAGMA foreign_keys=ON, so a
  // naive DELETE fails. We block when state would be unsafe to discard (active
  // tasks, live custom tools) and cascade the rest in a single transaction.
  router.delete("/:id", async (req, res) => {
    const agentId = req.params.id;

    const existing = await db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, agentId))
      .get();

    if (!existing) {
      res.status(404).json({ error: "Staff agent not found" });
      return;
    }

    if (existing.isHeadButler) {
      res.status(403).json({ error: "Cannot delete the Chief of Staff" });
      return;
    }

    // Block if this agent has active tasks. Deleting mid-run would leave a
    // worktree/sandbox orphaned and a reconciler writing into a vanished
    // agent row. Ask the user to cancel the task(s) first.
    const activeTasks = await db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agentId),
          inArray(tasks.status, ["pending", "approved", "in_progress"]),
        ),
      );
    if (activeTasks.length > 0) {
      res.status(409).json({
        error: `agent has ${activeTasks.length} active task(s). Cancel them first: ${activeTasks
          .map((t) => `"${t.title}" (${t.status})`)
          .join(", ")}`,
      });
      return;
    }

    // Block if this agent authored custom tools that are live. Hired Devs
    // often build tools; losing those tools on delete is a surprise. Tell
    // the user to delete or reassign the tools first.
    const liveTools = await db
      .select({ id: customTools.id, name: customTools.name, status: customTools.status })
      .from(customTools)
      .where(
        and(
          eq(customTools.createdByAgentId, agentId),
          inArray(customTools.status, ["active", "pending_approval"]),
        ),
      );
    if (liveTools.length > 0) {
      res.status(409).json({
        error: `agent authored ${liveTools.length} live custom tool(s). Delete them first in Tools: ${liveTools
          .map((t) => t.name)
          .join(", ")}`,
      });
      return;
    }

    // better-sqlite3 is synchronous; Drizzle's transaction wrapper rejects
    // async callbacks. Run each Drizzle chain sync with .all()/.run()/.get().
    try {
      db.transaction((tx) => {
        // Conversations + their messages. messages references conversations(id),
        // so messages must go first.
        const agentConvs = tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.agentId, agentId))
          .all();
        const convIds = agentConvs.map((c) => c.id);
        if (convIds.length > 0) {
          tx.delete(messages).where(inArray(messages.conversationId, convIds)).run();
          tx.delete(conversations).where(inArray(conversations.id, convIds)).run();
        }

        // Task graveyard: clear everything that references the agent's tasks
        // before deleting the tasks themselves. tasks.id is referenced by
        // task_events AND delegation_notifications — both NOT NULL, both need
        // to go first or the parent delete trips SQLITE_CONSTRAINT_FOREIGNKEY.
        // task_events.agent_id and policy_events.agent_id reference the agent
        // directly too, so clear those independent of task-scoped deletes.
        const agentTasks = tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.agentId, agentId))
          .all();
        const taskIds = agentTasks.map((t) => t.id);
        if (taskIds.length > 0) {
          tx.delete(taskEvents).where(inArray(taskEvents.taskId, taskIds)).run();
          tx
            .delete(delegationNotifications)
            .where(inArray(delegationNotifications.taskId, taskIds))
            .run();
        }
        tx.delete(taskEvents).where(eq(taskEvents.agentId, agentId)).run();
        tx.delete(policyEvents).where(eq(policyEvents.agentId, agentId)).run();
        tx
          .update(tasks)
          .set({ notifyAgentId: null })
          .where(eq(tasks.notifyAgentId, agentId))
          .run();
        if (taskIds.length > 0) {
          tx.delete(tasks).where(inArray(tasks.id, taskIds)).run();
        }

        // activity_log.agent_id is nullable but FK-enforced. Null it out
        // instead of deleting so the household's audit trail survives.
        tx
          .update(activityLog)
          .set({ agentId: null })
          .where(eq(activityLog.agentId, agentId))
          .run();

        // Per-agent registries: tool grants, scheduled jobs, delegation edges,
        // assignments, personality-interview state. All scoped to this agent.
        tx.delete(toolGrants).where(eq(toolGrants.agentId, agentId)).run();
        tx.delete(scheduledTasks).where(eq(scheduledTasks.agentId, agentId)).run();
        tx
          .delete(delegationEdges)
          .where(
            or(
              eq(delegationEdges.fromAgentId, agentId),
              eq(delegationEdges.toAgentId, agentId),
            ),
          )
          .run();
        tx.delete(staffAssignments).where(eq(staffAssignments.agentId, agentId)).run();
        tx
          .delete(personalityInterviewState)
          .where(eq(personalityInterviewState.agentId, agentId))
          .run();

        // Boot-time seed marker — otherwise seedMissingDefaults might skip a
        // fresh re-hire because a stale `grants_seeded:<id>` row exists.
        tx.run(
          sql`DELETE FROM instance_settings WHERE key = ${`grants_seeded:${agentId}`}`,
        );

        tx.delete(staffAgents).where(eq(staffAgents.id, agentId)).run();
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[staff] DELETE /${agentId} failed:`, err);
      res.status(500).json({ error: `failed to delete staff agent: ${msg}` });
      return;
    }

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
  // Legacy outgoing-edges shape kept for backward compat with the existing
  // StaffDetail UI. The mutating POST/DELETE paths below now go through the
  // DelegationService so the same topology rules apply (personal → specialist,
  // no personal→personal, no self-grants). The read GET path still queries
  // directly — read has no trust-boundary risk. The pre-v0.4 inline
  // insert/delete variant of this endpoint let kids grant themselves access
  // to anything, which is what we just closed.
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

  router.post("/:id/delegations", async (req, res) => {
    if (!delegationService) {
      res.status(503).json({ error: "delegation service unavailable" });
      return;
    }
    const { toAgentId } = req.body as { toAgentId?: string };
    const fromAgentId = req.params.id;
    if (!toAgentId) {
      res.status(400).json({ error: "toAgentId is required" });
      return;
    }
    const fromAgent = db.select().from(staffAgents).where(eq(staffAgents.id, fromAgentId)).get();
    if (!fromAgent) {
      res.status(404).json({ error: "Source agent not found" });
      return;
    }
    const result = await delegationService.handleGrantDelegation({
      householdId: fromAgent.householdId,
      delegatorId: fromAgentId,
      specialistId: toAgentId,
    });
    if (!result.ok) {
      const status = result.code === "E_AGENT_NOT_FOUND" ? 404 : 400;
      res.status(status).json({ error: result.error, code: result.code });
      return;
    }
    res.status(result.created ? 201 : 200).json({ created: result.created });
  });

  router.delete("/:fromId/delegations/:toId", async (req, res) => {
    if (!delegationService) {
      res.status(503).json({ error: "delegation service unavailable" });
      return;
    }
    const fromAgent = db.select().from(staffAgents).where(eq(staffAgents.id, req.params.fromId)).get();
    if (!fromAgent) {
      res.status(404).json({ error: "Source agent not found" });
      return;
    }
    const result = await delegationService.handleRevokeDelegation({
      householdId: fromAgent.householdId,
      delegatorId: req.params.fromId,
      specialistId: req.params.toId,
    });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ deleted: result.removed });
  });

  return router;
}
