/**
 * Boot-time loader and reconciliation for custom tools.
 *
 * Reads the custom_tools DB rows, matches them with SKILL.md files on disk,
 * detects tampering via content-hash mismatches, and registers each valid
 * tool in the in-memory ToolRegistry with a namespaced key.
 */

import { eq } from "drizzle-orm";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@carsonos/db";
import { customTools } from "@carsonos/db";

import type { ToolRegistry } from "../tool-registry.js";
import { parseSkillMd } from "./skill-md.js";
import { cleanupTmpFiles, ensureToolsDir, hashToolDir, TOOLS_ROOT, walkForSkills } from "./fs-helpers.js";
import { buildRegistrationFromRow, type CustomRegistration } from "./registration.js";

export interface LoadStats {
  loaded: number;
  broken: number;
  pending: number;
  orphanFiles: number;
}

/**
 * Run boot reconciliation for all households. Must be called once at server
 * startup BEFORE the registry serves buildExecutor() requests.
 */
export async function loadCustomTools(db: Db, registry: ToolRegistry): Promise<LoadStats> {
  const stats: LoadStats = { loaded: 0, broken: 0, pending: 0, orphanFiles: 0 };

  // 1. Get distinct household IDs from custom_tools AND from the tools directory
  const dbHouseholdsRows = db
    .select({ householdId: customTools.householdId })
    .from(customTools)
    .all();
  const householdIds = Array.from(new Set(dbHouseholdsRows.map((r) => r.householdId)));

  for (const householdId of householdIds) {
    const hhDir = ensureToolsDir(householdId);
    // Clean up any leftover .tmp files from crashed writes
    cleanupTmpFiles(hhDir);

    const rows = db
      .select()
      .from(customTools)
      .where(eq(customTools.householdId, householdId))
      .all();

    const knownPaths = new Set(rows.map((r) => r.path));

    // 2. Reconcile each row with disk
    for (const row of rows) {
      if (!["active", "broken", "pending_approval"].includes(row.status)) continue;

      const dir = join(TOOLS_ROOT, householdId, row.path);
      const skillPath = join(dir, "SKILL.md");

      if (!existsSync(skillPath)) {
        if (row.status !== "broken") {
          db.update(customTools)
            .set({ status: "broken", lastError: "SKILL.md missing on disk" })
            .where(eq(customTools.id, row.id))
            .run();
        }
        stats.broken++;
        continue;
      }

      let doc;
      try {
        doc = parseSkillMd(readFileSync(skillPath, "utf8"));
      } catch (err) {
        db.update(customTools)
          .set({ status: "broken", lastError: `SKILL.md parse failed: ${(err as Error).message}` })
          .where(eq(customTools.id, row.id))
          .run();
        stats.broken++;
        continue;
      }

      // For script tools, verify handler.ts exists
      if (row.kind === "script") {
        const handlerPath = join(dir, "handler.ts");
        if (!existsSync(handlerPath)) {
          db.update(customTools)
            .set({ status: "broken", lastError: "handler.ts missing for script tool" })
            .where(eq(customTools.id, row.id))
            .run();
          stats.broken++;
          continue;
        }
      }

      // Tamper detection for script tools
      if (row.kind === "script" && row.approvedContentHash) {
        try {
          const currentHash = hashToolDir(dir);
          if (currentHash !== row.approvedContentHash) {
            db.update(customTools)
              .set({
                status: "pending_approval",
                lastError: "Content changed outside system tools; awaiting CoS approval",
              })
              .where(eq(customTools.id, row.id))
              .run();
            stats.pending++;
            continue;
          }
        } catch (err) {
          db.update(customTools)
            .set({ status: "broken", lastError: `Hash check failed: ${(err as Error).message}` })
            .where(eq(customTools.id, row.id))
            .run();
          stats.broken++;
          continue;
        }
      }

      if (row.status !== "active") {
        // pending_approval or previously broken — skip registry registration
        if (row.status === "pending_approval") stats.pending++;
        continue;
      }

      // 3. Register in in-memory registry
      const registered = buildRegistrationFromRow(row, doc.frontmatter, doc.body, dir);
      registry.registerCustom(householdId, registered);
      stats.loaded++;
    }

    // 4. Detect orphan SKILL.md files on disk
    const found = walkForSkills(hhDir);
    for (const orphan of found) {
      const relPath = orphan.bundle ? `${orphan.bundle}/${orphan.toolName}` : orphan.toolName;
      if (!knownPaths.has(relPath)) {
        console.log(`[custom-tools] Orphan SKILL.md at ${relPath} (no DB row). Use admin UI to import.`);
        stats.orphanFiles++;
      }
    }
  }

  console.log(
    `[custom-tools] Loaded ${stats.loaded} tools (${stats.broken} broken, ${stats.pending} pending, ${stats.orphanFiles} orphans)`,
  );
  return stats;
}
