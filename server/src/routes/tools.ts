/**
 * Tool routes -- per-agent tool grant management and registry listing.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { staffAgents } from "@carsonos/db";
import type { ToolRegistry } from "../services/tool-registry.js";

export interface ToolRouteDeps {
  db: Db;
  toolRegistry: ToolRegistry;
}

export function createToolRoutes(deps: ToolRouteDeps): Router {
  const { db, toolRegistry } = deps;
  const router = Router();

  // GET /registry -- all registered tools
  router.get("/registry", async (_req, res) => {
    const tools = toolRegistry.listAll().map((t) => ({
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
    const allTools = toolRegistry.listAll().map((t) => ({
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

  return router;
}
