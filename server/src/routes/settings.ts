/**
 * Settings routes -- key-value store for instance configuration.
 *
 * Stores adapter config, telegram token, and other instance settings.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { instanceSettings, households } from "@carsonos/db";

export function createSettingsRoutes(db: Db): Router {
  const router = Router();

  // GET / -- return all settings as key-value pairs
  // Augments instance settings with household data as fallbacks
  router.get("/", async (_req, res) => {
    const rows = await db.select().from(instanceSettings).all();

    const settings: Record<string, unknown> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }

    // Include household name and timezone if not overridden in instance settings
    if (!settings["HOUSEHOLD_NAME"] || !settings["TIMEZONE"]) {
      const household = await db.select().from(households).get();
      if (household) {
        if (!settings["HOUSEHOLD_NAME"]) settings["HOUSEHOLD_NAME"] = household.name;
        if (!settings["TIMEZONE"]) settings["TIMEZONE"] = household.timezone;
      }
    }

    res.json({ settings });
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

    res.json({ settings: { [key]: value } });
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

    res.json({ settings: results });
  });

  return router;
}
