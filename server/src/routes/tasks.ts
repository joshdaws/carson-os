/**
 * Task routes -- lifecycle management for agent tasks.
 *
 * Create, list, approve, reject, execute.
 */

import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { tasks, taskEvents, staffAgents, familyMembers } from "@carsonos/db";
import type { TaskStatus } from "@carsonos/shared";
import type { TaskEngine } from "../services/task-engine.js";
import type { CarsonOversight } from "../services/carson-oversight.js";
import type { DelegationService } from "../services/delegation-service.js";

export interface TaskRouteDeps {
  db: Db;
  taskEngine: TaskEngine;
  oversight: CarsonOversight;
  delegationService: DelegationService;
}

export function createTaskRoutes(deps: TaskRouteDeps): Router {
  const { db, taskEngine, oversight, delegationService } = deps;
  const router = Router();

  /** Resolve agent_id + requested_by on a batch of task rows to the actual
   * display names. Single SELECT per reference table, keyed by the set of
   * ids present on the batch. The UI used to fall back to "Unknown agent"
   * and render raw memberId UUIDs — this closes that. */
  async function enrichTaskNames<T extends { agentId: string; requestedBy: string | null }>(
    householdId: string,
    rows: T[],
  ): Promise<Array<T & { agentName: string | null; requestedByName: string | null }>> {
    if (rows.length === 0) return [];
    const agentIds = Array.from(new Set(rows.map((r) => r.agentId)));
    const memberIds = Array.from(new Set(rows.map((r) => r.requestedBy).filter((x): x is string => !!x)));

    // Both lookups are scoped to the task's household so a stale/foreign
    // agent_id or requested_by can't leak a name from another family. SQL-
    // side IN-filter (not JS) so the query plan is narrow.
    const [agents, members] = await Promise.all([
      agentIds.length === 0
        ? Promise.resolve([] as { id: string; name: string }[])
        : db
            .select({ id: staffAgents.id, name: staffAgents.name })
            .from(staffAgents)
            .where(
              and(
                eq(staffAgents.householdId, householdId),
                inArray(staffAgents.id, agentIds),
              ),
            ),
      memberIds.length === 0
        ? Promise.resolve([] as { id: string; name: string }[])
        : db
            .select({ id: familyMembers.id, name: familyMembers.name })
            .from(familyMembers)
            .where(
              and(
                eq(familyMembers.householdId, householdId),
                inArray(familyMembers.id, memberIds),
              ),
            ),
    ]);

    const agentName = new Map(agents.map((a) => [a.id, a.name]));
    const memberName = new Map(members.map((m) => [m.id, m.name]));
    return rows.map((r) => ({
      ...r,
      agentName: agentName.get(r.agentId) ?? null,
      requestedByName: r.requestedBy ? memberName.get(r.requestedBy) ?? null : null,
    }));
  }

  // GET / -- list tasks with optional filters
  router.get("/", async (req, res) => {
    const { status, agentId, memberId, householdId } = req.query;

    if (!householdId || typeof householdId !== "string") {
      res.status(400).json({ error: "householdId query param is required" });
      return;
    }

    const taskList = await taskEngine.listTasks(householdId, {
      status: status as TaskStatus | undefined,
      agentId: agentId as string | undefined,
      memberId: memberId as string | undefined,
    });

    const enriched = await enrichTaskNames(householdId, taskList);
    res.json({ tasks: enriched });
  });

  // GET /projects -- list projects (top-level tasks with subtasks)
  router.get("/projects", async (req, res) => {
    const { householdId } = req.query;

    if (!householdId || typeof householdId !== "string") {
      res.status(400).json({ error: "householdId query param is required" });
      return;
    }

    // Get all tasks that are parents (have children)
    const allTasks = await taskEngine.listTasks(householdId);
    const parentIds = new Set(
      allTasks.filter((t) => t.parentTaskId).map((t) => t.parentTaskId),
    );

    const projects = allTasks
      .filter((t) => !t.parentTaskId && parentIds.has(t.id))
      .map((project) => {
        const subtasks = allTasks.filter((t) => t.parentTaskId === project.id);
        const completed = subtasks.filter((t) => t.status === "completed").length;
        return {
          ...project,
          subtasks,
          progress: { completed, total: subtasks.length },
        };
      })
      .filter((p) => p.subtasks.length > 0); // only show tasks that actually have subtasks

    res.json({ projects });
  });

  // GET /:id -- task detail with events and subtasks
  router.get("/:id", async (req, res) => {
    const task = await taskEngine.getTask(req.params.id);

    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const events = await db
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, task.id))
      .orderBy(desc(taskEvents.createdAt))
      .all();

    // If this is a project (parent task), also load subtasks
    const subtasks = await taskEngine.getSubtasks(task.id);

    const [[enrichedTask], enrichedSubtasks] = await Promise.all([
      enrichTaskNames(task.householdId, [task]),
      enrichTaskNames(task.householdId, subtasks),
    ]);

    res.json({ task: enrichedTask, events, subtasks: enrichedSubtasks });
  });

  // POST / -- create task
  router.post("/", async (req, res) => {
    const {
      householdId,
      agentId,
      requestedBy,
      assignedToMembers,
      title,
      description,
      requiresApproval,
    } = req.body;

    if (!householdId || !agentId || !title) {
      res
        .status(400)
        .json({ error: "householdId, agentId, and title are required" });
      return;
    }

    const task = await taskEngine.createTask({
      householdId,
      agentId,
      requestedBy,
      assignedToMembers,
      title,
      description,
      requiresApproval,
    });

    // Run oversight review
    const review = await oversight.reviewTask(task.id);

    if (review.approved) {
      await taskEngine.approveTask(task.id, "carson-oversight");
    }

    // Refetch task with updated status
    const updatedTask = await taskEngine.getTask(task.id);

    res.status(201).json({
      task: updatedTask,
      oversight: review,
    });
  });

  // POST /:id/approve -- approve a task
  router.post("/:id/approve", async (req, res) => {
    const { approvedBy } = req.body;

    if (!approvedBy) {
      res.status(400).json({ error: "approvedBy is required" });
      return;
    }

    try {
      await taskEngine.approveTask(req.params.id, approvedBy);
      const task = await taskEngine.getTask(req.params.id);
      res.json({ task });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to approve task";
      res.status(400).json({ error: message });
    }
  });

  // POST /:id/reject -- reject a task
  router.post("/:id/reject", async (req, res) => {
    const { rejectedBy, reason } = req.body;

    if (!rejectedBy) {
      res.status(400).json({ error: "rejectedBy is required" });
      return;
    }

    try {
      await taskEngine.rejectTask(req.params.id, rejectedBy, reason);
      const task = await taskEngine.getTask(req.params.id);
      res.json({ task });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to reject task";
      res.status(400).json({ error: message });
    }
  });

  // POST /:id/approve-hire -- approve a hire_proposal task via the Web UI
  // (fallback path when the Telegram callback_query handler isn't an option:
  // bot offline, user not set up on Telegram, admin doing a bulk review).
  // Routes through DelegationService.handleHireApproval so the v0.4
  // materialization (staff_agents insert + delegation_edges + auto-delegate
  // if originalUserRequest is set) runs the same way as the Telegram path.
  router.post("/:id/approve-hire", async (req, res) => {
    const approvedBy = typeof req.body?.approvedBy === "string" ? req.body.approvedBy : "web-ui";
    const result = await delegationService.handleHireApproval(req.params.id, approvedBy);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  // POST /:id/reject-hire -- reject a hire_proposal task via the Web UI.
  router.post("/:id/reject-hire", async (req, res) => {
    const rejectedBy = typeof req.body?.rejectedBy === "string" ? req.body.rejectedBy : "web-ui";
    const result = await delegationService.handleHireRejection(req.params.id, rejectedBy);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  // POST /:id/execute -- execute a task
  router.post("/:id/execute", async (req, res) => {
    try {
      await taskEngine.executeTask(req.params.id);
      const task = await taskEngine.getTask(req.params.id);
      res.json({ task });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to execute task";
      res.status(400).json({ error: message });
    }
  });

  return router;
}
