/**
 * Task Engine -- lifecycle management for agent tasks.
 *
 * Handles creation, approval, rejection, execution, and listing.
 * Task execution builds a system prompt from the agent's soul +
 * constitution clauses, then runs through the adapter.
 */

import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import {
  tasks,
  taskEvents,
  staffAgents,
  constitutions,
  constitutionClauses,
} from "@carsonos/db";
import type { TaskStatus } from "@carsonos/shared";
import type { Adapter } from "./subprocess-adapter.js";
import type { ConstitutionEngine } from "./constitution-engine.js";
import type { BroadcastFn } from "./event-bus.js";

// -- Types -----------------------------------------------------------

export interface TaskEngineConfig {
  db: Db;
  adapter: Adapter;
  constitutionEngine: ConstitutionEngine;
  broadcast: BroadcastFn;
}

export interface CreateTaskParams {
  householdId: string;
  agentId: string;
  parentTaskId?: string;
  requestedBy?: string;
  assignedToMembers?: string[];
  title: string;
  description?: string;
  requiresApproval?: boolean;
  delegationDepth?: number;
}

interface TaskFilters {
  status?: TaskStatus;
  agentId?: string;
  memberId?: string;
}

// -- Engine ----------------------------------------------------------

export class TaskEngine {
  private db: Db;
  private adapter: Adapter;
  private constitutionEngine: ConstitutionEngine;
  private broadcast: BroadcastFn;

  constructor(config: TaskEngineConfig) {
    this.db = config.db;
    this.adapter = config.adapter;
    this.constitutionEngine = config.constitutionEngine;
    this.broadcast = config.broadcast;
  }

  async createTask(params: CreateTaskParams) {
    const {
      householdId,
      agentId,
      parentTaskId,
      requestedBy,
      assignedToMembers,
      title,
      description,
      requiresApproval = true,
      delegationDepth = 0,
    } = params;

    const [task] = await this.db
      .insert(tasks)
      .values({
        householdId,
        agentId,
        parentTaskId: parentTaskId ?? null,
        requestedBy: requestedBy ?? null,
        assignedToMembers: assignedToMembers ?? null,
        title,
        description: description ?? null,
        requiresApproval,
        delegationDepth,
        status: "pending",
      })
      .returning();

    // Log creation event
    await this.logTaskEvent(task.id, "created", agentId, `Task created: ${title}`, {
      title,
      requiresApproval,
      parentTaskId,
    });

    this.broadcast({
      type: "task.created",
      data: { taskId: task.id, householdId, agentId, title },
    });

    return task;
  }

