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
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createDb } from "@carsonos/db";
import { getConfig } from "./config.js";
import { createApp } from "./app.js";
import { setupWebSocket, broadcast } from "./ws/live-events.js";
import { createAdapter } from "./services/subprocess-adapter.js";
import { ConstitutionEngine } from "./services/constitution-engine.js";
import { TaskEngine } from "./services/task-engine.js";
import { CarsonOversight } from "./services/carson-oversight.js";
import { InterviewEngine } from "./services/interview.js";
import { ProfileInterviewEngine } from "./services/profile-interview.js";
import { createTelegramRelay } from "./services/telegram-relay.js";
import { Dispatcher } from "./services/dispatcher.js";
import { DelegationOrchestrator } from "./services/delegation-orchestrator.js";
import { MultiRelayManager } from "./services/multi-relay-manager.js";

const BANNER = [
  "",
  " CarsonOS v3",
  " Constitution Engine + Task Governance",
  "",
].join("\n");

async function main() {
  const config = getConfig();
  const dbPath = join(config.dataDir, "carsonos.db");

  // Ensure data directory exists
  mkdirSync(config.dataDir, { recursive: true });

  // 1. Boot database
  const db = createDb(dbPath);
  console.log(`[db] SQLite open at ${dbPath}`);

  // 2. Create adapter
  const adapter = createAdapter(config.adapterType);
  const adapterHealthy = await adapter.healthCheck();
  console.log(
    `[adapter] ${adapter.name} — ${adapterHealthy ? "healthy" : "unavailable"}`,
  );

  // 3. Constitution engine
  const constitutionEngine = new ConstitutionEngine({
    db,
    broadcast,
    adapter,
  });
  console.log("[engine] Constitution engine ready");

  // 4. Task engine
  const taskEngine = new TaskEngine({
    db,
    adapter,
    constitutionEngine,
    broadcast,
  });
  console.log("[engine] Task engine ready");

  // 5. Carson oversight
  const oversight = new CarsonOversight({
    db,
    constitutionEngine,
    broadcast,
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

  // 6b. Dispatcher (on-demand spawn for internal agent tasks)
  const dispatcher = new Dispatcher({
    db,
    adapter,
    broadcast,
  });
  // Recover any tasks stuck in in_progress from a previous crash
  await dispatcher.recoverStuckTasks();
  console.log("[engine] Dispatcher ready (stuck tasks recovered)");

  // 6c. Delegation orchestrator (coordinates delegation lifecycle)
  const orchestrator = new DelegationOrchestrator(
    { db, adapter, broadcast },
    dispatcher,
    taskEngine,
  );
  console.log("[engine] Delegation orchestrator ready");

  // 7. Create Express app with all dependencies
  const app = await createApp({
    db,
    adapter,
    constitutionEngine,
    taskEngine,
    oversight,
    interviewEngine,
    profileInterviewEngine,
  });

  // 8. Create HTTP server and attach WebSocket
  const server = createServer(app);
  setupWebSocket(server);

  // 9. Wire server-side event bridges
  //    dispatcher -> orchestrator: project completion triggers synthesis
  //    orchestrator -> multi-relay: synthesis results delivered to kids
  const originalBroadcast = broadcast;
  const broadcastWithBridge = (event: { type: string; data?: unknown }) => {
    originalBroadcast(event); // WebSocket to browsers

    // Server-side bridge: project.completed -> orchestrator
    if (event.type === "project.completed" && event.data) {
      const { parentTaskId } = event.data as { parentTaskId: string };
      orchestrator.handleProjectCompleted(parentTaskId).catch((err) => {
        console.error("[bridge] Failed to handle project completion:", err);
      });
    }
  };

  // Patch the broadcast function on services that need the bridge
  (dispatcher as any).broadcast = broadcastWithBridge;

  // 10. Telegram relay (multi-bot for per-agent bots, legacy for single-bot fallback)
  const multiRelay = new MultiRelayManager({
    db,
    adapter,
    engine: constitutionEngine,
    taskEngine,
    orchestrator,
  });

  // Wire orchestrator delegation.result -> multi-relay for Telegram delivery
  const origOrchestratorBroadcast = (orchestrator as any).broadcast;
  (orchestrator as any).broadcast = (event: { type: string; data?: unknown }) => {
    origOrchestratorBroadcast(event); // WebSocket to browsers
    if (event.type === "delegation.result" && event.data) {
      multiRelay.eventBus.emit("delegation.result", event.data);
    }
  };

  // Start per-agent bots (agents with telegramBotToken set)
  await multiRelay.startAll();

  // Legacy single-bot relay as fallback (if TELEGRAM_BOT_TOKEN is set)
  let telegramRelay: ReturnType<typeof createTelegramRelay> | null = null;
  if (config.telegramBotToken) {
    telegramRelay = createTelegramRelay({
      token: config.telegramBotToken,
      db,
      engine: constitutionEngine,
      taskEngine,
    });
    telegramRelay.start();
  } else {
    console.log("[telegram] No legacy TELEGRAM_BOT_TOKEN, multi-bot only");
  }

  // Start listening on loopback only
  server.listen(config.port, "127.0.0.1", () => {
    console.log(BANNER);
    console.log(`  env:      ${config.nodeEnv}`);
    console.log(`  adapter:  ${adapter.name}`);
    console.log(`  port:     ${config.port}`);
    console.log(`  data dir: ${config.dataDir}`);
    console.log(`  db:       ${dbPath}`);
    console.log(`  ws:       ws://127.0.0.1:${config.port}/ws`);
    console.log();
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[shutdown] closing...");
    await multiRelay.stopAll();
    telegramRelay?.stop();
    server.close(() => {
      console.log("[shutdown] done");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
