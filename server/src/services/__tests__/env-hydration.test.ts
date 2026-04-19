/**
 * Tests for env-hydration: the boot-time bridge between instance_settings and
 * process.env. Security-critical because the allow-list is the sole gate
 * preventing arbitrary instance_settings keys (including ANTHROPIC_API_KEY)
 * from being pushed into env at boot.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  applyHydratableSetting,
  isHydratableEnvKey,
  HYDRATABLE_ENV_KEYS,
} from "../env-hydration.js";

const SAVED_GROQ = process.env.GROQ_API_KEY;
const SAVED_ANTHROPIC = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  delete process.env.GROQ_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  if (SAVED_GROQ === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = SAVED_GROQ;
  if (SAVED_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = SAVED_ANTHROPIC;
});

describe("HYDRATABLE_ENV_KEYS allow-list", () => {
  it("contains GROQ_API_KEY", () => {
    expect(HYDRATABLE_ENV_KEYS).toContain("GROQ_API_KEY");
  });

  it("does NOT contain ANTHROPIC_API_KEY (subscription-only by design)", () => {
    expect(HYDRATABLE_ENV_KEYS).not.toContain("ANTHROPIC_API_KEY");
  });

  it("only contains the keys the platform should hydrate", () => {
    expect([...HYDRATABLE_ENV_KEYS]).toEqual(["GROQ_API_KEY"]);
  });
});

describe("isHydratableEnvKey", () => {
  it("accepts allow-listed keys", () => {
    expect(isHydratableEnvKey("GROQ_API_KEY")).toBe(true);
  });

  it("rejects ANTHROPIC_API_KEY", () => {
    expect(isHydratableEnvKey("ANTHROPIC_API_KEY")).toBe(false);
  });

  it("rejects arbitrary unknown keys", () => {
    expect(isHydratableEnvKey("HOUSEHOLD_NAME")).toBe(false);
    expect(isHydratableEnvKey("FOO")).toBe(false);
    expect(isHydratableEnvKey("")).toBe(false);
  });
});

describe("applyHydratableSetting", () => {
  it("writes GROQ_API_KEY into process.env when env is unset", () => {
    const updated = applyHydratableSetting("GROQ_API_KEY", "gsk_test123");
    expect(updated).toBe(true);
    expect(process.env.GROQ_API_KEY).toBe("gsk_test123");
  });

  it("respects operator env override (does not overwrite an existing env value)", () => {
    process.env.GROQ_API_KEY = "operator-set-value";
    const updated = applyHydratableSetting("GROQ_API_KEY", "db-value");
    expect(updated).toBe(false);
    expect(process.env.GROQ_API_KEY).toBe("operator-set-value");
  });

  it("refuses non-string values", () => {
    const updated = applyHydratableSetting("GROQ_API_KEY", 12345 as unknown as string);
    expect(updated).toBe(false);
    expect(process.env.GROQ_API_KEY).toBeUndefined();
  });

  it("refuses empty strings", () => {
    const updated = applyHydratableSetting("GROQ_API_KEY", "");
    expect(updated).toBe(false);
    expect(process.env.GROQ_API_KEY).toBeUndefined();
  });

  it("refuses keys not on the allow-list, even with valid string values", () => {
    const updated = applyHydratableSetting("ANTHROPIC_API_KEY", "sk-ant-foo");
    expect(updated).toBe(false);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("refuses arbitrary keys (HOUSEHOLD_NAME, FOO, etc)", () => {
    const updated = applyHydratableSetting("HOUSEHOLD_NAME", "Smith Family");
    expect(updated).toBe(false);
    expect(process.env.HOUSEHOLD_NAME).toBeUndefined();
  });
});
