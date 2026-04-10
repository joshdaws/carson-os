/**
 * Task Dispatcher -- execution orchestrator for internal agent tasks.
 *
 * Manages the lifecycle of tasks assigned to internal specialist agents
 * (tutor, coach, scheduler, etc.). Handles per-project isolation,
 * same-project queuing, cross-project parallelism, progress parsing,
 * result extraction, and project completion detection.
 */

import { eq, and } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { tasks, taskEvents, staffAgents } from "@carsonos/db";
import type { Adapter } from "./subprocess-adapter.js";
import type { BroadcastFn } from "./event-bus.js";

// -- Types -----------------------------------------------------------

interface DispatcherConfig {
  db: Db;
  adapter: Adapter;
  broadcast: BroadcastFn;
}

interface RunningSlot {
  taskId: string;
  queue: string[];
}

interface ParsedProgress {
  step: number;
  total: number;
  message: string;
}

interface ParsedResult {
  status: "completed" | "failed";
  content: string;
}

// -- Dispatcher -------------------------------------------------------

export class Dispatcher {
  private db: Db;
  private adapter: Adapter;
  private broadcast: BroadcastFn;

  /** Tracks running agents. Key = `${agentId}:${parentTaskId || 'standalone'}` */
  private running = new Map<string, RunningSlot>();

  constructor(config: DispatcherConfig) {
    this.db = config.db;
    this.adapter = config.adapter;
    this.broadcast = config.broadcast;
  }

  // -- Public API -----------------------------------------------------

  /**
   * Handle a task assignment to an internal agent.
   * If the agent is already running a task for the same project, queue it.
   * If the agent is idle (for this project), execute immediately.
   */
  async handleTaskAssignment(taskId: string): Promise<void> {
    const task = await this.loadTask(taskId);
    if (!task) {
      console.error(`[dispatcher] Task ${taskId} not found`);
      return;
    }

    // Load the agent and verify it's internal
    const agent = await this.loadAgent(task.agentId);
    if (!agent) {
      await this.failTask(taskId, task.agentId, "Agent not found");
      return;
    }

    if (agent.visibility !== "internal") {
      await this.failTask(taskId, agent.id, `Agent "${agent.name}" is not an internal agent (visibility: ${agent.visibility})`);
      return;
    }

    // Enforce delegation depth limit
    if (task.delegationDepth > 1) {
      await this.failTask(taskId, agent.id, `Delegation depth ${task.delegationDepth} exceeds maximum of 1`);
      return;
    }

    const slotKey = this.slotKey(task.agentId, task.parentTaskId);
    const slot = this.running.get(slotKey);

    if (slot) {
      // Agent is already running a task for this project -- queue
      slot.queue.push(taskId);
      return;
    }

    // No running task for this project -- execute
    await this.executeTask(taskId, agent, slotKey);
  }

