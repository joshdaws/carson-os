/**
 * Delegation Service -- coordinates the full delegation lifecycle (v0.4).
 *
 * Entry points:
 *   - handleDelegateTaskCall({...}) — structured MCP tool call. Validates
 *     the delegation edge + depth, creates a child task row, dispatches it.
 *   - handleHireProposal({...}) — creates an approval task and escalates to
 *     principal via CarsonOversight. Lane F's callback_query handler drives
 *     the Approve/Reject UX and, on approval, materializes the staff_agents
 *     row + delegation_edges.
 *   - handleCancelTask({...}) — idempotent cancel by runId or specialist name.
 *   - handleProjectCompleted(projectId) — synthesis path used by the existing
 *     kid-agent flow (multiple subtasks → one response). Preserved from v0.1.
 *
 * What's gone in v0.4:
 *   - <delegate> XML block parsing (handleAgentResponse). The MCP tool call
 *     is the only delegation entry point. delegate-parser.ts is dead code
 *     scheduled for deletion in Lane B cleanup.
 */

import { eq, and, inArray } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import {
  staffAgents,
  delegationEdges,
  tasks,
  taskEvents,
  conversations,
  messages,
  familyMembers,
} from "@carsonos/db";

import type { Adapter } from "./subprocess-adapter.js";
import type { BroadcastFn } from "./event-bus.js";
import { compileSystemPrompt } from "./prompt-compiler.js";
import { Dispatcher } from "./dispatcher.js";
import { TaskEngine } from "./task-engine.js";
import type { CarsonOversight } from "./carson-oversight.js";
import {
  templateForSpecialty,
  type DeveloperSpecialty,
} from "./delegation/specialty-templates/index.js";
import type { DelegationNotifier, NotifyPayload } from "./delegation/notifier.js";

// -- Types -----------------------------------------------------------

export interface DelegationResult {
  delegated: boolean;
  userMessage: string;
  projectId?: string;
  warnings?: string[];
}

export interface DelegateTaskCallInput {
  fromAgentId: string;
  householdId: string;
  /** Target specialist name (case-insensitive). */
  toAgentName: string;
  goal: string;
  context?: string;
  /** Required for project/core specialties. */
  projectId?: string;
  /** Member on whose behalf this delegation runs (for notification routing). */
  requestedByMember: string;
  /** The caller agent's current task row, if it's inside one. Used for depth-2
   * enforcement: child delegationDepth = caller.delegationDepth + 1. */
  callerTaskId?: string;
}

export interface DelegateTaskCallResult {
  ok: true;
  runId: string;
  status: string;
}

export interface DelegateTaskCallError {
  ok: false;
  error: string;
  code?: "E_NO_EDGE" | "E_AGENT_NOT_FOUND" | "E_DEPTH_EXCEEDED" | "E_PROJECT_NOT_FOUND";
}

export interface HireProposalInput {
  householdId: string;
  proposedByAgentId: string;
  proposedByMemberId: string;
  role: string;
  specialty: "tools" | "project" | "core";
  reason: string;
  proposedName?: string;
}

export interface HireProposalResult {
  ok: true;
  approvalTaskId: string;
}

export interface HireProposalError {
  ok: false;
  error: string;
}

export interface CancelTaskInput {
  householdId: string;
  runId?: string;
  specialistName?: string;
}

export interface CancelTaskResult {
  ok: true;
  status: "cancelled" | "completed" | "failed" | "in_progress" | "pending" | "approved";
  alreadyTerminal?: boolean;
}

export interface CancelTaskError {
  ok: false;
  error: string;
}

export interface HireApprovalResult {
  ok: true;
  /** New staff agent id when approved and materialized. */
  developerAgentId?: string;
  /** True when the approval task was already resolved (double-tap race). */
  alreadyResolved?: boolean;
}

export interface HireApprovalError {
  ok: false;
  error: string;
}

interface DelegationServiceConfig {
  db: Db;
  adapter: Adapter;
  broadcast: BroadcastFn;
}

// -- Service ---------------------------------------------------------

