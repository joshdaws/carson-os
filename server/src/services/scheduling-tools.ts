/**
 * Scheduling tool definitions + handler.
 *
 * Provides a schedule_task tool that agents can call to create
 * recurring tasks from conversation. "Remind me every Monday to
 * check Grant's homework" → agent calls schedule_task.
 */

import type { ToolDefinition, ToolResult } from "@carsonos/shared";
import type { Db } from "@carsonos/db";
import { scheduledTasks } from "@carsonos/db";
import { computeNextRun } from "./scheduler.js";

export const SCHEDULE_TOOL: ToolDefinition = {
  name: "schedule_task",
  description:
    "Create a recurring scheduled task. Use this when someone asks you to do something regularly — daily briefings, weekly reminders, periodic check-ins. The task will run automatically at the specified schedule. You can use cron expressions for precise timing or interval strings for simple repeats.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Short name for the task (e.g., 'Daily briefing', 'Weekly meal plan')",
      },
      prompt: {
        type: "string",
        description: "The instructions you'll follow when this task runs. Write this as a prompt to yourself — what should you do, check, or produce?",
      },
      schedule_type: {
        type: "string",
        enum: ["cron", "interval", "once"],
        description: "Type of schedule. 'cron' for specific times (daily at 6am), 'interval' for regular repeats (every 2 hours), 'once' for a single future execution.",
      },
      schedule_value: {
        type: "string",
        description: "The schedule expression. Cron: '0 6 * * *' (6am daily), '0 9 * * 1' (Mondays 9am). Interval: '30m', '2h', '1d', '1w'. Once: ISO timestamp.",
      },
      deliver_to: {
        type: "string",
        enum: ["telegram", "memory", "log"],
        description: "Where to send the result. 'telegram' sends to the member's Telegram. 'memory' saves the result as a memory entry. 'log' just records it in the activity log. Default: 'telegram'.",
      },
    },
    required: ["name", "prompt", "schedule_type", "schedule_value"],
  },
};

export interface ScheduleToolContext {
  db: Db;
  agentId: string;
  memberId: string;
  householdId: string;
}

export async function handleScheduleTask(
  ctx: ScheduleToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const name = input.name as string;
  const prompt = input.prompt as string;
  const scheduleType = input.schedule_type as string;
  const scheduleValue = input.schedule_value as string;
  const deliverTo = (input.deliver_to as string) ?? "telegram";

  if (!["cron", "interval", "once"].includes(scheduleType)) {
    return { content: `Invalid schedule_type: ${scheduleType}. Use 'cron', 'interval', or 'once'.`, is_error: true };
  }

  // Validate schedule and compute first run
  let nextRunAt: Date;
  try {
    nextRunAt = computeNextRun(scheduleType, scheduleValue);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Invalid schedule: ${msg}`, is_error: true };
  }

  // Store deliver_to in the prompt as a metadata prefix so the scheduler knows
  const enrichedPrompt = deliverTo !== "telegram"
    ? `[deliver:${deliverTo}]\n${prompt}`
    : prompt;

  const [task] = await ctx.db
    .insert(scheduledTasks)
    .values({
      householdId: ctx.householdId,
      agentId: ctx.agentId,
      memberId: ctx.memberId,
      name,
      prompt: enrichedPrompt,
      scheduleType,
      scheduleValue,
      nextRunAt,
    })
    .returning();

  // Format next run for display
  const nextRunStr = nextRunAt.toLocaleString();

  return {
    content: `Scheduled task created: "${name}"\nSchedule: ${scheduleType} ${scheduleValue}\nNext run: ${nextRunStr}\nDelivery: ${deliverTo}\n\nI'll handle this automatically from now on.`,
  };
}
