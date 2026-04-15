/**
 * Tool routes -- per-agent tool grant management, registry listing, and
 * custom tool administration (list / approve-pending / disable / delete).
 */

import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@carsonos/db";
import { customTools, staffAgents, toolSecrets } from "@carsonos/db";
import type { ToolRegistry } from "../services/tool-registry.js";
import { TOOLS_ROOT, hashToolDir, loadCustomTools } from "../services/custom-tools/index.js";

export interface ToolRouteDeps {
  db: Db;
  toolRegistry: ToolRegistry;
}

export function createToolRoutes(deps: ToolRouteDeps): Router {
  const { db, toolRegistry } = deps;
  const router = Router();

  const listRegistryTools = (householdId?: string) => {
    const sharedTools = toolRegistry.listAll().filter((t) => t.tier !== "custom");
    const customToolsForHousehold = householdId
      ? toolRegistry.listCustom(householdId).map((t) => t.registered)
      : toolRegistry.listAll().filter((t) => t.tier === "custom");
    return [...sharedTools, ...customToolsForHousehold];
  };

  // GET /registry -- all registered tools
  router.get("/registry", async (req, res) => {
    const householdId = typeof req.query.household_id === "string" ? req.query.household_id : undefined;
    const tools = listRegistryTools(householdId).map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      category: t.category,
      tier: t.tier,
    }));
    res.json({ tools });
  });

  // GET /agents/:agentId/grants -- per-agent tool view
  router.get("/agents/:agentId/grants", async (req, res) => {
    const { agentId } = req.params;

    const agent = await db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, agentId))
      .get();

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    // Get agent's granted tools
    const grantedTools = await toolRegistry.getAgentTools(agentId);
    const grantedNames = new Set(grantedTools.map((t) => t.name));

    // Build full tool list with grant status
    const allTools = listRegistryTools(agent.householdId).map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      category: t.category,
      tier: t.tier,
      granted: grantedNames.has(t.definition.name),
    }));

    res.json({
      trustLevel: agent.trustLevel,
      tools: allTools,
    });
  });

  // PUT /agents/:agentId/grants -- toggle a tool grant
  router.put("/agents/:agentId/grants", async (req, res) => {
    const { agentId } = req.params;
    const { toolName, granted } = req.body;

    if (!toolName || typeof granted !== "boolean") {
      res.status(400).json({ error: "toolName (string) and granted (boolean) required" });
      return;
    }

    try {
      if (granted) {
        await toolRegistry.grant(agentId, toolName);
      } else {
        await toolRegistry.revoke(agentId, toolName);
      }
      res.json({ toolName, granted });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Grant update failed";
      res.status(400).json({ error: msg });
    }
  });

  // PUT /agents/:agentId/trust-level -- update trust level
  router.put("/agents/:agentId/trust-level", async (req, res) => {
    const { agentId } = req.params;
    const { trustLevel } = req.body;

    if (!trustLevel || !["full", "standard", "restricted"].includes(trustLevel)) {
      res.status(400).json({ error: "trustLevel must be full, standard, or restricted" });
      return;
    }

    const [updated] = await db
      .update(staffAgents)
      .set({ trustLevel, updatedAt: new Date() })
      .where(eq(staffAgents.id, agentId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    res.json({ trustLevel: updated.trustLevel });
  });

  // ── Custom tools admin ─────────────────────────────────────────────

  // GET /custom — list all custom tools across households for the admin UI
  router.get("/custom", async (req, res) => {
    const { household_id: householdId } = req.query;
    const rows = householdId
      ? db.select().from(customTools).where(eq(customTools.householdId, String(householdId))).all()
      : db.select().from(customTools).all();
    res.json({ customTools: rows });
  });

  // GET /custom/pending — convenience endpoint for the admin approvals queue
  router.get("/custom/pending", async (req, res) => {
    const { household_id: householdId } = req.query;
    const where = householdId
      ? and(eq(customTools.householdId, String(householdId)), inArray(customTools.status, ["pending_approval", "broken"]))
      : inArray(customTools.status, ["pending_approval", "broken"]);
    const rows = db.select().from(customTools).where(where).all();
    res.json({ pending: rows });
  });

  // GET /custom/:id — full detail including SKILL.md body and, for script tools, handler.ts
  router.get("/custom/:id", async (req, res) => {
    const row = db.select().from(customTools).where(eq(customTools.id, req.params.id)).get();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }

    const dir = join(TOOLS_ROOT, row.householdId, row.path);
    const skillPath = join(dir, "SKILL.md");
    const handlerPath = join(dir, "handler.ts");

    let skillMd: string | null = null;
    let handlerTs: string | null = null;
    try {
      if (existsSync(skillPath)) skillMd = readFileSync(skillPath, "utf8");
      if (row.kind === "script" && existsSync(handlerPath)) handlerTs = readFileSync(handlerPath, "utf8");
    } catch (err) {
      res.status(500).json({ error: `Failed to read tool files: ${(err as Error).message}` });
      return;
    }

    res.json({ tool: row, skillMd, handlerTs });
  });

  // POST /custom/:id/approve — approve pending changes to a script tool
  router.post("/custom/:id/approve", async (req, res) => {
    const row = db.select().from(customTools).where(eq(customTools.id, req.params.id)).get();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    if (row.status !== "pending_approval") {
      res.status(400).json({ error: `Tool status is '${row.status}', nothing to approve` });
      return;
    }

    const dir = join(TOOLS_ROOT, row.householdId, row.path);
    try {
      const newHash = hashToolDir(dir);
      db.update(customTools)
        .set({ status: "active", approvedContentHash: newHash, lastError: null, updatedAt: new Date() })
        .where(eq(customTools.id, row.id))
        .run();
      // Reload registry for this household
      await loadCustomTools(db, toolRegistry);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: `Failed to approve: ${(err as Error).message}` });
    }
  });

  // PUT /custom/:id/status — toggle active/disabled
  router.put("/custom/:id/status", async (req, res) => {
    const { status } = req.body as { status?: string };
    if (!status || !["active", "disabled"].includes(status)) {
      res.status(400).json({ error: "status must be 'active' or 'disabled'" });
      return;
    }
    const row = db.select().from(customTools).where(eq(customTools.id, req.params.id)).get();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    if (status === "active" && row.status === "pending_approval") {
      res.status(400).json({ error: "Use /approve for pending script tools (triggers hash update)" });
      return;
    }
    db.update(customTools).set({ status, updatedAt: new Date() }).where(eq(customTools.id, row.id)).run();
    if (status === "disabled") toolRegistry.unregisterCustom(row.householdId, row.name);
    else await loadCustomTools(db, toolRegistry);
    res.json({ ok: true });
  });

  // DELETE /custom/:id — permanent delete (soft via status + future cleanup)
  router.delete("/custom/:id", async (req, res) => {
    const row = db.select().from(customTools).where(eq(customTools.id, req.params.id)).get();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    // Soft delete: mark as disabled and unregister. Files stay on disk.
    // True file deletion happens via a separate sweep to keep admin UI simple.
    db.update(customTools)
      .set({ status: "disabled", lastError: "Deleted by admin", updatedAt: new Date() })
      .where(eq(customTools.id, row.id))
      .run();
    toolRegistry.unregisterCustom(row.householdId, row.name);
    res.json({ ok: true });
  });

  // GET /secrets — list secret key names (NEVER returns values)
  router.get("/secrets", async (req, res) => {
    const { household_id: householdId } = req.query;
    if (!householdId) { res.status(400).json({ error: "household_id required" }); return; }
    const rows = db
      .select({ id: toolSecrets.id, keyName: toolSecrets.keyName, createdAt: toolSecrets.createdAt, updatedAt: toolSecrets.updatedAt })
      .from(toolSecrets)
      .where(eq(toolSecrets.householdId, String(householdId)))
      .all();
    res.json({ secrets: rows });
  });

  // DELETE /secrets/:id — remove a secret
  router.delete("/secrets/:id", async (req, res) => {
    const row = db.select().from(toolSecrets).where(eq(toolSecrets.id, req.params.id)).get();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    db.delete(toolSecrets).where(eq(toolSecrets.id, row.id)).run();
    res.json({ ok: true });
  });

  return router;
}
