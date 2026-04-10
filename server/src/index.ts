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
import { AppEventBus } from "./services/event-bus.js";
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
import { bootMemory } from "./services/memory/index.js";
import { ToolRegistry } from "./services/tool-registry.js";

const BANNER = [
  "",
  " CarsonOS v3",
  " Constitution Engine + Task Governance",
  "",
].join("\n");

async function main() {
  const config = getConfig();
  const dbPath = join(config.dataDir, "carsonos.db");
  const eventBus = new AppEventBus();

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

  // 2b. Boot memory system
  let memoryProvider = undefined;
  try {
    memoryProvider = await bootMemory(db, config.memory);
    console.log(`[memory] Provider ready (${config.memory.kind}) at ${config.memory.rootDir}`);
  } catch (err) {
    console.warn("[memory] Boot failed, running without memory:", err);
  }

  // 2c. Tool registry
  const toolRegistry = new ToolRegistry(db);
  console.log(`[tools] Registry ready (${toolRegistry.listAll().length} tools registered)`);

  // 3. Constitution engine
  const constitutionEngine = new ConstitutionEngine({
    db,
    broadcast: eventBus.publish,
    adapter,
    memoryProvider,
    toolRegistry,
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

  // 9. Wire event consumers
  eventBus.on("*", broadcast);
  eventBus.on("project.completed", (event) => {
    if (!event.data) return;
    const { parentTaskId } = event.data as { parentTaskId: string };
    orchestrator.handleProjectCompleted(parentTaskId).catch((err) => {
      console.error("[events] Failed to handle project completion:", err);
    });
  });

  // 10. Telegram relay (multi-bot for per-agent bots, legacy for single-bot fallback)
  const multiRelay = new MultiRelayManager({
    db,
    adapter,
    engine: constitutionEngine,
    taskEngine,
    orchestrator,
  });

  eventBus.on("delegation.result", (event) => {
    if (!event.data) return;
    multiRelay.eventBus.emit("delegation.result", event.data);
  });

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
    console.log(`  memory:   ${config.memory.rootDir}`);
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
