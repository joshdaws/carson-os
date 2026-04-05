import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { instanceSettings } from "@carsonos/db";

export function createSettingsRoutes(db: Db): Router {
  const router = Router();

  // GET / — return all settings as key-value pairs
  router.get("/", async (_req, res) => {
    const rows = await db.select().from(instanceSettings).all();

    const settings: Record<string, any> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }

    res.json({ settings });
  });

  // PUT /:key — upsert a setting
  router.put("/:key", async (req, res) => {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      res.status(400).json({ error: "value is required" });
      return;
    }

    // Check if setting exists
    const existing = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.key, key))
      .get();

    if (existing) {
      const [updated] = await db
        .update(instanceSettings)
        .set({ value })
        .where(eq(instanceSettings.key, key))
        .returning();

      res.json({ setting: updated });
    } else {
      const [created] = await db
        .insert(instanceSettings)
        .values({ id: key, key, value })
        .returning();

      res.status(201).json({ setting: created });
    }
  });

  return router;
}