export class DelegationService {
  private db: Db;
  private adapter: Adapter;
  private broadcast: BroadcastFn;
  private dispatcher: Dispatcher;
  private taskEngine: TaskEngine;
  private oversight: CarsonOversight | null = null;
  private notifier: DelegationNotifier | null = null;

  constructor(
    config: DelegationServiceConfig,
    dispatcher: Dispatcher,
    taskEngine: TaskEngine,
  ) {
    this.db = config.db;
    this.adapter = config.adapter;
    this.broadcast = config.broadcast;
    this.dispatcher = dispatcher;
    this.taskEngine = taskEngine;
  }

  /** Injected after construction because Oversight depends on broadcast. */
  setOversight(oversight: CarsonOversight): void {
    this.oversight = oversight;
  }

  /** Injected after construction — the notifier uses the multiRelay which
   * is built after DelegationService. Used by handleHireProposal to send
   * the approval card with inline buttons. */
  setNotifier(notifier: DelegationNotifier): void {
    this.notifier = notifier;
  }

  // -- Public API -----------------------------------------------------

  /**
   * Primary v0.4 delegation entry point. Invoked by the `delegate_task` MCP
   * tool handler with structured args. Validates the delegation edge,
   * enforces depth-2, resolves the project (if any) + Developer specialty,
   * creates the child task row, dispatches it. Returns immediately.
   */
  async handleDelegateTaskCall(
    input: DelegateTaskCallInput,
  ): Promise<DelegateTaskCallResult | DelegateTaskCallError> {
    const [caller, target] = await Promise.all([
      this.loadAgent(input.fromAgentId),
      this.loadAgentByName(input.householdId, input.toAgentName),
    ]);

    if (!caller) {
      return { ok: false, error: `caller agent ${input.fromAgentId} not found`, code: "E_AGENT_NOT_FOUND" };
    }
    if (!target) {
      return {
        ok: false,
        error: `no staff member named '${input.toAgentName}' found. Use list_agents or propose_hire first.`,
        code: "E_AGENT_NOT_FOUND",
      };
    }

    // Edge check
    const [edge] = await this.db
      .select()
      .from(delegationEdges)
      .where(
        and(
          eq(delegationEdges.fromAgentId, caller.id),
          eq(delegationEdges.toAgentId, target.id),
        ),
      )
      .limit(1);
    if (!edge) {
      return {
        ok: false,
        error: `no delegation edge from ${caller.name} to ${target.name}. Hire first via propose_hire.`,
        code: "E_NO_EDGE",
      };
    }

    // Depth-2 enforcement via the caller's current task row
    let callerDepth = 0;
    if (input.callerTaskId) {
      const [callerTask] = await this.db
        .select({ delegationDepth: tasks.delegationDepth })
        .from(tasks)
        .where(eq(tasks.id, input.callerTaskId))
        .limit(1);
      callerDepth = callerTask?.delegationDepth ?? 0;
    }
    if (callerDepth >= 1) {
      return {
        ok: false,
        error: `delegation depth exceeded (max depth 2). Caller is already a delegated task.`,
        code: "E_DEPTH_EXCEEDED",
      };
    }

    // Resolve project (for project/core specialty)
    if (input.projectId) {
      const { projects } = await import("@carsonos/db");
      const [project] = await this.db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.householdId, input.householdId),
          ),
        )
        .limit(1);
      if (!project) {
        return {
          ok: false,
          error: `project ${input.projectId} not found in this household.`,
          code: "E_PROJECT_NOT_FOUND",
        };
      }
    }

    // Developers are trusted — no principal approval on each task delegation.
    // Family-agent delegations from kid personal agents still require approval
    // (CoS is the gate); those land here via CoS calling handleDelegateTaskCall
    // on behalf of the kid, so the edge check above already governed it.
    const isDeveloperTarget = target.staffRole === "custom" && target.specialty != null;

    const childTask = await this.taskEngine.createTask({
      householdId: input.householdId,
      agentId: target.id,
      parentTaskId: input.callerTaskId,
      requestedBy: input.requestedByMember,
      title: input.goal,
      description: input.context,
      requiresApproval: false,
      delegationDepth: callerDepth + 1,
      projectId: input.projectId,
      workspaceKind: target.specialty === "tools" ? "tool_sandbox" : undefined,
      // Developer tasks run with no wall-clock timeout (design premise 9a).
      timeoutSec: isDeveloperTarget ? null : undefined,
      notifyAgentId: caller.id,
    });

    await this.logEvent(
      childTask.id,
      "delegated",
      caller.id,
      `${caller.name} delegated to ${target.name}: ${input.goal}`,
      {
        fromAgent: caller.name,
        toAgent: target.name,
        specialty: target.specialty,
        projectId: input.projectId ?? null,
        contextPreview: input.context?.slice(0, 200),
      },
    );

    // Async dispatch — returns immediately. Lane E's extended Dispatcher
    // provisions the workspace and kicks off the child agent's query().
    this.dispatcher
      .handleTaskAssignment(childTask.id)
      .catch((err) =>
        console.error(
          `[delegation] dispatch for ${childTask.id} failed:`,
          err,
        ),
      );

    return { ok: true, runId: childTask.id, status: childTask.status };
  }

  /**
   * Hire proposal — creates an approval task and escalates to principal.
   * Lane F's callback_query handler drives Approve/Reject from Telegram;
   * on approval, the pending handler materializes the staff_agents row
   * + delegation_edges with the specialty template.
   */
  async handleHireProposal(
    input: HireProposalInput,
  ): Promise<HireProposalResult | HireProposalError> {
    if (!this.oversight) {
      return { ok: false, error: "oversight not wired (server boot order)" };
    }

    const review = await this.oversight.reviewHireProposal({
      householdId: input.householdId,
      proposedByAgentId: input.proposedByAgentId,
      role: input.role,
      specialty: input.specialty,
      reason: input.reason,
      proposedName: input.proposedName,
    });

    // reviewHireProposal always escalates — approved is never true here.
    // We still create the approval task so the UI/Telegram layer has a row to hang on.
    const approvalTask = await this.taskEngine.createTask({
      householdId: input.householdId,
      agentId: input.proposedByAgentId,
      requestedBy: input.proposedByMemberId,
      title: `Hire ${input.proposedName ?? "a new Developer"} (${input.specialty})`,
      description: JSON.stringify({
        kind: "hire_proposal",
        role: input.role,
        specialty: input.specialty,
        reason: input.reason,
        proposedName: input.proposedName,
      }),
      requiresApproval: true,
      delegationDepth: 0,
      // Approval auto-cancels after 24h per design success criteria.
      approvalExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    await this.logEvent(
      approvalTask.id,
      "hire_proposed",
      input.proposedByAgentId,
      `Hire proposed: ${input.proposedName ?? input.specialty + " Developer"} — ${input.reason}`,
      {
        role: input.role,
        specialty: input.specialty,
        reason: input.reason,
        proposedName: input.proposedName,
        reviewReason: review.reason,
      },
    );

    // Compose + deliver the Telegram approval card with inline buttons.
    // If the notifier isn't wired yet (boot order edge case) or Telegram
    // is offline, the reconciler's Phase-2 replay will retry on next boot.
    if (this.notifier) {
      const proposedName = input.proposedName ?? defaultDeveloperName(input.specialty);
      const cardText = composeHireCardText({
        proposedName,
        specialty: input.specialty,
        reason: input.reason,
      });
      const replyMarkup = {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `approve:${approvalTask.id}` },
            { text: "❌ Reject", callback_data: `reject:${approvalTask.id}` },
          ],
        ],
      };
      const payload: NotifyPayload = {
        kind: "hire_proposal",
        text: cardText,
        replyMarkup,
        householdId: input.householdId,
        memberId: input.proposedByMemberId,
        agentId: input.proposedByAgentId,
      };
      // The task stays `pending` until the principal approves/rejects —
      // this isn't a terminal state, so bypass notifier.prepare() (which
      // enforces a terminal status) and write notify_payload directly.
      // Notifier.deliver() only reads notify_payload + notified_at, so it
      // works fine on a pending row. Reconciler's Phase-2 replay handles
      // it too since the scan condition is `payload IS NOT NULL AND
      // notified_at IS NULL`, regardless of status.
      await this.db
        .update(tasks)
        .set({ notifyPayload: payload, updatedAt: new Date() })
        .where(eq(tasks.id, approvalTask.id));

      this.notifier
        .deliver(approvalTask.id)
        .catch((err) =>
          console.error(`[delegation] hire-card deliver(${approvalTask.id}) threw:`, err),
        );
    }

    return { ok: true, approvalTaskId: approvalTask.id };
  }

  /**
   * Approve a hire proposal. Materializes the Developer staff_agents row
   * with the specialty template as operating_instructions + creates the
   * delegation_edges so the proposing agent (CoS) can delegate to the new
   * Developer.
   *
   * Race-safe: the initial UPDATE gates on `status='pending'` so a
   * double-tap on Approve/Reject only wins once. Returns alreadyResolved
   * for the losing click.
   */
  async handleHireApproval(
    approvalTaskId: string,
    approvedBy: string,
  ): Promise<HireApprovalResult | HireApprovalError> {
    const [task] = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, approvalTaskId))
      .limit(1);
    if (!task) return { ok: false, error: `approval task ${approvalTaskId} not found` };

    // Atomic race gate: only one approve/reject wins.
    const updated = await this.db
      .update(tasks)
      .set({ status: "approved", approvedBy, updatedAt: new Date() })
      .where(and(eq(tasks.id, approvalTaskId), eq(tasks.status, "pending")))
      .returning({ id: tasks.id });
    if (updated.length === 0) {
      return { ok: true, alreadyResolved: true };
    }

    // Parse the hire proposal metadata stored in the task description.
    let proposal: {
      kind?: string;
      role?: string;
      specialty?: DeveloperSpecialty;
      reason?: string;
      proposedName?: string;
    };
    try {
      proposal = task.description ? JSON.parse(task.description) : {};
    } catch {
      proposal = {};
    }

    const specialty = (proposal.specialty ?? "tools") as DeveloperSpecialty;
    const name = proposal.proposedName?.trim() || defaultDeveloperName(specialty);

    // Materialize the Developer staff_agents row.
    const [developer] = await this.db
      .insert(staffAgents)
      .values({
        householdId: task.householdId,
        name,
        staffRole: "custom",
        specialty,
        roleContent: `A Developer specializing in ${specialty}. ${proposal.reason ?? ""}`.trim(),
        soulContent: null,
        visibility: "internal",
        model: "claude-opus-4-7",
        status: "active",
        isHeadButler: false,
        autonomyLevel: "autonomous",
        trustLevel: "full",
        operatingInstructions: templateForSpecialty(specialty),
      })
      .returning();

    // Edge: proposing agent (CoS) → new Developer. Principal → Developer
    // edge is implicit via the CoS relay path; no separate row needed.
    await this.db
      .insert(delegationEdges)
      .values({
        fromAgentId: task.agentId, // proposing agent (usually CoS)
        toAgentId: developer.id,
      })
      .onConflictDoNothing();

    // Mark the approval task completed + note the developer id for audit.
    await this.db
      .update(tasks)
      .set({
        status: "completed",
        result: JSON.stringify({ developerAgentId: developer.id, specialty, name }),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, approvalTaskId));

    await this.logEvent(
      approvalTaskId,
      "completed",
      task.agentId,
      `Hire approved — ${name} (${specialty}) is on staff`,
      { developerAgentId: developer.id, specialty, approvedBy },
    );

    this.broadcast({
      type: "hire.approved",
      data: {
        taskId: approvalTaskId,
        householdId: task.householdId,
        developerAgentId: developer.id,
        specialty,
        name,
      },
    });

    return { ok: true, developerAgentId: developer.id };
  }

  /**
   * Reject a hire proposal. Atomic race gate same as approve. Marks the
   * approval task cancelled + emits hire.rejected.
   */
  async handleHireRejection(
    approvalTaskId: string,
    rejectedBy: string,
  ): Promise<HireApprovalResult | HireApprovalError> {
    const [task] = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, approvalTaskId))
      .limit(1);
    if (!task) return { ok: false, error: `approval task ${approvalTaskId} not found` };

    const updated = await this.db
      .update(tasks)
      .set({
        status: "cancelled",
        approvedBy: rejectedBy,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, approvalTaskId), eq(tasks.status, "pending")))
      .returning({ id: tasks.id });
    if (updated.length === 0) {
      return { ok: true, alreadyResolved: true };
    }

    await this.logEvent(approvalTaskId, "rejected", task.agentId, "Hire rejected by principal", {
      rejectedBy,
    });

    this.broadcast({
      type: "hire.rejected",
      data: { taskId: approvalTaskId, householdId: task.householdId, rejectedBy },
    });

    return { ok: true };
  }

  /**
   * Idempotent cancel. Resolves by runId OR by specialist name (→ that
   * specialist's currently-active task in the household).
   * Cancelling an already-terminal task returns alreadyTerminal=true.
   */
  async handleCancelTask(
    input: CancelTaskInput,
  ): Promise<CancelTaskResult | CancelTaskError> {
    let targetTaskId = input.runId;

    if (!targetTaskId && input.specialistName) {
      const [agent] = await this.db
        .select()
        .from(staffAgents)
        .where(
          and(
            eq(staffAgents.householdId, input.householdId),
            eq(staffAgents.name, input.specialistName),
          ),
        )
        .limit(1);
      if (!agent) {
        return { ok: false, error: `no staff member named '${input.specialistName}' found` };
      }

      const activeStatuses = ["pending", "approved", "in_progress"];
      const rows = await this.db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.householdId, input.householdId),
            eq(tasks.agentId, agent.id),
            inArray(tasks.status, activeStatuses),
          ),
        );
      if (rows.length === 0) {
        return { ok: false, error: `${input.specialistName} has no active tasks` };
      }
      // Prefer the most-recently-created active task.
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      targetTaskId = rows[0].id;
    }

    if (!targetTaskId) {
      return { ok: false, error: "cancel_task requires runId or specialistName" };
    }

    const [task] = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, targetTaskId))
      .limit(1);
    if (!task) return { ok: false, error: `task ${targetTaskId} not found` };

    const terminalStatuses = ["completed", "failed", "cancelled"];
    if (terminalStatuses.includes(task.status)) {
      return {
        ok: true,
        status: task.status as CancelTaskResult["status"],
        alreadyTerminal: true,
      };
    }

    await this.db
      .update(tasks)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(tasks.id, targetTaskId));

    await this.logEvent(
      targetTaskId,
      "failed",
      null,
      `Task cancelled by user`,
      { reason: "cancelled by user" },
    );

    // Broadcast so the Dispatcher can tear down the workspace (Lane E hook).
    this.broadcast({
      type: "task.cancelled",
      data: { taskId: targetTaskId, householdId: input.householdId },
    });

    return { ok: true, status: "cancelled" };
  }

  /**
   * Called when the dispatcher broadcasts project.completed.
   * Loads subtask results, synthesizes them into a single response,
   * and delivers it back to the member via broadcast.
   */
  async handleProjectCompleted(projectId: string): Promise<void> {
    // 1. Load the project task and all subtasks
    const projectTask = await this.taskEngine.getTask(projectId);
    if (!projectTask) {
      console.error(
        `[orchestrator] Project task ${projectId} not found for synthesis`,
      );
      return;
    }

    const subtasks = await this.taskEngine.getSubtasks(projectId);
    if (subtasks.length === 0) {
      console.error(
        `[orchestrator] No subtasks found for project ${projectId}`,
      );
      return;
    }

    // 2. Load the personal agent and the member
    const [agent, member] = await Promise.all([
      this.loadAgent(projectTask.agentId),
      projectTask.requestedBy
        ? this.loadMember(projectTask.requestedBy)
        : null,
    ]);

    if (!agent) {
      console.error(
        `[orchestrator] Agent ${projectTask.agentId} not found for synthesis`,
      );
      return;
    }

    const memberName = member?.name ?? "the user";

    // 3. Find the conversation to deliver the result
    const [conversation] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.agentId, projectTask.agentId))
      .then((rows) =>
        rows.filter((c) =>
          member ? c.memberId === member.id : true,
        ),
      )
      .then((rows) =>
        rows.sort((a, b) =>
          (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""),
        ),
      )
      .then((rows) => [rows[0]]);

    // 4. Synthesize results
    let synthesizedResponse: string;

    const completedSubtasks = subtasks.filter((t) => t.status === "completed");
    const failedSubtasks = subtasks.filter((t) => t.status === "failed");

    if (subtasks.length === 1) {
      // Single subtask -- skip LLM synthesis
      const subtask = subtasks[0];
      if (subtask.status === "completed" && subtask.result) {
        synthesizedResponse = `Here's what I found:\n\n${subtask.result}`;
      } else {
        synthesizedResponse = `I wasn't able to complete that. ${subtask.result ?? "The task failed without details."}`;
      }
    } else {
      // Multiple subtasks -- synthesize via LLM
      synthesizedResponse = await this.synthesizeResults(
        agent,
        memberName,
        completedSubtasks,
        failedSubtasks,
      );
    }

    // 5. Record the synthesized response as an assistant message
    if (conversation) {
      try {
        const now = new Date().toISOString();

        await this.db.insert(messages).values({
          id: crypto.randomUUID(),
          conversationId: conversation.id,
          role: "assistant",
          content: synthesizedResponse,
        });

        await this.db
          .update(conversations)
          .set({ lastMessageAt: now })
          .where(eq(conversations.id, conversation.id));
      } catch (err) {
        console.error(
          "[orchestrator] Failed to record synthesis message:",
          err,
        );
      }
    }

    // 6. Broadcast the result for the relay to deliver
    try {
      this.broadcast({
        type: "delegation.result",
        data: {
          memberId: member?.id ?? null,
          agentId: agent.id,
          conversationId: conversation?.id ?? null,
          response: synthesizedResponse,
        },
      });
    } catch (err) {
      console.error("[orchestrator] Failed to broadcast delegation result:", err);
    }

    // 7. Log synthesis event
    await this.logEvent(
      projectId,
      "synthesis_requested",
      agent.id,
      `Synthesis completed for ${subtasks.length} subtask(s)`,
      {
        completedCount: completedSubtasks.length,
        failedCount: failedSubtasks.length,
        responseLength: synthesizedResponse.length,
      },
    );
  }

  /**
   * Load delegation edges and target agent info for a given source agent.
   */
  async getDelegationEdges(
    agentId: string,
  ): Promise<
    Array<{
      agentId: string;
      agentName: string;
      staffRole: string;
      specialty: string | null;
    }>
  > {
    const edges = await this.db
      .select()
      .from(delegationEdges)
      .where(eq(delegationEdges.fromAgentId, agentId));

    if (edges.length === 0) return [];

    const results: Array<{
      agentId: string;
      agentName: string;
      staffRole: string;
      specialty: string | null;
    }> = [];

    for (const edge of edges) {
      const targetAgent = await this.loadAgent(edge.toAgentId);
      if (targetAgent) {
        results.push({
          agentId: targetAgent.id,
          agentName: targetAgent.name,
          staffRole: targetAgent.staffRole,
          specialty: targetAgent.specialty,
        });
      }
    }

    return results;
  }

  // -- Private: synthesis ---------------------------------------------

  /**
   * Invoke the personal agent's subprocess to synthesize multiple
   * subtask results into a single response for the member.
   * Falls back to raw result concatenation on LLM failure.
   */
  private async synthesizeResults(
    agent: {
      id: string;
      name: string;
      roleContent: string;
      soulContent: string | null;
    },
    memberName: string,
    completedSubtasks: Array<{ title: string; result: string | null }>,
    failedSubtasks: Array<{ title: string; result: string | null }>,
  ): Promise<string> {
    // Build the synthesis user prompt
    const resultSections: string[] = [];

    for (const subtask of completedSubtasks) {
      resultSections.push(
        `Task: ${subtask.title}\nResult: ${subtask.result ?? "(no result)"}`,
      );
    }

    for (const subtask of failedSubtasks) {
      resultSections.push(
        `Task: ${subtask.title}\nResult: FAILED -- ${subtask.result ?? "(no details)"}`,
      );
    }

    const synthesisUserMessage = [
      `You previously delegated work for ${memberName}. Here are the results:`,
      "",
      ...resultSections.map((s, i) =>
        i < resultSections.length - 1 ? `${s}\n` : s,
      ),
      "",
      `Synthesize these results into a single, helpful response for ${memberName}.`,
      "Maintain your personality (soul). Address them directly.",
    ].join("\n");

    // Build the system prompt using the personal agent's role + soul
    const systemPrompt = compileSystemPrompt({
      mode: "chat",
      roleContent: agent.roleContent,
      soulContent: agent.soulContent,
      softRules: "",
      constitutionDocument: "",
      memberName,
    });

    try {
      const result = await this.adapter.execute({
        systemPrompt,
        messages: [{ role: "user", content: synthesisUserMessage }],
      });

      return result.content;
    } catch (err) {
      // Synthesis LLM call failed -- fall back to raw results
      console.error("[orchestrator] Synthesis LLM call failed:", err);

      const parts = ["Here's what I found:"];

      for (const subtask of completedSubtasks) {
        parts.push("");
        parts.push(`**${subtask.title}**`);
        parts.push(subtask.result ?? "(no result)");
      }

      if (failedSubtasks.length > 0) {
        parts.push("");
        parts.push("Some tasks were unable to complete:");
        for (const subtask of failedSubtasks) {
          parts.push(`- ${subtask.title}: ${subtask.result ?? "(no details)"}`);
        }
      }

      return parts.join("\n");
    }
  }

  // -- Private: data loading ------------------------------------------

  private async loadAgentByName(householdId: string, name: string) {
    const [agent] = await this.db
      .select()
      .from(staffAgents)
      .where(
        and(
          eq(staffAgents.householdId, householdId),
          eq(staffAgents.name, name),
          eq(staffAgents.status, "active"),
        ),
      );
    if (agent) return agent;
    // Case-insensitive retry — specialists are usually referenced by first name
    // with any casing ("bob", "Bob", "BOB").
    const all = await this.db
      .select()
      .from(staffAgents)
      .where(
        and(
          eq(staffAgents.householdId, householdId),
          eq(staffAgents.status, "active"),
        ),
      );
    return all.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  private async loadAgent(agentId: string) {
    const [agent] = await this.db
      .select()
      .from(staffAgents)
      .where(and(eq(staffAgents.id, agentId), eq(staffAgents.status, "active")));

    return agent ?? null;
  }

  private async loadMember(memberId: string) {
    const [member] = await this.db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, memberId));

    return member ?? null;
  }

  // -- Private: event logging -----------------------------------------

  private async logEvent(
    taskId: string,
    eventType: string,
    agentId: string | null,
    message: string | null,
    payload?: unknown,
  ): Promise<void> {
    try {
      await this.db.insert(taskEvents).values({
        taskId,
        eventType,
        agentId: agentId ?? undefined,
        message,
        payload: payload ?? null,
        clauseIds: null,
      });
    } catch (err) {
      console.error("[orchestrator] Failed to log task event:", err);
    }
  }
}