  async approveTask(taskId: string, approvedBy: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error("Task not found");

    if (task.status !== "pending") {
      throw new Error(`Cannot approve task in "${task.status}" status`);
    }

    await this.db
      .update(tasks)
      .set({
        status: "approved",
        approvedBy,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    await this.logTaskEvent(taskId, "approved", approvedBy, `Task approved by ${approvedBy}`);

    this.broadcast({
      type: "task.approved",
      data: { taskId, approvedBy },
    });
  }

  async rejectTask(
    taskId: string,
    rejectedBy: string,
    reason?: string,
  ): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error("Task not found");

    if (task.status !== "pending") {
      throw new Error(`Cannot reject task in "${task.status}" status`);
    }

    await this.db
      .update(tasks)
      .set({
        status: "cancelled",
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    await this.logTaskEvent(taskId, "rejected", rejectedBy, reason ?? "Rejected");

    this.broadcast({
      type: "task.rejected",
      data: { taskId, rejectedBy, reason },
    });
  }

  async executeTask(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error("Task not found");

    if (task.status !== "approved" && task.status !== "pending") {
      throw new Error(`Cannot execute task in "${task.status}" status`);
    }

    // -- 1. Load the agent -------------------------------------------
    const [agent] = await this.db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, task.agentId));

    if (!agent) throw new Error("Agent not found for task");

    // -- 2. Load governing clauses -----------------------------------
    const [constitution] = await this.db
      .select()
      .from(constitutions)
      .where(
        and(
          eq(constitutions.householdId, task.householdId),
          eq(constitutions.isActive, true),
        ),
      )
      .limit(1);

    let clauseTexts: string[] = [];
    if (constitution) {
      const clauses = await this.db
        .select()
        .from(constitutionClauses)
        .where(eq(constitutionClauses.constitutionId, constitution.id))
        .orderBy(constitutionClauses.sortOrder);

      // Store governing clause IDs on the task
      const clauseIds = clauses.map((c) => c.id);
      await this.db
        .update(tasks)
        .set({ governingClauses: clauseIds })
        .where(eq(tasks.id, taskId));

      clauseTexts = clauses.map((c) => `- [${c.category}] ${c.clauseText}`);
    }

    // -- 3. Build system prompt --------------------------------------
    const soulPart = agent.soulContent
      ? `# Agent Identity\n\n${agent.soulContent}\n\n`
      : "";

    const clausePart =
      clauseTexts.length > 0
        ? `# Governing Rules\n\n${clauseTexts.join("\n")}\n\n`
        : "";

    const taskInstructions = [
      "# Task Instructions",
      "",
      `You are executing a task: "${task.title}"`,
      task.description ? `\nDetails: ${task.description}` : "",
      "",
      "Complete the task and provide a clear, concise result.",
      "If you cannot complete the task, explain why.",
    ].join("\n");

    const systemPrompt = `${soulPart}${clausePart}${taskInstructions}`;

    // -- 4. Mark as in progress --------------------------------------
    await this.db
      .update(tasks)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    await this.logTaskEvent(taskId, "started", agent.id, "Task execution started");

    this.broadcast({
      type: "task.started",
      data: { taskId, agentId: agent.id },
    });

    // -- 5. Execute via adapter --------------------------------------
    try {
      const result = await this.adapter.execute({
        systemPrompt,
        messages: [
          {
            role: "user",
            content: task.description ?? task.title,
          },
        ],
      });

      // -- 6. Generate brief report ----------------------------------
      const reportPrompt =
        "Summarize the following task result in 2-3 sentences for a parent reviewing their child's agent activity.";

      let report: string;
      try {
        const reportResult = await this.adapter.execute({
          systemPrompt: reportPrompt,
          messages: [
            {
              role: "user",
              content: `Task: ${task.title}\n\nResult: ${result.content}`,
            },
          ],
        });
        report = reportResult.content;
      } catch {
        report = `Task "${task.title}" completed. Review the full result for details.`;
      }

      // -- 7. Update task with results -------------------------------
      await this.db
        .update(tasks)
        .set({
          status: "completed",
          result: result.content,
          report,
          updatedAt: new Date(),
          completedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));

      await this.logTaskEvent(taskId, "completed", agent.id, "Task completed", {
        resultLength: result.content.length,
      });

      this.broadcast({
        type: "task.completed",
        data: { taskId, agentId: agent.id, report },
      });
    } catch (err) {
      // Execution failed
      const errorMsg =
        err instanceof Error ? err.message : "Unknown execution error";

      await this.db
        .update(tasks)
        .set({
          status: "failed",
          result: `Error: ${errorMsg}`,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));

      await this.logTaskEvent(taskId, "failed", agent.id, `Task failed: ${errorMsg}`, { error: errorMsg });

      this.broadcast({
        type: "task.failed",
        data: { taskId, agentId: agent.id, error: errorMsg },
      });
    }
  }

  async getTask(taskId: string) {
    const [task] = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));

    return task ?? null;
  }

  async listTasks(householdId: string, filters?: TaskFilters) {
    const conditions = [eq(tasks.householdId, householdId)];

    if (filters?.status) {
      conditions.push(eq(tasks.status, filters.status));
    }
    if (filters?.agentId) {
      conditions.push(eq(tasks.agentId, filters.agentId));
    }

    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(desc(tasks.createdAt));

    // If memberId filter is set, filter in JS (JSON array column)
    if (filters?.memberId) {
      return rows.filter((task) => {
        const assigned = task.assignedToMembers as string[] | null;
        if (!assigned) return false;
        return assigned.includes(filters.memberId!);
      });
    }

    return rows;
  }

  /** Get all subtasks for a parent task (project) */
  async getSubtasks(parentTaskId: string) {
    return this.db
      .select()
      .from(tasks)
      .where(eq(tasks.parentTaskId, parentTaskId))
      .orderBy(tasks.createdAt);
  }

  /** Check if all subtasks of a project are done (completed or failed) */
  async isProjectComplete(parentTaskId: string): Promise<boolean> {
    const subtasks = await this.getSubtasks(parentTaskId);
    if (subtasks.length === 0) return false;
    return subtasks.every((t) => t.status === "completed" || t.status === "failed");
  }

  // -- Private helpers -----------------------------------------------

  private async logTaskEvent(
    taskId: string,
    eventType: string,
    agentId: string | null,
    message: string | null,
    payload?: unknown,
    clauseIds?: string[],
  ): Promise<void> {
    try {
      await this.db.insert(taskEvents).values({
        taskId,
        eventType,
        agentId: agentId ?? undefined,
        message,
        payload: payload ?? null,
        clauseIds: clauseIds ?? null,
      });
    } catch (err) {
      console.error("[task-engine] Failed to log task event:", err);
    }
  }
}
