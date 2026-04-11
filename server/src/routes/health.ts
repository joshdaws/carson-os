/**
 * Health routes -- server health + adapter health check.
 */

import { Router } from "express";
import type { Adapter } from "../services/subprocess-adapter.js";

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
      version: "0.1.0",
      adapter: {
        name: adapter.name,
        healthy: adapterHealthy,
      },
    });
  });

  return router;
}
