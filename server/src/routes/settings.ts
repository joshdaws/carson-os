/**
 * Settings routes -- key-value store for instance configuration.
 *
 * Stores adapter config, telegram token, and other instance settings.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { instanceSettings } from "@carsonos/db";

export function createSettingsRoutes(db: Db): Router {
  const router = Router();

  // GET / -- return all settings as key-value pairs
  router.get("/", async (_req, res) => {
    const rows = await db.select().from(instanceSettings).all();

    const settings: Record<string, unknown> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }

    res.json({ settings });
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
