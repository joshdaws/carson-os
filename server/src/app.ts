/**
 * Express application factory -- mounts all v3 routes with middleware.
 */

import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { Db } from "@carsonos/db";
import type { Adapter } from "./services/subprocess-adapter.js";
import type { ConstitutionEngine } from "./services/constitution-engine.js";
import type { TaskEngine } from "./services/task-engine.js";
import type { CarsonOversight } from "./services/carson-oversight.js";
import type { InterviewEngine } from "./services/interview.js";

import { createHealthRoutes } from "./routes/health.js";
import { createHouseholdRoutes } from "./routes/households.js";
import { createMemberRoutes } from "./routes/members.js";
import { createStaffRoutes } from "./routes/staff.js";
import { createTaskRoutes } from "./routes/tasks.js";
import { createConstitutionRoutes } from "./routes/constitution.js";
import { createConversationRoutes } from "./routes/conversations.js";
import { createOnboardingRoutes } from "./routes/onboarding.js";
import { createActivityRoutes } from "./routes/activity.js";
import { createSettingsRoutes } from "./routes/settings.js";

export interface AppDeps {
  db: Db;
  adapter: Adapter;
  constitutionEngine: ConstitutionEngine;
  taskEngine: TaskEngine;
  oversight: CarsonOversight;
  interviewEngine: InterviewEngine;
}

export async function createApp(deps: AppDeps): Promise<express.Express> {
  const {
    db,
    adapter,
    constitutionEngine,
    taskEngine,
    oversight,
    interviewEngine,
  } = deps;
  const app = express();

  // --------------- middleware ---------------

  // JSON body parsing (Express 5 built-in, 1 MB limit)
  app.use(express.json({ limit: "1mb" }));

  // CORS for localhost dev
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "http://localhost:5173");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
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

  app.use("/api/health", createHealthRoutes({ adapter }));
  app.use("/api/households", createHouseholdRoutes(db));
  app.use("/api/households", createMemberRoutes(db));
  app.use("/api/staff", createStaffRoutes(db));
  app.use("/api/tasks", createTaskRoutes({ db, taskEngine, oversight }));
  app.use(
    "/api/constitution",
    createConstitutionRoutes({ db, constitutionEngine }),
  );
  app.use(
    "/api/conversations",
    createConversationRoutes({ db, constitutionEngine }),
  );
  app.use(
    "/api/onboarding",
    createOnboardingRoutes({ db, interviewEngine }),
  );
  app.use("/api/activity", createActivityRoutes(db));
  app.use("/api/settings", createSettingsRoutes(db));

  // --------------- Vite dev middleware / static serving ---------------
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
