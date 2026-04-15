/**
 * Express application factory -- mounts all v3 routes with middleware.
 *
 * In development: Vite dev middleware is mounted on the same Express server.
 * One process, one port, no proxy. HMR still works.
 *
 * In production: serves the built UI from ../ui/dist as static files.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import type { Db } from "@carsonos/db";
import type { Adapter } from "./services/subprocess-adapter.js";
import type { ConstitutionEngine } from "./services/constitution-engine.js";
import type { TaskEngine } from "./services/task-engine.js";
import type { CarsonOversight } from "./services/carson-oversight.js";
import type { InterviewEngine } from "./services/interview.js";
import type { ProfileInterviewEngine } from "./services/profile-interview.js";
import type { PersonalityInterviewEngine } from "./services/personality-interview.js";
import type { ToolRegistry } from "./services/tool-registry.js";
import type { MultiRelayManager } from "./services/multi-relay-manager.js";
import type { SignalRelayManager } from "./services/signal-relay-manager.js";

import { createHealthRoutes } from "./routes/health.js";
import { createHouseholdRoutes } from "./routes/households.js";
import { createMemberRoutes } from "./routes/members.js";
import { createStaffRoutes } from "./routes/staff.js";
import { createToolRoutes } from "./routes/tools.js";
import { createTaskRoutes } from "./routes/tasks.js";
import { createConstitutionRoutes } from "./routes/constitution.js";
import { createConversationRoutes } from "./routes/conversations.js";
import { createOnboardingRoutes } from "./routes/onboarding.js";
import { createActivityRoutes } from "./routes/activity.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createProfileRoutes } from "./routes/profiles.js";
import { createScheduledTaskRoutes } from "./routes/scheduled-tasks.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

export interface AppDeps {
  db: Db;
  adapter: Adapter;
  constitutionEngine: ConstitutionEngine;
  taskEngine: TaskEngine;
  oversight: CarsonOversight;
  interviewEngine: InterviewEngine;
  profileInterviewEngine: ProfileInterviewEngine;
  personalityInterviewEngine: PersonalityInterviewEngine;
  toolRegistry: ToolRegistry;
  multiRelay?: MultiRelayManager;
  signalRelay?: SignalRelayManager;
}

export async function createApp(deps: AppDeps): Promise<express.Express> {
  const {
    db,
    adapter,
    constitutionEngine,
    taskEngine,
    oversight,
    interviewEngine,
    profileInterviewEngine,
    personalityInterviewEngine,
    toolRegistry,
  } = deps;
  const app = express();

  // --------------- middleware ---------------

  // CORS -- only allow requests from the dashboard UI origin
  const port = process.env.PORT || "3300";
  app.use("/api", cors({
    origin: [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
  }));

  // JSON body parsing (Express 5 built-in, 1 MB limit)
  // Must come before Vite middleware so API routes parse JSON bodies
  app.use("/api", express.json({ limit: "1mb" }));

  // Request logging (API only)
  app.use("/api", (req: Request, _res: Response, next: NextFunction) => {
    console.log(`[http] ${req.method} ${req.url}`);
    next();
  });

  // --------------- routes ---------------

  app.use("/api/health", createHealthRoutes({ adapter }));
  app.use("/api/households", createHouseholdRoutes(db));
  app.use("/api/households", createMemberRoutes(db));
  app.use("/api/staff", createStaffRoutes({ db, personalityInterviewEngine, multiRelay: deps.multiRelay, signalRelay: deps.signalRelay }));
  app.use("/api/tasks", createTaskRoutes({ db, taskEngine, oversight }));
  app.use(
    "/api/constitution",
    createConstitutionRoutes({ db, constitutionEngine, interviewEngine }),
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
  app.use("/api/scheduled-tasks", createScheduledTaskRoutes(db));
  app.use("/api/tools", createToolRoutes({ db, toolRegistry }));
  app.use(
    "/api/members",
    createProfileRoutes({ db, profileInterviewEngine }),
  );

  // --------------- UI serving ---------------

  const isProd = process.env.NODE_ENV === "production";
  const uiRoot = resolve(__dirname, "../../ui");

  if (isProd) {
    // Production: serve pre-built static files
    app.use(express.static(resolve(uiRoot, "dist")));
    // SPA fallback: serve index.html for any non-API route
    // Express 5 requires named wildcard params (not bare *)
    app.get("/{*path}", (_req: Request, res: Response) => {
      res.sendFile(resolve(uiRoot, "dist/index.html"));
    });
  } else {
    // Development: mount Vite dev server as middleware (HMR, no proxy needed)
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: uiRoot,
      configFile: resolve(uiRoot, "vite.config.ts"),
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("[vite] Dev middleware mounted");
  }

  // --------------- error handler ---------------

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[error]", err.message);
    const status = (err as any).statusCode ?? (err as any).status ?? 500;
    res.status(status).json({ error: err.message });
  });

  return app;
}