/** Pick a default Developer name when the proposing agent didn't specify one.
 *  Bob for tools, Alice for project work, Claude-self for core — matches the
 *  design doc's named-Developer metaphor. */
function defaultDeveloperName(specialty: DeveloperSpecialty): string {
  switch (specialty) {
    case "tools":
      return "Bob";
    case "project":
      return "Alice";
    case "core":
      return "Claude-self";
  }
}

/** Hire approval card text shown above the inline buttons. Kept terse — the
 *  buttons do the heavy lifting, the card just surfaces what's being decided. */
function composeHireCardText(args: {
  proposedName: string;
  specialty: DeveloperSpecialty;
  reason: string;
}): string {
  const specialtyDescription: Record<DeveloperSpecialty, string> = {
    tools: "builds custom tools in sandboxed workspaces",
    project: "works in your registered projects, opens PRs via gh",
    core: "modifies CarsonOS itself, opens PRs for your review",
  };
  return [
    `<b>Hire ${args.proposedName} the Developer?</b>`,
    "",
    `<i>Specialty:</i> ${args.specialty} — ${specialtyDescription[args.specialty]}`,
    `<i>Reason:</i> ${args.reason}`,
    "",
    `<i>Trust level:</i> full (Bash, Read, Write, Edit, Skill)`,
    `<i>Approval auto-expires in 24h</i>`,
  ].join("\n");
}
