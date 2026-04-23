/**
 * Project routes (v0.4) — CRUD for registered projects.
 *
 *   GET    /?householdId=...   — list projects for a household
 *   POST   /                   — register a project
 *   PUT    /:id                — update a project
 *   DELETE /:id                — delete a project
 *   POST   /:id/toggle         — flip the `enabled` flag
 *
 * Explicit registration only in v0.4; folder-scan discovery is v0.5.
 * Projects are consumed by:
 *   - delegation-service.handleDelegateTaskCall (project/core specialty)
 *   - dispatcher.executeDeveloperTask (resolves path, defaultBranch, testCmd)
 */

import { Router } from "express";
import { resolve, isAbsolute } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { projects, tasks } from "@carsonos/db";

// Slug-safe: lowercase, digits, underscore, hyphen. First char alphanumeric.
// Rejects path separators, '..', whitespace, and control chars — name is used
// as a directory segment under ~/.carsonos/worktrees/{name}/.
const PROJECT_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Validate a filesystem path: must be absolute, not contain null bytes, and
 * resolve to itself (no traversal).
 */
function validateProjectPath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null;
  if (raw.includes("\0")) return null;
  if (!isAbsolute(raw)) return null;
  const resolved = resolve(raw);
  if (resolved !== raw) return null;
  return resolved;
}

export function createProjectRoutes(db: Db): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const householdId = req.query.householdId as string;
    if (!householdId) {
      res.status(400).json({ error: "householdId is required" });
      return;
    }
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.householdId, householdId));
    res.json({ projects: rows });
  });

  router.post("/", async (req, res) => {
    const body = req.body as {
      householdId?: string;
      name?: string;
      path?: string;
      defaultBranch?: string;
      testCmd?: string;
      devCmd?: string;
      repoUrl?: string;
      metadata?: unknown;
    };
    if (!body.householdId || !body.name || !body.path) {
      res.status(400).json({ error: "householdId, name, path are required" });
      return;
    }
    if (!PROJECT_NAME_REGEX.test(body.name)) {
      res.status(400).json({
        error:
          "name must be lowercase alphanumeric with _ or - (max 64 chars, starts with a letter or digit)",
      });
      return;
    }
    const normalizedPath = validateProjectPath(body.path);
    if (!normalizedPath) {
      res.status(400).json({ error: "path must be an absolute filesystem path with no traversal" });
      return;
    }
    try {
      const [row] = await db
        .insert(projects)
        .values({
          householdId: body.householdId,
          name: body.name,
          path: normalizedPath,
          defaultBranch: body.defaultBranch ?? "main",
          testCmd: body.testCmd ?? null,
          devCmd: body.devCmd ?? null,
          repoUrl: body.repoUrl ?? null,
          metadata: (body.metadata ?? null) as never,
          enabled: true,
        })
        .returning();
      res.status(201).json({ project: row });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint failed")) {
        res
          .status(409)
          .json({ error: `a project named '${body.name}' already exists in this household` });
        return;
      }
      console.error("[projects] insert failed:", err);
      res.status(500).json({ error: "failed to register project" });
    }
  });

  router.put("/:id", async (req, res) => {
    const id = req.params.id;
    const body = req.body as Partial<{
      name: string;
      path: string;
      defaultBranch: string;
      testCmd: string | null;
      devCmd: string | null;
      repoUrl: string | null;
      enabled: boolean;
      metadata: unknown;
    }>;

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) {
      if (!PROJECT_NAME_REGEX.test(body.name)) {
        res.status(400).json({ error: "name must match the project-name regex" });
        return;
      }
      patch.name = body.name;
    }
    if (body.path !== undefined) {
      const normalized = validateProjectPath(body.path);
      if (!normalized) {
        res.status(400).json({ error: "path must be an absolute filesystem path with no traversal" });
        return;
      }
      patch.path = normalized;
    }
    if (body.defaultBranch !== undefined) patch.defaultBranch = body.defaultBranch;
    if (body.testCmd !== undefined) patch.testCmd = body.testCmd;
    if (body.devCmd !== undefined) patch.devCmd = body.devCmd;
    if (body.repoUrl !== undefined) patch.repoUrl = body.repoUrl;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.metadata !== undefined) patch.metadata = body.metadata;

    try {
      const [row] = await db.update(projects).set(patch).where(eq(projects.id, id)).returning();
      if (!row) {
        res.status(404).json({ error: "project not found" });
        return;
      }
      res.json({ project: row });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint failed")) {
        res.status(409).json({ error: "a project with that name already exists in this household" });
        return;
      }
      console.error("[projects] update failed:", err);
      res.status(500).json({ error: "failed to update project" });
    }
  });

  router.delete("/:id", async (req, res) => {
    const id = req.params.id;
    // Refuse hard-delete if tasks reference this project. SQLite FK enforcement
    // is off globally so the DB can't protect us; prefer a 409 to orphan rows.
    // Soft-retire via POST /:id/toggle if the user wants to disable.
    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(eq(tasks.projectId, id));
    const refs = countRow?.count ?? 0;
    if (refs > 0) {
      res.status(409).json({
        error: `project has ${refs} referencing task(s). Use POST /:id/toggle to soft-disable instead.`,
      });
      return;
    }
    const [row] = await db.delete(projects).where(eq(projects.id, id)).returning();
    if (!row) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    res.json({ deleted: true });
  });

  router.post("/:id/toggle", async (req, res) => {
    const id = req.params.id;
    const [current] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!current) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    const [row] = await db
      .update(projects)
      .set({ enabled: !current.enabled, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();
    res.json({ project: row });
  });

  return router;
}
