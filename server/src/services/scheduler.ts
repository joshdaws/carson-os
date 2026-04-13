/**
 * Scheduled Task Scheduler — in-process ticker for recurring agent work.
 *
 * Checks every 60 seconds for tasks whose nextRunAt has passed.
 * Due tasks are executed through the constitution engine (same path
 * as a Telegram message, but triggered by the clock).
 *
 * Schedule types:
 *   - cron: standard cron expression ("0 6 * * *" = daily at 6am)
 *   - interval: duration string ("24h", "30m", "1w")
 *   - once: ISO timestamp (runs once, then disables)
 */

import { eq, and, lte, isNotNull } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { scheduledTasks, staffAgents } from "@carsonos/db";
import type { ConstitutionEngine } from "./constitution-engine.js";
import type { MultiRelayManager } from "./multi-relay-manager.js";
import type { MemoryProvider } from "@carsonos/shared";
import { familyMembers } from "@carsonos/db";

const TICK_INTERVAL_MS = 60_000; // Check every 60 seconds

// ── Schedule parsing ──────────────────────────────────────────────

/**
 * Parse an interval string like "30m", "2h", "1d", "1w" into milliseconds.
 */
function parseInterval(value: string): number {
  const match = value.match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!match) throw new Error(`Invalid interval: ${value}`);
  const num = parseInt(match[1], 10);
  switch (match[2].toLowerCase()) {
    case "s": return num * 1000;
    case "m": return num * 60_000;
    case "h": return num * 3_600_000;
    case "d": return num * 86_400_000;
    case "w": return num * 604_800_000;
    default: throw new Error(`Invalid interval unit: ${match[2]}`);
  }
}

/**
 * Compute the next run time for a cron expression.
 * Simple implementation supporting: minute hour day-of-month month day-of-week
 */
