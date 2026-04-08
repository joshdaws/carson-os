import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterType } from "@carsonos/shared";

export interface Config {
  port: number;
  dataDir: string;
  nodeEnv: string;
  anthropicApiKey?: string;
  telegramBotToken?: string;
  adapterType: AdapterType;
}

export function getConfig(): Config {
  const dataDir =
    process.env.DATA_DIR ?? join(homedir(), ".carsonos");

  // Determine adapter: prefer subprocess if binary is available
  let adapterType: AdapterType = "anthropic-sdk";
  if (process.env.CARSONOS_ADAPTER === "claude-code") {
    adapterType = "claude-code";
  } else if (process.env.CARSONOS_ADAPTER === "codex") {
    adapterType = "codex";
  } else if (!process.env.ANTHROPIC_API_KEY) {
    // No API key: try subprocess adapters
    adapterType = "claude-code";
  }

  return {
    port: Number(process.env.PORT) || 3300,
    dataDir,
    nodeEnv: process.env.NODE_ENV ?? "development",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    adapterType,
  };
}
