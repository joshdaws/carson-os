/**
 * Scheduling tool definitions + handlers.
 *
 * Tools for agents to create and manage recurring scheduled tasks:
 *   - schedule_task: create a new scheduled task
 *   - list_scheduled_tasks: see all tasks for this household
 *   - pause_scheduled_task: pause or resume a task
 *   - update_scheduled_task: change a task's prompt, schedule, etc.
 *   - delete_scheduled_task: remove a task
 */

import { eq, and } from "drizzle-orm";
import type { ToolDefinition, ToolResult } from "@carsonos/shared";
import type { Db } from "@carsonos/db";
import { scheduledTasks } from "@carsonos/db";
import { computeNextRun } from "./scheduler.js";

export interface ScheduleToolContext {
  db: Db;
  agentId: string;
  memberId: string;
  householdId: string;
}

// ── Tool definitions ──────────────────────────────────────────────

export const SCHEDULING_TOOLS: ToolDefinition[] = [
  {
    name: "schedule_task",
    description:
      "Create a recurring scheduled task. Use this when someone asks you to do something regularly — daily briefings, weekly reminders, periodic check-ins. The task will run automatically at the specified schedule.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name (e.g., 'Daily briefing', 'Weekly meal plan')" },
        prompt: { type: "string", description: "The instructions to follow when this task runs. Write as a prompt to yourself." },
        schedule_type: { type: "string", enum: ["cron", "interval", "once"], description: "'cron' for specific times, 'interval' for regular repeats, 'once' for single future execution." },
        schedule_value: { type: "string", description: "Cron: '0 6 * * *' (6am daily). Interval: '30m', '2h', '1d'. Once: ISO timestamp." },
        deliver_to: { type: "string", enum: ["telegram", "memory", "log"], description: "Where to send the result. Default: 'telegram'." },
      },
      required: ["name", "prompt", "schedule_type", "schedule_value"],
    },
  },
  {
    name: "list_scheduled_tasks",
    description:
      "List all scheduled tasks for this household. Shows task name, schedule, status, next run time, and whether it's active or paused. Use this to check what recurring tasks exist before creating new ones or when someone asks about their schedules.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "pause_scheduled_task",
    description:
      "Pause or resume a scheduled task. Paused tasks won't run until resumed. Use this when someone says 'stop that', 'pause the briefing', 'turn off the reminders', etc.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID (from list_scheduled_tasks results)." },
        action: { type: "string", enum: ["pause", "resume"], description: "'pause' to stop it, 'resume' to start it again." },
      },
      required: ["task_id", "action"],
    },
  },
  {
    name: "update_scheduled_task",
    description:
      "Update a scheduled task's prompt, schedule, or name. Use this when someone wants to change when something runs or what it does.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID (from list_scheduled_tasks results)." },
        name: { type: "string", description: "New name (optional)." },
        prompt: { type: "string", description: "New prompt (optional)." },
        schedule_type: { type: "string", enum: ["cron", "interval", "once"], description: "New schedule type (optional)." },
        schedule_value: { type: "string", description: "New schedule value (optional)." },
      },
      required: ["task_id"],
    },
  },
  {
    name: "delete_scheduled_task",
    description:
      "Permanently delete a scheduled task. Use this when someone says 'cancel that task', 'remove the reminder', 'I don't need that anymore'.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID (from list_scheduled_tasks results)." },
      },
      required: ["task_id"],
    },
  },
  {
    name: "run_scheduled_task",
    description:
      "Run a scheduled task immediately, right now, without waiting for its next scheduled time. The task stays on its normal schedule too — this is just an extra run. Use when someone says 'run the briefing now', 'give me the report early', etc.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID (from list_scheduled_tasks results)." },
      },
      required: ["task_id"],
    },
  },
];

// ── Handlers ──────────────────────────────────────────────────────

export async function handleSchedulingTool(
  ctx: ScheduleToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "schedule_task": return handleCreate(ctx, input);
    case "list_scheduled_tasks": return handleList(ctx);
    case "pause_scheduled_task": return handlePause(ctx, input);
    case "run_scheduled_task": return handleRunNow(ctx, input);
    case "update_scheduled_task": return handleUpdate(ctx, input);
    case "delete_scheduled_task": return handleDelete(ctx, input);
    default: return { content: `Unknown scheduling tool: ${name}`, is_error: true };
  }
}

