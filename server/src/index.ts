/**
 * CarsonOS v3 -- server entry point.
 *
 * Boot sequence:
 *   1. Database
 *   2. Adapter (claude-code | codex | anthropic-sdk)
 *   3. ConstitutionEngine
 *   4. TaskEngine
 *   5. CarsonOversight
 *   6. InterviewEngine
 *   7. Express app with all routes
 *   8. HTTP server + WebSocket
 *   9. Telegram relay (if configured)
 */

import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createDb } from "@carsonos/db";
import { getConfig } from "./config.js";
import { backupDatabase } from "./services/backup.js";
import { checkForUpdates } from "./services/update-check.js";
import { Scheduler } from "./services/scheduler.js";
import { createApp } from "./app.js";
import { setupWebSocket, broadcast } from "./ws/live-events.js";
import { AppEventBus } from "./services/event-bus.js";
import { createAdapter } from "./services/subprocess-adapter.js";
import { ConstitutionEngine } from "./services/constitution-engine.js";
import { TaskEngine } from "./services/task-engine.js";
import { CarsonOversight } from "./services/carson-oversight.js";
import { InterviewEngine } from "./services/interview.js";
import { ProfileInterviewEngine } from "./services/profile-interview.js";
import { PersonalityInterviewEngine } from "./services/personality-interview.js";
import { Dispatcher } from "./services/dispatcher.js";
import { DelegationOrchestrator } from "./services/delegation-orchestrator.js";
import { MultiRelayManager } from "./services/multi-relay-manager.js";
import { bootMemory } from "./services/memory/index.js";
import { hydrateEnvFromSettings } from "./services/env-hydration.js";
import { ToolRegistry } from "./services/tool-registry.js";
import { GoogleCalendarProvider, CALENDAR_TOOLS, GMAIL_TOOLS, DRIVE_TOOLS } from "./services/google/index.js";
import { CalDavProvider, CALDAV_CALENDAR_TOOLS } from "./services/caldav/index.js";
import { ImapProvider, IMAP_EMAIL_TOOLS } from "./services/imap/index.js";

// Read VERSION from the repo root (two levels up from server/src/). Single
// source of truth — bumping VERSION at ship time updates the boot banner
// without a separate code change.
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const versionPath = join(here, "..", "..", "VERSION");
    return readFileSync(versionPath, "utf8").trim();
  } catch {
    return "unknown";
  }
}

const BANNER = [
  "",
  ` CarsonOS v${readVersion()}`,
  " Your family's values, your family's AI.",
  "",
].join("\n");

