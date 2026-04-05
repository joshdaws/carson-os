import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createDb } from "@carsonos/db";
import { getConfig } from "./config.js";
import { createApp } from "./app.js";
import { setupWebSocket, broadcast } from "./ws/live-events.js";
import { ConstitutionEngine } from "./services/engine.js";
import { executeAgent } from "./services/claude.js";
import { createTelegramRelay } from "./services/telegram-relay.js";

const BANNER = `
 ██████╗ █████╗ ██████╗ ███████╗ ██████╗ ███╗   ██╗ ██████╗ ███████╗
██╔════╝██╔══██╗██╔══██╗██╔════╝██╔═══██╗████╗  ██║██╔═══██╗██╔════╝
██║     ███████║██████╔╝███████╗██║   ██║██╔██╗ ██║██║   ██║███████╗
██║     ██╔══██║██╔══██╗╚════██║██║   ██║██║╚██╗██║██║   ██║╚════██║
╚██████╗██║  ██║██║  ██║███████║╚██████╔╝██║ ╚████║╚██████╔╝███████║
 ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ ╚══════╝
`;

async function main() {
  const config = getConfig();
  const dbPath = join(config.dataDir, "carsonos.db");

  // Ensure data directory exists
  mkdirSync(config.dataDir, { recursive: true });

  // Boot database
  const db = createDb(dbPath);
  console.log(`[db] SQLite open at ${dbPath}`);

  // Create Express app
  const app = await createApp(db);

  // Create constitution engine
  const engine = new ConstitutionEngine({
    db,
    broadcast,
    executor: executeAgent,
  });
  console.log("[engine] Constitution engine ready");

  // Create HTTP server and attach WebSocket
  const server = createServer(app);
  setupWebSocket(server);

  // Start Telegram relay if bot token is configured
  let telegramRelay: ReturnType<typeof createTelegramRelay> | null = null;
  if (config.telegramBotToken) {
    telegramRelay = createTelegramRelay({
      token: config.telegramBotToken,
      db,
      engine,
    });
    telegramRelay.start();
  } else {
    console.log("[telegram] No TELEGRAM_BOT_TOKEN set, relay disabled");
  }

  // Start listening on loopback only
  server.listen(config.port, "127.0.0.1", () => {
    console.log(BANNER);
    console.log(`  env:      ${config.nodeEnv}`);
    console.log(`  port:     ${config.port}`);
    console.log(`  data dir: ${config.dataDir}`);
    console.log(`  db:       ${dbPath}`);
    console.log(`  ws:       ws://127.0.0.1:${config.port}/ws`);
    console.log();
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[shutdown] closing...");
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
