import express, { type Request, type Response, type NextFunction } from "express";
import type { Db } from "@carsonos/db";
import { createHealthRoutes } from "./routes/health.js";
import { createFamilyRoutes } from "./routes/families.js";
import { createMemberRoutes } from "./routes/members.js";
import { createAgentRoutes } from "./routes/agents.js";
import { createConversationRoutes } from "./routes/conversations.js";
import { createConstitutionRoutes } from "./routes/constitution.js";
import { createBudgetRoutes } from "./routes/budget.js";
import { createActivityRoutes } from "./routes/activity.js";
import { createOnboardingRoutes } from "./routes/onboarding.js";
import { createSettingsRoutes } from "./routes/settings.js";

export async function createApp(db: Db): Promise<express.Express> {
  const app = express();

  // --------------- middleware ---------------

  // JSON body parsing (Express 5 built-in, 1 MB limit)
  app.use(express.json({ limit: "1mb" }));

  // CORS for localhost dev
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "http://localhost:5173");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (_req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Request logging
  app.use((req: Request, _res: Response, next: NextFunction) => {
    console.log(`[http] ${req.method} ${req.url}`);
    next();
  });

  // --------------- routes ---------------

  app.use("/api/health", createHealthRoutes(db));
  app.use("/api/families", createFamilyRoutes(db));
  app.use("/api/families", createMemberRoutes(db));
  app.use("/api/agents", createAgentRoutes(db));
  app.use("/api/families", createConversationRoutes(db));
  app.use("/api/families", createConstitutionRoutes(db));
  app.use("/api/families", createBudgetRoutes(db));
  app.use("/api/families", createActivityRoutes(db));
  app.use("/api/onboarding", createOnboardingRoutes(db));
  app.use("/api/settings", createSettingsRoutes(db));

  // --------------- Vite dev middleware / static serving ---------------
  // In dev: proxy to Vite dev server (run `pnpm --filter @carsonos/ui dev` separately)
  // In prod: serve static files from ui/dist
  if (process.env.NODE_ENV === "production") {
    app.use(express.static("../ui/dist"));
  }

  // --------------- error handler ---------------

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[error]", err.message);
    const status = (err as any).statusCode ?? (err as any).status ?? 500;
    res.status(status).json({ error: err.message });
  });

  return app;
}
