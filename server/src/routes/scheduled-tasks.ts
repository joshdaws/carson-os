/**
 * Scheduled task routes — CRUD for recurring agent tasks.
 *
 * Endpoints:
 *   GET    /                — list all scheduled tasks for a household
 *   POST   /                — create a new scheduled task
 *   PUT    /:id             — update a scheduled task
 *   DELETE /:id             — delete a scheduled task
 *   POST   /:id/run         — manually trigger a task now
 *   POST   /:id/toggle      — enable/disable a task
 */

import { Router } from "express";
import { eq, and } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { scheduledTasks, staffAgents } from "@carsonos/db";
import { computeNextRun } from "../services/scheduler.js";

export function createScheduledTaskRoutes(db: Db): Router {
  const router = Router();

  // GET / — list scheduled tasks
  router.get("/", async (req, res) => {
    const householdId = req.query.householdId as string;
    if (!householdId) {
      res.status(400).json({ error: "householdId is required" });
      return;
    }

    // Single query with JOIN for agent names (avoids N+1)
    const tasks = db
      .select({
        id: scheduledTasks.id,
        householdId: scheduledTasks.householdId,
        agentId: scheduledTasks.agentId,
        memberId: scheduledTasks.memberId,
        name: scheduledTasks.name,
        prompt: scheduledTasks.prompt,
        scheduleType: scheduledTasks.scheduleType,
        scheduleValue: scheduledTasks.scheduleValue,
        timezone: scheduledTasks.timezone,
        enabled: scheduledTasks.enabled,
        lastRunAt: scheduledTasks.lastRunAt,
        nextRunAt: scheduledTasks.nextRunAt,
        lastStatus: scheduledTasks.lastStatus,
        lastError: scheduledTasks.lastError,
        runCount: scheduledTasks.runCount,
        createdAt: scheduledTasks.createdAt,
        updatedAt: scheduledTasks.updatedAt,
        agentName: staffAgents.name,
      })
      .from(scheduledTasks)
      .leftJoin(staffAgents, eq(staffAgents.id, scheduledTasks.agentId))
      .where(eq(scheduledTasks.householdId, householdId))
      .all();

    res.json({ scheduledTasks: tasks });
  });

  // POST / — create scheduled task
  router.post("/", async (req, res) => {
    const { householdId, agentId, memberId, name, prompt, scheduleType, scheduleValue, timezone } = req.body;

    if (!householdId || !agentId || !name || !prompt || !scheduleType || !scheduleValue) {
      res.status(400).json({ error: "householdId, agentId, name, prompt, scheduleType, and scheduleValue are required" });
      return;
    }

    if (!["cron", "interval", "once"].includes(scheduleType)) {
      res.status(400).json({ error: "scheduleType must be 'cron', 'interval', or 'once'" });
      return;
    }

    // Compute first run time
    let nextRunAt: Date;
    try {
      nextRunAt = computeNextRun(scheduleType, scheduleValue);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: `Invalid schedule: ${msg}` });
      return;
    }

    const [task] = await db
      .insert(scheduledTasks)
      .values({
        householdId,
        agentId,
        memberId: memberId ?? null,
        name,
        prompt,
        scheduleType,
        scheduleValue,
        timezone: timezone ?? "America/New_York",
        nextRunAt,
      })
      .returning();

    res.status(201).json({ scheduledTask: task });
  });

  // Helper: load task with household verification
  function loadTask(id: string, householdId?: string) {
    const task = db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).get();
    if (!task) return null;
    if (householdId && task.householdId !== householdId) return null;
    return task;
  }

  // PUT /:id — update scheduled task
  router.put("/:id", async (req, res) => {
    const existing = loadTask(req.params.id, req.body.householdId);
    if (!existing) {
      res.status(404).json({ error: "Scheduled task not found" });
      return;
    }

    const { name, prompt, scheduleType, scheduleValue, timezone, agentId, memberId } = req.body;

    let nextRunAt: Date | undefined;
    const newType = scheduleType ?? existing.scheduleType;
    const newValue = scheduleValue ?? existing.scheduleValue;
    const newTz = timezone ?? existing.timezone;
    if (scheduleType !== undefined || scheduleValue !== undefined) {
      try {
        nextRunAt = computeNextRun(newType, newValue, null, newTz);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: `Invalid schedule: ${msg}` });
        return;
      }
    }

    const [updated] = await db
      .update(scheduledTasks)
      .set({
        ...(name !== undefined && { name }),
        ...(prompt !== undefined && { prompt }),
        ...(scheduleType !== undefined && { scheduleType }),
        ...(scheduleValue !== undefined && { scheduleValue }),
        ...(timezone !== undefined && { timezone }),
        ...(agentId !== undefined && { agentId }),
        ...(memberId !== undefined && { memberId }),
        ...(nextRunAt !== undefined && { nextRunAt }),
        updatedAt: new Date(),
      })
      .where(eq(scheduledTasks.id, req.params.id))
      .returning();

    res.json({ scheduledTask: updated });
  });

  // POST /:id/toggle — enable/disable
  router.post("/:id/toggle", async (req, res) => {
    const existing = loadTask(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Scheduled task not found" });
      return;
    }

    const newEnabled = !existing.enabled;

    let nextRunAt: Date | undefined;
    if (newEnabled && existing.scheduleType !== "once") {
      nextRunAt = computeNextRun(existing.scheduleType, existing.scheduleValue, null, existing.timezone);
    }

    const [updated] = await db
      .update(scheduledTasks)
      .set({
        enabled: newEnabled,
        ...(nextRunAt !== undefined && { nextRunAt }),
        updatedAt: new Date(),
      })
      .where(eq(scheduledTasks.id, req.params.id))
      .returning();

    res.json({ scheduledTask: updated });
  });

  // POST /:id/run — trigger a task immediately
  router.post("/:id/run", async (req, res) => {
    const existing = loadTask(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Scheduled task not found" });
      return;
    }

    // Set nextRunAt to now — scheduler picks it up within 60s. Don't change enabled state.
    const [updated] = await db
      .update(scheduledTasks)
      .set({ nextRunAt: new Date(), updatedAt: new Date() })
      .where(eq(scheduledTasks.id, req.params.id))
      .returning();

    res.json({ scheduledTask: updated });
  });

  // DELETE /:id — delete scheduled task
  router.delete("/:id", async (req, res) => {
    const existing = loadTask(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Scheduled task not found" });
      return;
    }

    db.delete(scheduledTasks).where(eq(scheduledTasks.id, req.params.id)).run();
    res.json({ deleted: true });
  });

  return router;
}
