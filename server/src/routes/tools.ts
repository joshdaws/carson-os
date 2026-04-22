/**
 * Tool routes -- per-agent tool grant management, registry listing, and
 * custom tool administration (list / approve-pending / disable / delete).
 */

import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@carsonos/db";
import { customTools, staffAgents, toolSecrets } from "@carsonos/db";
import type { ToolRegistry } from "../services/tool-registry.js";
import {
  TOOLS_ROOT,
  hashToolDir,
  loadCustomTools,
  parseSkillMd,
  walkForSkills,
  prepareInstall,
  promoteTool,
  cleanupStaging,
  InstallError,
} from "../services/custom-tools/index.js";
import { encryptSecret } from "../services/custom-tools/secrets.js";

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

  // ── Orphan SKILL.md detection + import ──────────────────────────────
  //
  // The loader counts orphans at boot but only logs them. These routes
  // expose them to the admin UI so the operator can review and import
  // (insert custom_tools rows + register in the live registry).
  //
  // Sources of orphans: hand-authored SKILL.md files, files synced from
  // another machine without the DB, recovered files from a backup.
  //
  // IMPORTANT: declared BEFORE /custom/:id so Express doesn't match
  // "orphans" as the :id param.

  // GET /custom/orphans — list SKILL.md files on disk that have no DB row
  router.get("/custom/orphans", async (req, res) => {
    const householdId = typeof req.query.household_id === "string" ? req.query.household_id : null;
    if (!householdId) { res.status(400).json({ error: "household_id required" }); return; }

    const householdDir = join(TOOLS_ROOT, householdId);
    if (!existsSync(householdDir)) { res.json({ orphans: [] }); return; }

    const knownPaths = new Set(
      db
        .select({ path: customTools.path })
        .from(customTools)
        .where(eq(customTools.householdId, householdId))
        .all()
        .map((r) => r.path),
    );
    const knownNames = new Set(
      db
        .select({ name: customTools.name })
        .from(customTools)
        .where(eq(customTools.householdId, householdId))
        .all()
        .map((r) => r.name),
    );

    const found = walkForSkills(householdDir);
    const orphans: Array<{
      bundle: string | null;
      toolName: string;
      relPath: string;
      parsed: { name: string; description: string; kind: string; hasHandler: boolean } | null;
      parseError: string | null;
      nameConflict: boolean;
    }> = [];

    for (const f of found) {
      const relPath = f.bundle ? `${f.bundle}/${f.toolName}` : f.toolName;
      if (knownPaths.has(relPath)) continue;

      let parsed: { name: string; description: string; kind: string; hasHandler: boolean } | null = null;
      let parseError: string | null = null;
      let conflictName: string | null = null;
      try {
        const doc = parseSkillMd(readFileSync(f.absPath, "utf8"));
        const kind = doc.frontmatter.kind ?? "prompt";
        const handlerPath = join(f.absPath, "..", "handler.ts");
        const hasHandler = existsSync(handlerPath);
        if (kind === "script" && !hasHandler) {
          parseError = "Script tool missing handler.ts next to SKILL.md";
        } else {
          parsed = { name: doc.frontmatter.name, description: doc.frontmatter.description, kind, hasHandler };
          conflictName = doc.frontmatter.name;
        }
      } catch (err) {
        parseError = (err as Error).message;
      }

      orphans.push({
        bundle: f.bundle ?? null,
        toolName: f.toolName,
        relPath,
        parsed,
        parseError,
        nameConflict: conflictName ? knownNames.has(conflictName) : false,
      });
    }

    res.json({ orphans });
  });

  // POST /custom/import-orphans — body: { household_id, paths: string[] }
  router.post("/custom/import-orphans", async (req, res) => {
    const { household_id: householdId, paths } = req.body as {
      household_id?: string;
      paths?: string[];
    };
    if (!householdId) { res.status(400).json({ error: "household_id required" }); return; }
    if (!Array.isArray(paths) || paths.length === 0) {
      res.status(400).json({ error: "paths must be a non-empty array" });
      return;
    }

    const agents = db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.householdId, householdId))
      .all();
    const defaultAgent =
      agents.find((a) => a.staffRole === "chief_of_staff") ??
      agents.find((a) => a.status === "active") ??
      agents[0];
    if (!defaultAgent) {
      res.status(400).json({ error: "No staff agents in this household to attribute imports to" });
      return;
    }

    const householdDir = join(TOOLS_ROOT, householdId);
    const found = walkForSkills(householdDir);
    const byRelPath = new Map<string, typeof found[0]>();
    for (const f of found) {
      const relPath = f.bundle ? `${f.bundle}/${f.toolName}` : f.toolName;
      byRelPath.set(relPath, f);
    }

    const knownNames = new Set(
      db
        .select({ name: customTools.name })
        .from(customTools)
        .where(eq(customTools.householdId, householdId))
        .all()
        .map((r) => r.name),
    );

    const imported: string[] = [];
    const failed: Array<{ relPath: string; error: string }> = [];

    for (const relPath of paths) {
      const f = byRelPath.get(relPath);
      if (!f) { failed.push({ relPath, error: "No SKILL.md found at that path on disk" }); continue; }

      let doc;
      try {
        doc = parseSkillMd(readFileSync(f.absPath, "utf8"));
      } catch (err) {
        failed.push({ relPath, error: `SKILL.md parse failed: ${(err as Error).message}` });
        continue;
      }

      const kind = doc.frontmatter.kind ?? "prompt";
      const dir = join(f.absPath, "..");
      if (kind === "script" && !existsSync(join(dir, "handler.ts"))) {
        failed.push({ relPath, error: "Script tool missing handler.ts" });
        continue;
      }

      if (knownNames.has(doc.frontmatter.name)) {
        failed.push({
          relPath,
          error: `Tool name '${doc.frontmatter.name}' already exists in this household`,
        });
        continue;
      }

      let approvedContentHash: string | null = null;
      if (kind === "script") {
        try { approvedContentHash = hashToolDir(dir); } catch { /* leave null */ }
      }

      try {
        db.insert(customTools).values({
          householdId,
          name: doc.frontmatter.name,
          kind,
          path: relPath,
          createdByAgentId: defaultAgent.id,
          source: "imported",
          status: "active",
          approvedContentHash,
        }).run();
        knownNames.add(doc.frontmatter.name);
        imported.push(relPath);
      } catch (err) {
        failed.push({ relPath, error: `DB insert failed: ${(err as Error).message}` });
      }
    }

    if (imported.length > 0) {
      try { await loadCustomTools(db, toolRegistry); }
      catch (err) { console.error("[tools] Registry reload after import failed:", err); }
    }

    res.json({ imported: imported.length, importedPaths: imported, failed });
  });

  // ── Upstream update check + apply (installed skills only) ──────────
  //
  // The detail panel shows a "Check for updates" button on tools where
  // source === "installed-skill" and sourceUrl is set. These routes power it.
  //
  // The check re-runs prepareInstall (same fetch+validate+hash pipeline as
  // install_skill) against the saved sourceUrl, finds the matching tool by
  // name, and compares the upstream contentHash to the locally stored
  // approvedContentHash. The apply route does the same fetch then promotes
  // the new files in place, bumps generation, refreshes content hash, and
  // reloads the registry so the new version is callable immediately.
  //
  // IMPORTANT: declared BEFORE /custom/:id so Express doesn't match
  // "check-update" or "apply-update" as the :id param.

  // GET /custom/:id/check-update — fetch upstream and compare hashes
  router.get("/custom/:id/check-update", async (req, res) => {
    const row = db.select().from(customTools).where(eq(customTools.id, req.params.id)).get();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    if (row.source !== "installed-skill" || !row.sourceUrl) {
      res.status(400).json({ error: "Tool was not installed from a source URL" });
      return;
    }

    let result;
    try {
      result = await prepareInstall(row.sourceUrl);
    } catch (err) {
      const msg = err instanceof InstallError ? err.message : (err as Error).message;
      res.status(502).json({ error: `Upstream fetch failed: ${msg}` });
      return;
    }

    try {
      const entry = result.entries.find((e) => e.toolName === row.name);
      if (!entry) {
        res.json({
          hasUpdate: false,
          upstreamMissing: true,
          currentHash: row.approvedContentHash,
          upstreamHash: null,
          message: `The upstream source no longer contains a tool named "${row.name}". It may have been renamed or removed.`,
        });
        return;
      }

      res.json({
        hasUpdate: entry.contentHash !== row.approvedContentHash,
        upstreamMissing: false,
        currentHash: row.approvedContentHash,
        upstreamHash: entry.contentHash,
        message: entry.contentHash === row.approvedContentHash ? "Up to date." : "Update available.",
      });
    } finally {
      cleanupStaging(result.stagingRoot);
    }
  });

  // POST /custom/:id/apply-update — re-fetch and overwrite the local copy
  router.post("/custom/:id/apply-update", async (req, res) => {
    const row = db.select().from(customTools).where(eq(customTools.id, req.params.id)).get();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    if (row.source !== "installed-skill" || !row.sourceUrl) {
      res.status(400).json({ error: "Tool was not installed from a source URL" });
      return;
    }

    let result;
    try {
      result = await prepareInstall(row.sourceUrl);
    } catch (err) {
      const msg = err instanceof InstallError ? err.message : (err as Error).message;
      res.status(502).json({ error: `Upstream fetch failed: ${msg}` });
      return;
    }

    try {
      const entry = result.entries.find((e) => e.toolName === row.name);
      if (!entry) {
        res.status(404).json({
          error: `The upstream source no longer contains a tool named "${row.name}". It may have been renamed or removed. To switch to the new name, run install_skill again.`,
        });
        return;
      }

      if (entry.contentHash === row.approvedContentHash) {
        res.json({ ok: true, applied: false, message: "Already up to date." });
        return;
      }

      const destDir = join(TOOLS_ROOT, row.householdId, row.path);
      // Atomic swap: move the existing dir aside, promote the upstream into
      // its place, then remove the backup. If the promote fails, restore the
      // backup so we never leave the user with a half-installed tool.
      const backupDir = `${destDir}.bak.${Date.now()}`;
      let backupCreated = false;
      try {
        if (existsSync(destDir)) {
          renameSync(destDir, backupDir);
          backupCreated = true;
        }
        promoteTool(entry, destDir);
        if (backupCreated) {
          rmSync(backupDir, { recursive: true, force: true });
        }
      } catch (err) {
        if (backupCreated && !existsSync(destDir)) {
          // Restore the backup since the new files never landed
          try { renameSync(backupDir, destDir); } catch { /* swallow restore error; original is more relevant */ }
        }
        res.status(500).json({
          error: `Failed to promote upstream files: ${(err as Error).message}`,
        });
        return;
      }

      db.update(customTools)
        .set({
          approvedContentHash: entry.contentHash,
          generation: row.generation + 1,
          schemaVersion: row.schemaVersion + 1,
          status: "active",
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(customTools.id, row.id))
        .run();

      try { await loadCustomTools(db, toolRegistry); }
      catch (err) { console.error("[tools] Registry reload after update failed:", err); }

      res.json({ ok: true, applied: true, newHash: entry.contentHash });
    } finally {
      cleanupStaging(result.stagingRoot);
    }
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

  // POST /secrets — create or replace a secret by key_name.
  // Body: { household_id, key_name, value }. Value is encrypted at rest with
  // AES-256-GCM via encryptSecret. The plaintext value is never logged and
  // never returned. Safe to call from the admin UI (password-masked form)
  // so users don't have to paste credentials into agent chat.
  router.post("/secrets", async (req, res) => {
    const { household_id: householdId, key_name: rawKeyName, value } = (req.body ?? {}) as {
      household_id?: string;
      key_name?: string;
      value?: string;
    };
    if (!householdId || !rawKeyName || typeof value !== "string" || value.length === 0) {
      res.status(400).json({ error: "household_id, key_name, and non-empty value are required" });
      return;
    }
    // Match the validation rules used by the store_secret MCP tool: snake_case,
    // no spaces, reasonable length. Makes programmatic lookups predictable.
    const keyName = rawKeyName.trim();
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(keyName)) {
      res.status(400).json({
        error: "key_name must be lowercase snake_case, start with a letter, ≤64 chars (e.g. 'hooktheory_password')",
      });
      return;
    }

    let encryptedValue: string;
    try {
      encryptedValue = encryptSecret(value, toolRegistry.getDataDir());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `encryption failed: ${msg}` });
      return;
    }

    // Upsert by (household_id, key_name) unique index.
    const now = new Date();
    const existing = db
      .select()
      .from(toolSecrets)
      .where(and(eq(toolSecrets.householdId, householdId), eq(toolSecrets.keyName, keyName)))
      .get();
    if (existing) {
      db.update(toolSecrets)
        .set({ encryptedValue, updatedAt: now })
        .where(eq(toolSecrets.id, existing.id))
        .run();
      res.json({ ok: true, replaced: true, id: existing.id, key_name: keyName });
      return;
    }
    const inserted = db
      .insert(toolSecrets)
      .values({ householdId, keyName, encryptedValue })
      .returning({ id: toolSecrets.id })
      .get();
    res.json({ ok: true, replaced: false, id: inserted?.id, key_name: keyName });
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