async function main() {
  const config = getConfig();
  const dbPath = join(config.dataDir, "carsonos.db");
  const eventBus = new AppEventBus();

  // Ensure data directory exists
  mkdirSync(config.dataDir, { recursive: true });

  // Check if our port is in use and warn (don't kill — could be unrelated).
  // If it's a stale CarsonOS, launchd/systemd already stopped the old one.
  try {
    const pids = execFileSync("lsof", ["-ti", `:${config.port}`], { encoding: "utf-8" }).trim();
    if (pids) {
      console.warn(`[boot] Port ${config.port} in use by PID(s): ${pids.replace(/\n/g, ", ")}. Will retry...`);
      // Wait briefly for the old process to finish shutting down
      const start = Date.now();
      while (Date.now() - start < 3000) {
        try {
          execFileSync("lsof", ["-ti", `:${config.port}`], { encoding: "utf-8" });
        } catch { break; } // port free
      }
    }
  } catch { /* port free, or lsof not available */ }

  // 0. Backup database before anything touches it
  backupDatabase(dbPath, config.dataDir, "boot");

  // 1. Boot database (pre-migration hook creates another backup if schema changes)
  const db = createDb(dbPath, (reason) => {
    backupDatabase(dbPath, config.dataDir, reason);
  });
  console.log(`[db] SQLite open at ${dbPath}`);

  // 1b. Hydrate allow-listed platform secrets (currently GROQ_API_KEY) from
  // instance_settings into process.env so services that read process.env can
  // pick up keys saved via the Settings UI without the operator editing files.
  await hydrateEnvFromSettings(db);

  // 2. Create adapter
  const adapter = createAdapter(config.adapterType);
  const adapterHealthy = await adapter.healthCheck();
  console.log(
    `[adapter] ${adapter.name} — ${adapterHealthy ? "healthy" : "unavailable"}`,
  );

  // 2b. Boot memory system
  let memoryProvider = undefined;
  try {
    memoryProvider = await bootMemory(db, config.memory);
    console.log(`[memory] Provider ready (${config.memory.kind}) at ${config.memory.rootDir}`);
  } catch (err) {
    console.warn("[memory] Boot failed, running without memory:", err);
  }

  // 2c. External providers
  const googleDir = join(config.dataDir, "google");
  const calendarProvider = new GoogleCalendarProvider(googleDir);
  const gwsHealthy = await calendarProvider.healthCheck();
  console.log(`[google] Calendar provider ${gwsHealthy ? "ready" : "unavailable (gws not installed)"}`);

  // CalDAV — always available, no external CLI dependency. Used for members
  // with iCloud/CalDAV credentials. Wins over Google at dispatch time for
  // members who have creds saved.
  const caldavDir = join(config.dataDir, "caldav");
  const caldavProvider = new CalDavProvider(caldavDir);
  console.log("[caldav] Calendar provider ready");

  // IMAP — always available, no external CLI dependency.
  // Per-member credentials resolved at dispatch time.
  const imapDir = join(config.dataDir, "imap");
  const imapProvider = new ImapProvider(imapDir);
  console.log("[imap] Email provider ready");

  // 2d. Tool registry
  const toolRegistry = new ToolRegistry(db);
  toolRegistry.setDataDir(config.dataDir);

  // Register calendar tools (per-member handler created at call time)
  if (gwsHealthy) {
    // Calendar tools need the member slug at execution time, so we register
    // a handler factory that the constitution engine will call per-message.
    // For now, register the tool definitions so they show up in grants.
    const googlePlaceholder = async (_name: string, _input: Record<string, unknown>) => ({
      content: "Google not configured for this member. Run gws auth login.",
      is_error: true as const,
    });

    toolRegistry.registerAll(
      CALENDAR_TOOLS.map((def) => ({ definition: def, category: "calendar", tier: "builtin" as const })),
      googlePlaceholder,
    );
    toolRegistry.registerAll(
      GMAIL_TOOLS.map((def) => ({ definition: def, category: "gmail", tier: "builtin" as const })),
      googlePlaceholder,
    );
    toolRegistry.registerAll(
      DRIVE_TOOLS.map((def) => ({ definition: def, category: "drive", tier: "builtin" as const })),
      googlePlaceholder,
    );
  } else {
    // gws not installed — register calendar tools under CalDAV so agents can
    // still use the calendar tools for members with CalDAV credentials saved.
    const caldavPlaceholder = async (_name: string, _input: Record<string, unknown>) => ({
      content: "CalDAV not configured for this member. Save credentials to ~/.carsonos/caldav/<member>/credentials.json",
      is_error: true as const,
    });

    toolRegistry.registerAll(
      CALDAV_CALENDAR_TOOLS.map((def) => ({ definition: def, category: "calendar", tier: "builtin" as const })),
      caldavPlaceholder,
    );
  }

  // Register IMAP email tools (always available — per-member auth checked at call time)
  const imapPlaceholder = async (_name: string, _input: Record<string, unknown>) => ({
    content: "IMAP not configured for this member. Save credentials to ~/.carsonos/imap/<member>/credentials.json",
    is_error: true as const,
  });

  toolRegistry.registerAll(
    IMAP_EMAIL_TOOLS.map((def) => ({ definition: def, category: "email", tier: "builtin" as const })),
    imapPlaceholder,
  );

  // Skills are enabled via trust level ("Skill" built-in for full trust).
  // No need to discover/register them — the SDK handles skill loading.

  // Load custom tools (SKILL.md files on disk) into the registry
  const { loadCustomTools } = await import("./services/custom-tools/index.js");
  await loadCustomTools(db, toolRegistry);

  console.log(`[tools] Registry ready (${toolRegistry.listAll().length} tools registered)`);

  // 3. Constitution engine
  const constitutionEngine = new ConstitutionEngine({
    db,
    broadcast: eventBus.publish,
    adapter,
    memoryProvider,
    toolRegistry,
    calendarProvider: gwsHealthy ? calendarProvider : undefined,
    caldavProvider,
    imapProvider,
    featureFlags: config.featureFlags,
  });
  console.log("[engine] Constitution engine ready");

  // 4. Task engine
  const taskEngine = new TaskEngine({
    db,
    adapter,
    constitutionEngine,
    broadcast: eventBus.publish,
  });
  console.log("[engine] Task engine ready");

  // 5. Carson oversight
  const oversight = new CarsonOversight({
    db,
    constitutionEngine,
    broadcast: eventBus.publish,
  });
  console.log("[engine] Carson oversight ready");

  // 6. Interview engine
  const interviewEngine = new InterviewEngine({
    db,
    adapter,
  });
  console.log("[engine] Interview engine ready");

  // 6a. Profile interview engine
  const profileInterviewEngine = new ProfileInterviewEngine({
    db,
    adapter,
  });
  console.log("[engine] Profile interview engine ready");

  // 6b. Personality interview engine
  const personalityInterviewEngine = new PersonalityInterviewEngine({
    db,
    adapter,
  });
  console.log("[engine] Personality interview engine ready");

  // 6b. Dispatcher (on-demand spawn for internal agent tasks)
  const dispatcher = new Dispatcher({
    db,
    adapter,
    broadcast: eventBus.publish,
  });
  // Recover any tasks stuck in in_progress from a previous crash
  await dispatcher.recoverStuckTasks();
  console.log("[engine] Dispatcher ready (stuck tasks recovered)");

  // 6c. Delegation orchestrator (coordinates delegation lifecycle)
  const orchestrator = new DelegationOrchestrator(
    { db, adapter, broadcast: eventBus.publish },
    dispatcher,
    taskEngine,
  );
  console.log("[engine] Delegation orchestrator ready");

  // 7. Telegram multi-relay (created before app so staff routes can trigger bot starts)
  const multiRelay = new MultiRelayManager({
    db,
    adapter,
    engine: constitutionEngine,
    orchestrator,
  });

  // Wire multiRelay into the constitution engine (for agent pause/resume tools)
  constitutionEngine.setMultiRelay(multiRelay);

  // 8. Create Express app with all dependencies
  const app = await createApp({
    db,
    adapter,
    constitutionEngine,
    taskEngine,
    oversight,
    interviewEngine,
    profileInterviewEngine,
    personalityInterviewEngine,
    toolRegistry,
    multiRelay,
  });

  // 9. Create HTTP server and attach WebSocket
  const server = createServer(app);
  const wss = setupWebSocket(server);

  // 10. Wire event consumers
  eventBus.on("*", broadcast);
  eventBus.on("project.completed", (event) => {
    if (!event.data) return;
    const { parentTaskId } = event.data as { parentTaskId: string };
    orchestrator.handleProjectCompleted(parentTaskId).catch((err) => {
      console.error("[events] Failed to handle project completion:", err);
    });
  });

  eventBus.on("delegation.result", (event) => {
    if (!event.data) return;
    multiRelay.eventBus.emit("delegation.result", event.data);
  });

  // Start per-agent bots (agents with telegramBotToken set)
  await multiRelay.startAll();

  // 11. Start the scheduled task ticker
  const scheduler = new Scheduler({
    db,
    engine: constitutionEngine,
    multiRelay,
    memoryProvider,
  });
  scheduler.start();

  // Start listening on loopback only
  server.listen(config.port, "127.0.0.1", () => {
    console.log(BANNER);
    console.log(`  env:      ${config.nodeEnv}`);
    console.log(`  adapter:  ${adapter.name}`);
    console.log(`  port:     ${config.port}`);
    console.log(`  data dir: ${config.dataDir}`);
    console.log(`  db:       ${dbPath}`);
    console.log(`  memory:   ${config.memory.rootDir}`);
    console.log(`  ws:       ws://127.0.0.1:${config.port}/ws`);
    console.log();

    // Check for updates in the background (non-blocking)
    const projectDir = join(import.meta.dirname, "../..");
    checkForUpdates(projectDir).catch(() => {});
  });

  // Graceful shutdown
  //
  // The hard requirement for dev ergonomics: when tsx watch sends SIGTERM, this
  // process MUST fully exit before tsx force-kills it (~5s grace), AND must
  // release port 3300 cleanly so the next process can rebind without
  // EADDRINUSE.
  //
  // Order matters:
  //   1. Stop the bot pollers — releases Telegram's lock so the new process
  //      doesn't 409. Each bot has POLL_TIMEOUT_S = 3s, all stop in parallel.
  //   2. Force-disconnect WebSocket clients — without this, server.close()
  //      hangs on the open ws connections and the port stays bound.
  //   3. Force-disconnect any lingering HTTP keep-alives via closeAllConnections.
  //   4. server.close() releases the port. After this returns, rebinding works.
  //   5. process.exit(0).
  //
  // Hard deadline (4s) under tsx's force-kill so we never get killed mid-shutdown.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received, closing...`);

    const HARD_EXIT_MS = 4_000;
    const exitTimer = setTimeout(() => {
      console.warn("[shutdown] hard deadline hit, exiting");
      process.exit(0);
    }, HARD_EXIT_MS);
    exitTimer.unref();

    void (async () => {
      try {
        await multiRelay.stopAll();
      } catch (err) {
        console.error("[shutdown] relay stop error:", err);
      }

      // Force-close all WebSocket clients so server.close() can complete.
      try {
        for (const client of wss.clients) {
          try { client.terminate(); } catch { /* swallow */ }
        }
        wss.close();
      } catch { /* swallow */ }

      // Force-drop lingering keep-alive HTTP connections.
      try { server.closeAllConnections(); } catch { /* swallow */ }

      // Now server.close() returns quickly because nothing is open.
      await new Promise<void>((resolve) => server.close(() => resolve()));

      console.log("[shutdown] done");
      process.exit(0);
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
