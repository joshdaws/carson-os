import { Router } from "express";
import type { Db } from "@carsonos/db";

export function createHealthRoutes(_db: Db): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({
      status: "ok",
      timestamp: Date.now(),
      version: "0.1.0",
    });
  });

  return router;
}