function nextCronRun(cronExpr: string, after: Date = new Date()): Date {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron: ${cronExpr}`);

  const [minExpr, hourExpr] = parts;

  // Simple implementation: supports specific values and wildcards
  // For MVP, handle the common cases: "0 6 * * *" (daily at 6am), "0 * * * *" (hourly)
  const targetMin = minExpr === "*" ? null : parseInt(minExpr, 10);
  const targetHour = hourExpr === "*" ? null : parseInt(hourExpr, 10);

  const next = new Date(after.getTime() + 60_000); // start from at least 1 minute after
  next.setSeconds(0, 0);

  // Try each minute for the next 48 hours
  const limit = 48 * 60;
  for (let i = 0; i < limit; i++) {
    const m = next.getMinutes();
    const h = next.getHours();

    if ((targetMin === null || m === targetMin) && (targetHour === null || h === targetHour)) {
      return next;
    }

    next.setMinutes(next.getMinutes() + 1);
  }

  // Fallback: 24 hours from now
  return new Date(after.getTime() + 86_400_000);
}

/**
 * Compute the next run time based on schedule type.
 */
export function computeNextRun(
  scheduleType: string,
  scheduleValue: string,
  lastRunAt?: Date | null,
): Date {
  const now = new Date();

  switch (scheduleType) {
    case "cron":
      return nextCronRun(scheduleValue, lastRunAt ?? now);

    case "interval": {
      const ms = parseInterval(scheduleValue);
      const base = lastRunAt ?? now;
      return new Date(base.getTime() + ms);
    }

    case "once": {
      return new Date(scheduleValue);
    }

    default:
      throw new Error(`Unknown schedule type: ${scheduleType}`);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────

export interface SchedulerDeps {
  db: Db;
  engine: ConstitutionEngine;
  multiRelay?: MultiRelayManager;
  memoryProvider?: MemoryProvider;
}

export class Scheduler {
  private db: Db;
  private engine: ConstitutionEngine;
  private multiRelay?: MultiRelayManager;
  private memoryProvider?: MemoryProvider;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: SchedulerDeps) {
    this.db = deps.db;
    this.engine = deps.engine;
    this.multiRelay = deps.multiRelay;
    this.memoryProvider = deps.memoryProvider;
  }

  /** Start the ticker. */
  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    // Run an initial tick shortly after boot
    setTimeout(() => this.tick(), 5_000);
    console.log("[scheduler] Started (60s tick interval)");
  }

  /** Stop the ticker. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Check for and execute due tasks. */
  private async tick(): Promise<void> {
    if (this.running) return; // Skip if previous tick is still running
    this.running = true;

    try {
      const now = new Date();

      // Find enabled tasks whose nextRunAt has passed
      const dueTasks = this.db
        .select()
        .from(scheduledTasks)
        .where(
          and(
            eq(scheduledTasks.enabled, true),
            isNotNull(scheduledTasks.nextRunAt),
            lte(scheduledTasks.nextRunAt, now),
          ),
        )
        .all();

      for (const task of dueTasks) {
        await this.executeTask(task);
      }
    } catch (err) {
      console.error("[scheduler] Tick error:", err);
    } finally {
      this.running = false;
    }
  }

  /** Execute a single scheduled task. */
  private async executeTask(task: typeof scheduledTasks.$inferSelect): Promise<void> {
    const startTime = Date.now();
    console.log(`[scheduler] Running "${task.name}" (agent: ${task.agentId})`);

    try {
      // Load the agent to find which member to run as
      const agent = this.db
        .select()
        .from(staffAgents)
        .where(eq(staffAgents.id, task.agentId))
        .get();

      if (!agent) {
        throw new Error(`Agent ${task.agentId} not found`);
      }

      // Use the task's memberId, or fall back to the first assigned member
      const memberId = task.memberId;
      if (!memberId) {
        throw new Error("No member associated with this scheduled task");
      }

      // Parse delivery mode from prompt prefix (e.g., "[deliver:memory]\n...")
      let deliverTo = "telegram";
      let actualPrompt = task.prompt;
      const deliverMatch = task.prompt.match(/^\[deliver:(\w+)\]\n/);
      if (deliverMatch) {
        deliverTo = deliverMatch[1];
        actualPrompt = task.prompt.slice(deliverMatch[0].length);
      }

      // Execute through the constitution engine (same as a Telegram message)
      const result = await this.engine.processMessage({
        agentId: task.agentId,
        memberId,
        householdId: task.householdId,
        message: actualPrompt,
        channel: "scheduled",
      });

      const durationMs = Date.now() - startTime;

      // Deliver the response
      if (result.response && !result.blocked) {
        await this.deliver(deliverTo, result.response, task, memberId);
      }

      // Compute next run
      const nextRun = task.scheduleType === "once"
        ? null
        : computeNextRun(task.scheduleType, task.scheduleValue, new Date());

      // Update task record
      this.db
        .update(scheduledTasks)
        .set({
          lastRunAt: new Date(),
          nextRunAt: nextRun,
          lastStatus: result.blocked ? "blocked" : "success",
          lastError: null,
          runCount: task.runCount + 1,
          // Disable one-shot tasks after execution
          ...(task.scheduleType === "once" ? { enabled: false } : {}),
          updatedAt: new Date(),
        })
        .where(eq(scheduledTasks.id, task.id))
        .run();

      console.log(`[scheduler] "${task.name}" completed in ${durationMs}ms`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] "${task.name}" failed:`, msg);

      // Compute next run even on failure (don't stop recurring tasks)
      const nextRun = task.scheduleType === "once"
        ? null
        : computeNextRun(task.scheduleType, task.scheduleValue, new Date());

      this.db
        .update(scheduledTasks)
        .set({
          lastRunAt: new Date(),
          nextRunAt: nextRun,
          lastStatus: "error",
          lastError: msg,
          runCount: task.runCount + 1,
          ...(task.scheduleType === "once" ? { enabled: false } : {}),
          updatedAt: new Date(),
        })
        .where(eq(scheduledTasks.id, task.id))
        .run();
    }
  }

  /** Deliver a scheduled task's response to the appropriate channel. */
  private async deliver(
    mode: string,
    response: string,
    task: typeof scheduledTasks.$inferSelect,
    memberId: string,
  ): Promise<void> {
    try {
      switch (mode) {
        case "telegram": {
          if (this.multiRelay) {
            const member = this.db
              .select({ telegramUserId: familyMembers.telegramUserId, name: familyMembers.name })
              .from(familyMembers)
              .where(eq(familyMembers.id, memberId))
              .get();

            if (!member?.telegramUserId) {
              console.warn(`[scheduler] No Telegram ID for member ${memberId} — falling back to log`);
              break;
            }

            // Try the assigned agent's bot first, fall back to any bot that works
            // (Telegram requires the user to message the bot first)
            try {
              await this.multiRelay.sendMessage(task.agentId, member.telegramUserId, response);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes("chat not found") || msg.includes("bot was blocked")) {
                console.warn(`[scheduler] ${member.name} hasn't messaged this bot yet — trying other bots`);
                const sent = await this.multiRelay.sendToAnyBot(member.telegramUserId, response, task.agentId);
                if (!sent) {
                  console.warn(`[scheduler] Could not reach ${member.name} on Telegram — they need to message a bot first`);
                }
              } else {
                throw err;
              }
            }
          }
          break;
        }

        case "memory": {
          // Save the response as a memory entry
          if (this.memoryProvider) {
            const memberSlug = this.getMemberSlug(memberId);
            if (memberSlug) {
              await this.memoryProvider.save(memberSlug, {
                type: "event",
                title: `${task.name} — ${new Date().toLocaleDateString()}`,
                content: response,
                frontmatter: { source: "scheduled-task", taskId: task.id },
              });
            }
          }
          break;
        }

        case "log":
        default:
          // Just log it — the activity log entry is created by the constitution engine
          console.log(`[scheduler] "${task.name}" result (${response.length} chars)`);
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Delivery failed for "${task.name}" (${mode}):`, msg);
    }
  }

  /** Get the member's slug for memory collection lookup. */
  private getMemberSlug(memberId: string): string | null {
    const member = this.db
      .select({ name: familyMembers.name })
      .from(familyMembers)
      .where(eq(familyMembers.id, memberId))
      .get();

    if (!member) return null;
    return member.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  }
}