async function handleCreate(ctx: ScheduleToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const taskName = input.name as string;
  const prompt = input.prompt as string;
  const scheduleType = input.schedule_type as string;
  const scheduleValue = input.schedule_value as string;
  const deliverTo = (input.deliver_to as string) ?? "telegram";

  if (!["cron", "interval", "once"].includes(scheduleType)) {
    return { content: `Invalid schedule_type: ${scheduleType}. Use 'cron', 'interval', or 'once'.`, is_error: true };
  }

  let nextRunAt: Date;
  try {
    nextRunAt = computeNextRun(scheduleType, scheduleValue);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Invalid schedule: ${msg}`, is_error: true };
  }

  const enrichedPrompt = deliverTo !== "telegram" ? `[deliver:${deliverTo}]\n${prompt}` : prompt;

  const [task] = await ctx.db
    .insert(scheduledTasks)
    .values({
      householdId: ctx.householdId,
      agentId: ctx.agentId,
      memberId: ctx.memberId,
      name: taskName,
      prompt: enrichedPrompt,
      scheduleType,
      scheduleValue,
      nextRunAt,
    })
    .returning();

  return {
    content: `Scheduled task created: "${taskName}" (id: ${task.id})\nSchedule: ${scheduleType} ${scheduleValue}\nNext run: ${nextRunAt.toLocaleString()}\nDelivery: ${deliverTo}`,
  };
}

async function handleList(ctx: ScheduleToolContext): Promise<ToolResult> {
  const tasks = ctx.db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.householdId, ctx.householdId))
    .all();

  if (tasks.length === 0) {
    return { content: "No scheduled tasks found." };
  }

  const lines = tasks.map((t) => {
    const status = t.enabled ? "active" : "paused";
    const cleanPrompt = t.prompt.replace(/^\[deliver:\w+\]\n/, "").slice(0, 80);
    const nextRun = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : "—";
    const fullClean = t.prompt.replace(/^\[deliver:\w+\]\n/, "");
    return `- ${t.name} (id: ${t.id})\n  Status: ${status} | Schedule: ${t.scheduleType} ${t.scheduleValue} | Next: ${nextRun}\n  Prompt: ${cleanPrompt}${fullClean.length > 80 ? "..." : ""}`;
  });

  return { content: `${tasks.length} scheduled task(s):\n\n${lines.join("\n\n")}` };
}

async function handlePause(ctx: ScheduleToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const taskId = input.task_id as string;
  const action = input.action as string;

  const existing = ctx.db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.householdId, ctx.householdId)))
    .get();

  if (!existing) {
    return { content: `Task "${taskId}" not found.`, is_error: true };
  }

  const newEnabled = action === "resume";

  let nextRunAt: Date | undefined;
  if (newEnabled && existing.scheduleType !== "once") {
    nextRunAt = computeNextRun(existing.scheduleType, existing.scheduleValue);
  }

  await ctx.db
    .update(scheduledTasks)
    .set({
      enabled: newEnabled,
      ...(nextRunAt !== undefined && { nextRunAt }),
      lastStatus: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(scheduledTasks.id, taskId));

  return {
    content: `Task "${existing.name}" ${newEnabled ? "resumed" : "paused"}.${nextRunAt ? ` Next run: ${nextRunAt.toLocaleString()}` : ""}`,
  };
}

async function handleUpdate(ctx: ScheduleToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const taskId = input.task_id as string;

  const existing = ctx.db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.householdId, ctx.householdId)))
    .get();

  if (!existing) {
    return { content: `Task "${taskId}" not found.`, is_error: true };
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const changes: string[] = [];

  if (input.name !== undefined) { updates.name = input.name; changes.push(`name → "${input.name}"`); }
  if (input.prompt !== undefined) { updates.prompt = input.prompt; changes.push("prompt updated"); }

  if (input.schedule_type !== undefined || input.schedule_value !== undefined) {
    const newType = (input.schedule_type as string) ?? existing.scheduleType;
    const newValue = (input.schedule_value as string) ?? existing.scheduleValue;
    try {
      const nextRunAt = computeNextRun(newType, newValue);
      updates.scheduleType = newType;
      updates.scheduleValue = newValue;
      updates.nextRunAt = nextRunAt;
      changes.push(`schedule → ${newType} ${newValue}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Invalid schedule: ${msg}`, is_error: true };
    }
  }

  if (changes.length === 0) {
    return { content: "Nothing to update — provide at least one field to change." };
  }

  await ctx.db.update(scheduledTasks).set(updates).where(eq(scheduledTasks.id, taskId));

  return { content: `Task "${existing.name}" updated: ${changes.join(", ")}` };
}

async function handleDelete(ctx: ScheduleToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const taskId = input.task_id as string;

  const existing = ctx.db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.householdId, ctx.householdId)))
    .get();

  if (!existing) {
    return { content: `Task "${taskId}" not found.`, is_error: true };
  }

  ctx.db.delete(scheduledTasks).where(eq(scheduledTasks.id, taskId)).run();

  return { content: `Task "${existing.name}" deleted.` };
}

async function handleRunNow(ctx: ScheduleToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const taskId = input.task_id as string;

  const existing = ctx.db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.householdId, ctx.householdId)))
    .get();

  if (!existing) {
    return { content: `Task "${taskId}" not found.`, is_error: true };
  }

  // Set nextRunAt to now — scheduler picks it up within 60 seconds.
  // Temporarily enable if paused (scheduler checks enabled), but restore after execution.
  // For simplicity: just set nextRunAt. If task is paused, warn the user.
  if (!existing.enabled) {
    return { content: `Task "${existing.name}" is currently paused. Resume it first, or I can resume and run it. Say "resume and run ${existing.name}".`, is_error: true };
  }

  await ctx.db
    .update(scheduledTasks)
    .set({
      nextRunAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(scheduledTasks.id, taskId));

  return { content: `Task "${existing.name}" will run within the next minute.` };
}
