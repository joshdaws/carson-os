import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  nodeEnv: string;
  anthropicApiKey?: string;
  telegramBotToken?: string;
}

export function getConfig(): Config {
  const dataDir =
    process.env.DATA_DIR ?? join(homedir(), ".carsonos");

  return {
    port: Number(process.env.PORT) || 3100,
    dataDir,
    nodeEnv: process.env.NODE_ENV ?? "development",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
  };
}