  /**
   * Recover tasks that were in_progress when the server stopped.
   * Marks them failed and re-queues them as new pending tasks.
   */
  async recoverStuckTasks(): Promise<void> {
    const stuck = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.status, "in_progress"));

    if (stuck.length === 0) return;

    console.log(`[dispatcher] Recovering ${stuck.length} stuck task(s)`);

    for (const task of stuck) {
      // Mark as failed
      await this.db
        .update(tasks)
        .set({
          status: "failed",
          result: "Server restart - task interrupted",
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));

      await this.logEvent(
        task.id,
        "failed",
        task.agentId,
        "Server restart - task interrupted",
        { recovered: true },
      );

      this.broadcast({
        type: "task.failed",
        data: {
          taskId: task.id,
          agentId: task.agentId,
          error: "Server restart - task interrupted",
          recovered: true,
        },
      });

      // Re-queue: create a new pending task with the same params
      const [requeued] = await this.db
        .insert(tasks)
        .values({
          householdId: task.householdId,
          agentId: task.agentId,
          parentTaskId: task.parentTaskId,
          requestedBy: task.requestedBy,
          assignedToMembers: task.assignedToMembers as string[] | null,
          title: task.title,
          description: task.description,
          requiresApproval: false, // skip approval on recovery
          delegationDepth: task.delegationDepth,
          status: "pending",
        })
        .returning();

      await this.logEvent(
        requeued.id,
        "created",
        task.agentId,
        `Re-queued after server restart (original: ${task.id})`,
        { originalTaskId: task.id },
      );

      this.broadcast({
        type: "task.requeued",
        data: {
          taskId: requeued.id,
          originalTaskId: task.id,
          agentId: task.agentId,
        },
      });
    }
  }

  // -- Core execution -------------------------------------------------

  private async executeTask(
    taskId: string,
    agent: { id: string; name: string; roleContent: string; soulContent: string | null },
    slotKey: string,
  ): Promise<void> {
    const task = await this.loadTask(taskId);
    if (!task) {
      console.error(`[dispatcher] Task ${taskId} vanished before execution`);
      this.running.delete(slotKey);
      return;
    }

    // Claim the slot
    this.running.set(slotKey, { taskId, queue: this.running.get(slotKey)?.queue ?? [] });

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(agent, task);

    // Mark as in_progress
    await this.db
      .update(tasks)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    await this.logEvent(taskId, "started", agent.id, "Task execution started");

    this.broadcast({
      type: "task.started",
      data: { taskId, agentId: agent.id },
    });

    // Execute via adapter
    try {
      const result = await this.adapter.execute({
        systemPrompt,
        messages: [
          { role: "user", content: task.description ?? task.title },
        ],
      });

      // Parse progress markers from the response
      const progressMarkers = this.parseProgress(result.content);
      for (const marker of progressMarkers) {
        await this.logEvent(
          taskId,
          "progress_update",
          agent.id,
          marker.message,
          { step: marker.step, total: marker.total },
        );

        this.broadcast({
          type: "task.progress",
          data: {
            taskId,
            agentId: agent.id,
            step: marker.step,
            total: marker.total,
            message: marker.message,
          },
        });
      }

      // Parse result block
      const parsed = this.parseResult(result.content);
      const finalStatus = parsed.status;
      const finalContent = parsed.content;

      // Update task
      await this.db
        .update(tasks)
        .set({
          status: finalStatus,
          result: finalContent,
          updatedAt: new Date(),
          completedAt: finalStatus === "completed" ? new Date() : undefined,
        })
        .where(eq(tasks.id, taskId));

      const eventType = finalStatus === "completed" ? "completed" : "failed";
      await this.logEvent(taskId, eventType, agent.id, `Task ${eventType}`, {
        resultLength: finalContent.length,
      });

      this.broadcast({
        type: `task.${eventType}`,
        data: { taskId, agentId: agent.id, result: finalContent },
      });

      // Check project completion
      if (task.parentTaskId) {
        await this.checkProjectCompletion(task.parentTaskId);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown execution error";

      await this.db
        .update(tasks)
        .set({
          status: "failed",
          result: `Error: ${errorMsg}`,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));

      await this.logEvent(taskId, "failed", agent.id, `Task failed: ${errorMsg}`, {
        error: errorMsg,
      });

      this.broadcast({
        type: "task.failed",
        data: { taskId, agentId: agent.id, error: errorMsg },
      });

      // Still check project completion on failure
      if (task.parentTaskId) {
        await this.checkProjectCompletion(task.parentTaskId);
      }
    }

    // Drain the queue for this slot
    await this.drainQueue(slotKey, agent);
  }

  /**
   * After a task finishes, check if there are more queued tasks
   * for this agent+project slot. If so, pick up the next one.
   * If not, release the slot.
   */
  private async drainQueue(
    slotKey: string,
    agent: { id: string; name: string; roleContent: string; soulContent: string | null },
  ): Promise<void> {
    const slot = this.running.get(slotKey);
    if (!slot) return;

    const nextTaskId = slot.queue.shift();
    if (!nextTaskId) {
      // Nothing queued, release the slot
      this.running.delete(slotKey);
      return;
    }

    // Execute the next queued task (tail-recursive via async)
    await this.executeTask(nextTaskId, agent, slotKey);
  }

  // -- System prompt --------------------------------------------------

  private buildSystemPrompt(
    agent: { roleContent: string; soulContent: string | null },
    task: { title: string; description: string | null },
  ): string {
    const parts: string[] = [];

    // Agent role
    parts.push("# Agent Role\n");
    parts.push(agent.roleContent);
    parts.push("");

    // Agent personality (if present)
    if (agent.soulContent) {
      parts.push("# Agent Identity\n");
      parts.push(agent.soulContent);
      parts.push("");
    }

    // Task-mode instructions
    parts.push("# Task Instructions\n");
    parts.push(`You are executing a task: "${task.title}"`);
    if (task.description) {
      parts.push(`\nDetails: ${task.description}`);
    }
    parts.push("");
    parts.push("Complete the task and provide a clear, concise result.");
    parts.push("If you cannot complete the task, explain why.");
    parts.push("");

    // Progress + result format instructions
    parts.push("# Output Format\n");
    parts.push("As you work through the task, emit progress markers:");
    parts.push('  <progress step="1" total="3" message="Analyzing requirements..."/>');
    parts.push("");
    parts.push("When finished, wrap your final result:");
    parts.push('  <result status="completed">Your result here</result>');
    parts.push("");
    parts.push("If you cannot complete the task:");
    parts.push('  <result status="failed">Explanation of what went wrong</result>');

    return parts.join("\n");
  }

  // -- Parsing --------------------------------------------------------

  /**
   * Extract all <progress step="N" total="M" message="..."/> markers
   * from the adapter response.
   */
  private parseProgress(content: string): ParsedProgress[] {
    const markers: ParsedProgress[] = [];
    const regex = /<progress\s+step="(\d+)"\s+total="(\d+)"\s+message="([^"]*)"\/?\s*>/g;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      markers.push({
        step: parseInt(match[1], 10),
        total: parseInt(match[2], 10),
        message: match[3],
      });
    }

    return markers;
  }

  /**
   * Extract <result status="completed|failed">content</result> from the response.
   * If no result block, treat the entire response as a completed result.
   */
  private parseResult(content: string): ParsedResult {
    const regex = /<result\s+status="(completed|failed)">([\s\S]*?)<\/result>/;
    const match = regex.exec(content);

    if (match) {
      return {
        status: match[1] as "completed" | "failed",
        content: match[2].trim(),
      };
    }

    // Graceful fallback: strip progress tags and use the rest as a completed result
    const cleaned = content
      .replace(/<progress\s+[^>]*\/?\s*>/g, "")
      .trim();

    return {
      status: "completed",
      content: cleaned || content,
    };
  }

  // -- Project completion ---------------------------------------------

  /**
   * After a subtask completes or fails, check if ALL sibling subtasks
   * (same parentTaskId) are done. If so, broadcast project.completed.
   */
  private async checkProjectCompletion(parentTaskId: string): Promise<void> {
    const subtasks = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.parentTaskId, parentTaskId));

    if (subtasks.length === 0) return;

    const allDone = subtasks.every(
      (t) => t.status === "completed" || t.status === "failed",
    );

    if (allDone) {
      const completedCount = subtasks.filter((t) => t.status === "completed").length;
      const failedCount = subtasks.filter((t) => t.status === "failed").length;

      this.broadcast({
        type: "project.completed",
        data: {
          parentTaskId,
          total: subtasks.length,
          completed: completedCount,
          failed: failedCount,
        },
      });
    }
  }

  // -- Helpers --------------------------------------------------------

  private slotKey(agentId: string, parentTaskId: string | null): string {
    return `${agentId}:${parentTaskId || "standalone"}`;
  }

  private async loadTask(taskId: string) {
    const [task] = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));

    return task ?? null;
  }

  private async loadAgent(agentId: string) {
    const [agent] = await this.db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, agentId));

    return agent ?? null;
  }

  private async failTask(
    taskId: string,
    agentId: string,
    reason: string,
  ): Promise<void> {
    await this.db
      .update(tasks)
      .set({
        status: "failed",
        result: `Error: ${reason}`,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    await this.logEvent(taskId, "failed", agentId, reason, { error: reason });

    this.broadcast({
      type: "task.failed",
      data: { taskId, agentId, error: reason },
    });
  }

  private async logEvent(
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
      console.error("[dispatcher] Failed to log task event:", err);
    }
  }
}
