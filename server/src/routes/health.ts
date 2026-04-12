/**
 * Health routes -- server health + adapter health check.
 */

import { Router } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter } from "../services/subprocess-adapter.js";

// Read version once at module load
const VERSION = (() => {
  try {
    return readFileSync(join(import.meta.dirname, "../../../VERSION"), "utf-8").trim();
  } catch {
    return "unknown";
  }
})();

export interface HealthRouteDeps {
  adapter: Adapter;
}

export function createHealthRoutes(deps: HealthRouteDeps): Router {
  const { adapter } = deps;
  const router = Router();

  // GET / -- server health + adapter status
  router.get("/", async (_req, res) => {
    let adapterHealthy = false;
    try {
      adapterHealthy = await adapter.healthCheck();
    } catch {
      adapterHealthy = false;
    }

    res.json({
      status: "ok",
      timestamp: Date.now(),
      version: VERSION,
      adapter: {
        name: adapter.name,
        healthy: adapterHealthy,
      },
    });
  });

  return router;
}
