/**
 * Harness registry. Maps an `agent.model` string to the harness that serves
 * it, without anyone hardcoding a `'claude' | 'codex'` union. Adding a model
 * family is one `registerHarness()` call at startup (see index/bootstrap).
 *
 * Resolution: `agent.model` → harness key (via {@link harnessKeyForModel}) →
 * registered factory. An unknown key falls back to "claude" (today's only
 * always-present harness) with a logged warning, so a typo'd or future model
 * string degrades to a working agent rather than a crash.
 */

import { harnessKeyForModel } from "./session-context.js";
import type { AgentHarness } from "./types.js";

type HarnessFactory = () => AgentHarness;

const factories = new Map<string, HarnessFactory>();
const instances = new Map<string, AgentHarness>();

const FALLBACK_KEY = "claude";

/** Register a harness factory under a key (e.g. "claude", "codex"). */
export function registerHarness(key: string, factory: HarnessFactory): void {
  factories.set(key, factory);
  instances.delete(key); // re-resolve lazily if re-registered
}

/** Whether a harness is registered under `key`. */
export function hasHarness(key: string): boolean {
  return factories.has(key);
}

/**
 * Resolve the harness for a model string. Falls back to "claude" with a log
 * if the model's key has no registered harness.
 */
export function resolveHarness(model: string | null | undefined): AgentHarness {
  const requested = harnessKeyForModel(model);
  let key = requested;

  if (!factories.has(key)) {
    console.warn(
      `[harness-registry] unknown_model model=${model ?? "null"} key=${requested} falling_back_to=${FALLBACK_KEY}`,
    );
    key = FALLBACK_KEY;
  }

  const factory = factories.get(key);
  if (!factory) {
    throw new Error(
      `[harness-registry] no harness registered for fallback key "${FALLBACK_KEY}" — registerHarness("${FALLBACK_KEY}", ...) must run at startup`,
    );
  }

  let instance = instances.get(key);
  if (!instance) {
    instance = factory();
    instances.set(key, instance);
  }
  return instance;
}

/** Test-only: clear all registrations and memoized instances. */
export function __TEST_resetRegistry(): void {
  factories.clear();
  instances.clear();
}
