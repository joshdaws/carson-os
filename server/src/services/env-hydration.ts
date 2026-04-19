/**
 * Hydrate selected platform secrets from instance_settings into process.env.
 *
 * Why: a few platform-level keys (currently just GROQ_API_KEY for voice
 * transcription) are user-facing — operators want to set them from the
 * Settings UI, not by editing files on disk. The UI saves to instance_settings;
 * this loader pushes those values into process.env at boot so the rest of the
 * codebase can keep reading them with `process.env.X`.
 *
 * Operator env wins. If GROQ_API_KEY is already set in the process environment
 * (e.g. via systemd EnvironmentFile, Docker, or a hand-set export), we leave
 * it alone — that's the operator override.
 *
 * Explicitly NOT hydrated: ANTHROPIC_API_KEY. Claude calls go through the
 * Claude Max subscription via the Agent SDK / Claude CLI. An Anthropic API
 * key in env would route around the subscription and bill against API quota.
 */

import { inArray } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { instanceSettings } from "@carsonos/db";

/**
 * Allow-list of instance_settings keys that may be hydrated into process.env.
 * Anything not in this set is ignored, even if present in the table.
 */
export const HYDRATABLE_ENV_KEYS = ["GROQ_API_KEY"] as const;
export type HydratableEnvKey = (typeof HYDRATABLE_ENV_KEYS)[number];

const HYDRATABLE_SET: Set<string> = new Set(HYDRATABLE_ENV_KEYS);

export function isHydratableEnvKey(key: string): key is HydratableEnvKey {
  return HYDRATABLE_SET.has(key);
}

/**
 * Apply a single setting to process.env if it is allow-listed and the env
 * doesn't already define a value. Returns true if process.env was updated.
 */
export function applyHydratableSetting(key: string, value: unknown): boolean {
  if (!isHydratableEnvKey(key)) return false;
  if (typeof value !== "string" || value.length === 0) return false;
  if (process.env[key]) return false; // operator override wins
  process.env[key] = value;
  return true;
}

/**
 * Read allow-listed settings from the DB and write them into process.env.
 * Call once at boot, before services that depend on these keys initialize.
 */
export async function hydrateEnvFromSettings(db: Db): Promise<void> {
  const rows = db
    .select()
    .from(instanceSettings)
    .where(inArray(instanceSettings.key, [...HYDRATABLE_ENV_KEYS]))
    .all();

  let loaded = 0;
  let skippedByEnv = 0;

  for (const row of rows) {
    if (!isHydratableEnvKey(row.key)) continue;

    if (process.env[row.key]) {
      skippedByEnv++;
      console.log(
        `[env-hydration] ${row.key} already set in process env, DB value not used`,
      );
      continue;
    }

    if (typeof row.value !== "string" || !row.value) continue;

    process.env[row.key] = row.value;
    loaded++;
    console.log(`[env-hydration] ${row.key} loaded from instance_settings`);
  }

  if (loaded === 0 && skippedByEnv === 0) {
    console.log("[env-hydration] no hydratable secrets in instance_settings");
  }
}
