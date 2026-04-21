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
import { and, eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { projects } from "@carsonos/db";

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
    try {
      const [row] = await db
        .insert(projects)
        .values({
          householdId: body.householdId,
          name: body.name,
          path: body.path,
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
      res.status(500).json({ error: `failed to register project: ${msg}` });
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
    if (body.name !== undefined) patch.name = body.name;
    if (body.path !== undefined) patch.path = body.path;
    if (body.defaultBranch !== undefined) patch.defaultBranch = body.defaultBranch;
    if (body.testCmd !== undefined) patch.testCmd = body.testCmd;
    if (body.devCmd !== undefined) patch.devCmd = body.devCmd;
    if (body.repoUrl !== undefined) patch.repoUrl = body.repoUrl;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.metadata !== undefined) patch.metadata = body.metadata;

    const [row] = await db.update(projects).set(patch).where(eq(projects.id, id)).returning();
    if (!row) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    res.json({ project: row });
  });

  router.delete("/:id", async (req, res) => {
    const id = req.params.id;
    const [row] = await db.delete(projects).where(eq(projects.id, id)).returning();
    if (!row) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    res.json({ deleted: row.id });
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
      .where(and(eq(projects.id, id)))
      .returning();
    res.json({ project: row });
  });

  return router;
}
