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

/**
 * Optional source of QMD reindex health. Implemented by QmdMemoryProvider
 * (see qmd-provider.ts:getReindexHealth) so the health endpoint can surface
 * "qmd update has failed N times" without consumers needing to grep
 * stderr.log. Kept as a structural type so non-QMD providers don't have to
 * implement it.
 */
export interface ReindexHealthSource {
  getReindexHealth(): {
    errorCount: number;
    lastError: { at: string; message: string } | null;
  };
}

export interface HealthRouteDeps {
  adapter: Adapter;
  /** Optional. When provided, /api/health includes a `memory.reindex` block. */
  memoryProvider?: ReindexHealthSource | null;
}

export function createHealthRoutes(deps: HealthRouteDeps): Router {
  const { adapter, memoryProvider } = deps;
  const router = Router();

  // GET / -- server health + adapter status + (optional) memory reindex health
  router.get("/", async (_req, res) => {
    let adapterHealthy = false;
    try {
      adapterHealthy = await adapter.healthCheck();
    } catch {
      adapterHealthy = false;
    }

    const memorySection =
      memoryProvider && typeof memoryProvider.getReindexHealth === "function"
        ? { reindex: memoryProvider.getReindexHealth() }
        : null;

    res.json({
      status: "ok",
      timestamp: Date.now(),
      version: VERSION,
      adapter: {
        name: adapter.name,
        healthy: adapterHealthy,
      },
      ...(memorySection ? { memory: memorySection } : {}),
    });
  });

  return router;
}
