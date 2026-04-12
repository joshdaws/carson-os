import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterType } from "@carsonos/shared";

export interface MemoryConfig {
  /** Memory provider kind: "qmd" (default) or a module path for custom providers */
  kind: string;
  /** Root directory for memory files (default: {dataDir}/memory) */
  rootDir: string;
}

export interface Config {
  port: number;
  dataDir: string;
  nodeEnv: string;
  anthropicApiKey?: string;
  telegramBotToken?: string;
  adapterType: AdapterType;
  memory: MemoryConfig;
  featureFlags: {
    hardEvaluators: boolean;
  };
}

export function getConfig(): Config {
  const dataDir =
    process.env.DATA_DIR ?? join(homedir(), ".carsonos");

  // Determine adapter: default to Agent SDK (uses Claude subscription, no API key needed)
  let adapterType: AdapterType = "anthropic-sdk";
  if (process.env.CARSONOS_ADAPTER === "claude-code") {
    adapterType = "claude-code";
  } else if (process.env.CARSONOS_ADAPTER === "codex") {
    adapterType = "codex";
  } else if (process.env.CARSONOS_ADAPTER === "anthropic-sdk") {
    adapterType = "anthropic-sdk";
  }

  return {
    port: Number(process.env.PORT) || 3300,
    dataDir,
    nodeEnv: process.env.NODE_ENV ?? "development",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    adapterType,
    memory: {
      kind: process.env.CARSONOS_MEMORY_PROVIDER ?? "qmd",
      rootDir: process.env.CARSONOS_MEMORY_DIR ?? join(dataDir, "memory"),
    },
    featureFlags: {
      hardEvaluators: process.env.CARSONOS_HARD_EVALUATORS === "true",
    },
  };
}
