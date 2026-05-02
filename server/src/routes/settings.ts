/**
 * Settings routes -- key-value store for instance configuration.
 *
 * Stores adapter config, telegram token, and other instance settings.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { Db } from "@carsonos/db";
import { instanceSettings, households } from "@carsonos/db";
import { isHydratableEnvKey } from "../services/env-hydration.js";

export const SECRET_SETTING_KEYS = ["ANTHROPIC_API_KEY", "GROQ_API_KEY"] as const;

export function isSecretSettingKey(key: string): boolean {
  return (SECRET_SETTING_KEYS as readonly string[]).includes(key);
}

export function publicSettingsFromRows(
  rows: Array<{ key: string; value: unknown }>,
): { settings: Record<string, unknown>; savedSecretKeys: string[] } {
  const settings: Record<string, unknown> = {};
  const savedSecretKeys: string[] = [];

  for (const row of rows) {
    if (isSecretSettingKey(row.key) && typeof row.value === "string" && row.value.length > 0) {
      settings[row.key] = "";
      savedSecretKeys.push(row.key);
      continue;
    }

    settings[row.key] = row.value;
  }

  return { settings, savedSecretKeys };
}

function publicSettingsFromEntries(entries: Array<[string, unknown]>) {
  return publicSettingsFromRows(entries.map(([key, value]) => ({ key, value })));
}

export function createSettingsRoutes(db: Db): Router {
  const router = Router();

  // GET / -- return all settings as key-value pairs
  // Augments instance settings with household data as fallbacks
  router.get("/", async (_req, res) => {
    const rows = await db.select().from(instanceSettings).all();
    const { settings, savedSecretKeys } = publicSettingsFromRows(rows);

    // Include household name and timezone if not overridden in instance settings
    if (!settings["HOUSEHOLD_NAME"] || !settings["TIMEZONE"]) {
      const household = await db.select().from(households).get();
      if (household) {
        if (!settings["HOUSEHOLD_NAME"]) settings["HOUSEHOLD_NAME"] = household.name;
        if (!settings["TIMEZONE"]) settings["TIMEZONE"] = household.timezone;
      }
    }

    res.json({ settings, savedSecretKeys });
  });

  // PUT /:key -- update a single setting
  router.put("/:key", async (req, res) => {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      res.status(400).json({ error: "value is required" });
      return;
    }

    // Sync household-specific keys to the households table
    if (key === "HOUSEHOLD_NAME" || key === "TIMEZONE") {
      const household = await db.select().from(households).get();
      if (household) {
        const col = key === "HOUSEHOLD_NAME" ? "name" : "timezone";
        await db
          .update(households)
          .set({ [col]: value })
          .where(eq(households.id, household.id));
      }
    }

    // Also persist to instance settings
    const existing = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.key, key))
      .get();

    if (existing) {
      await db
        .update(instanceSettings)
        .set({ value: value as any })
        .where(eq(instanceSettings.key, key));
    } else {
      await db.insert(instanceSettings).values({
        id: key,
        key,
        value: value as any,
      });
    }

    // For allow-listed platform secrets (GROQ_API_KEY), patch process.env so
    // services pick up the new value without requiring a server restart.
    // Operator env override is preserved by applyHydratableSetting.
    if (isHydratableEnvKey(key)) {
      // On UI save, the user is explicitly setting a new value — overwrite
      // the in-process env (the boot-time precedence is operator-env-wins,
      // but a deliberate UI save should take effect immediately).
      if (typeof value === "string" && value.length > 0) {
        process.env[key] = value;
        console.log(`[settings] ${key} updated and applied to process.env`);
      } else {
        // Empty value clears the secret
        delete process.env[key];
        console.log(`[settings] ${key} cleared from process.env`);
      }
    }
    res.json(publicSettingsFromEntries([[key, value]]));
  });

  // PUT / -- bulk update settings
  router.put("/", async (req, res) => {
    const { settings } = req.body;

    if (!settings || typeof settings !== "object") {
      res.status(400).json({ error: "settings object is required" });
      return;
    }

    const results: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(settings)) {
      const existing = await db
        .select()
        .from(instanceSettings)
        .where(eq(instanceSettings.key, key))
        .get();

      if (existing) {
        await db
          .update(instanceSettings)
          .set({ value: value as any })
          .where(eq(instanceSettings.key, key));
      } else {
        await db.insert(instanceSettings).values({
          id: key,
          key,
          value: value as any,
        });
      }

      results[key] = value;
    }

    res.json(publicSettingsFromEntries(Object.entries(results)));
  });

  // GET /validate-path?path=... -- check if a directory exists on disk
  router.get("/validate-path", (req, res) => {
    const rawPath = req.query.path as string;
    if (!rawPath) {
      res.json({ valid: false, error: "No path provided" });
      return;
    }

    // Expand ~ to home directory
    const expanded = rawPath.startsWith("~")
      ? resolve(homedir(), rawPath.slice(2))
      : resolve(rawPath);

    try {
      const exists = existsSync(expanded);
      const isDir = exists && statSync(expanded).isDirectory();
      res.json({ valid: isDir, resolved: expanded, exists, isDir });
    } catch {
      res.json({ valid: false, resolved: expanded, exists: false, isDir: false });
    }
  });

  return router;
}
