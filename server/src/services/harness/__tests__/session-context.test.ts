/**
 * Unit tests for per-harness conversation session storage.
 *
 * Pins the v0.6.0 storage contract before any harness code builds on it:
 *   - Legacy flat (implicitly-Claude) rows still parse and resume — no DB
 *     migration, no lost sessions on deploy.
 *   - A model switch merges, never clobbers: setting one harness's token
 *     preserves the sibling harness's token (the Challenge-C race fix).
 *   - Malformed/empty input yields null so the caller starts fresh.
 */

import { describe, it, expect } from "vitest";
import {
  parseSessionContext,
  setHarnessSession,
  getHarnessSession,
  harnessKeyForModel,
  type ConversationSessionContext,
  type HarnessSessionState,
} from "../session-context.js";

const claudeState: HarnessSessionState = {
  id: "sess-claude-1",
  lastActivity: "2026-05-24T10:00:00.000Z",
  toolCallNames: ["search_memory"],
  contextSignature: "abc123",
};

const codexState: HarnessSessionState = {
  id: "thread-codex-1",
  lastActivity: "2026-05-24T11:00:00.000Z",
  toolCallNames: [],
};

describe("harnessKeyForModel", () => {
  it("maps Claude model strings (hyphen and slash) to 'claude'", () => {
    expect(harnessKeyForModel("claude-sonnet-4-6")).toBe("claude");
    expect(harnessKeyForModel("claude/sonnet-4-6")).toBe("claude");
    expect(harnessKeyForModel("CLAUDE-OPUS")).toBe("claude");
  });

  it("maps Codex / OpenAI / gpt model strings to 'codex'", () => {
    expect(harnessKeyForModel("codex/gpt-5.4")).toBe("codex");
    expect(harnessKeyForModel("openai/gpt-5.4")).toBe("codex");
    expect(harnessKeyForModel("gpt-5.4")).toBe("codex");
  });

  it("defaults unknown/empty to 'claude' (today's only live harness)", () => {
    expect(harnessKeyForModel(null)).toBe("claude");
    expect(harnessKeyForModel(undefined)).toBe("claude");
    expect(harnessKeyForModel("")).toBe("claude");
    expect(harnessKeyForModel("mystery-model")).toBe("claude");
  });
});

describe("parseSessionContext — legacy flat shape", () => {
  it("upgrades a legacy Claude row to the keyed shape", () => {
    const ctx = parseSessionContext({
      sessionId: "sess-legacy",
      lastActivity: "2026-05-24T09:00:00.000Z",
      toolCallNames: ["a", "b"],
      contextSignature: "sig",
    });
    expect(ctx).toEqual<ConversationSessionContext>({
      activeHarness: "claude",
      sessions: {
        claude: {
          id: "sess-legacy",
          lastActivity: "2026-05-24T09:00:00.000Z",
          toolCallNames: ["a", "b"],
          contextSignature: "sig",
        },
      },
    });
  });

  it("tolerates a legacy row missing optional fields", () => {
    const ctx = parseSessionContext({
      sessionId: "sess-legacy",
      lastActivity: "2026-05-24T09:00:00.000Z",
    });
    expect(getHarnessSession(ctx, "claude")).toEqual({
      id: "sess-legacy",
      lastActivity: "2026-05-24T09:00:00.000Z",
      toolCallNames: [],
    });
  });
});

describe("parseSessionContext — keyed shape", () => {
  it("round-trips a multi-harness context", () => {
    const raw = {
      activeHarness: "codex",
      sessions: { claude: claudeState, codex: codexState },
    };
    expect(parseSessionContext(raw)).toEqual(raw);
  });

  it("falls back to the first session key when activeHarness is invalid", () => {
    const ctx = parseSessionContext({
      activeHarness: "gemini",
      sessions: { claude: claudeState },
    });
    expect(ctx?.activeHarness).toBe("claude");
  });

  it("drops session entries missing id or lastActivity", () => {
    const ctx = parseSessionContext({
      activeHarness: "claude",
      sessions: {
        claude: claudeState,
        codex: { id: "x" }, // missing lastActivity → dropped
      },
    });
    expect(getHarnessSession(ctx, "claude")).toBeDefined();
    expect(getHarnessSession(ctx, "codex")).toBeUndefined();
  });
});

describe("parseSessionContext — malformed input", () => {
  it("returns null for null / non-object / empty / unrecognized shapes", () => {
    expect(parseSessionContext(null)).toBeNull();
    expect(parseSessionContext(undefined)).toBeNull();
    expect(parseSessionContext("string")).toBeNull();
    expect(parseSessionContext(42)).toBeNull();
    expect(parseSessionContext({})).toBeNull();
    expect(parseSessionContext({ sessions: {} })).toBeNull();
    expect(parseSessionContext({ foo: "bar" })).toBeNull();
  });
});

describe("setHarnessSession — merge, never clobber", () => {
  it("adds a harness token without dropping the sibling's token", () => {
    const start = parseSessionContext({
      activeHarness: "claude",
      sessions: { claude: claudeState },
    });
    const merged = setHarnessSession(start, "codex", codexState);

    expect(merged.activeHarness).toBe("codex");
    // The Challenge-C invariant: the Claude token survives the switch.
    expect(getHarnessSession(merged, "claude")).toEqual(claudeState);
    expect(getHarnessSession(merged, "codex")).toEqual(codexState);
  });

  it("overwrites only the targeted harness on a repeat turn", () => {
    const start = setHarnessSession(null, "claude", claudeState);
    const next: HarnessSessionState = { ...claudeState, id: "sess-claude-2" };
    const merged = setHarnessSession(start, "claude", next);

    expect(getHarnessSession(merged, "claude")?.id).toBe("sess-claude-2");
    expect(Object.keys(merged.sessions)).toEqual(["claude"]);
  });

  it("seeds a fresh context from null", () => {
    const merged = setHarnessSession(null, "claude", claudeState);
    expect(merged).toEqual<ConversationSessionContext>({
      activeHarness: "claude",
      sessions: { claude: claudeState },
    });
  });

  it("does not mutate the input context", () => {
    const start = setHarnessSession(null, "claude", claudeState);
    const snapshot = JSON.parse(JSON.stringify(start));
    setHarnessSession(start, "codex", codexState);
    expect(start).toEqual(snapshot);
  });
});
