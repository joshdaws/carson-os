/**
 * Per-harness conversation session storage.
 *
 * A conversation can be served by different model "harnesses" over its life
 * (Claude today; Codex in v0.6.0). Each harness owns its own resume token —
 * Claude an Agent SDK `session_id`, Codex a `thread_id` — and switching the
 * agent's model must NOT clobber the other harness's token. This module owns
 * the shape persisted in `conversations.session_context` and the pure helpers
 * the engine uses to read and merge it.
 *
 * Persisted shape (`conversations.session_context` JSON):
 *   {
 *     activeHarness: "claude",
 *     sessions: {
 *       claude: { id, lastActivity, toolCallNames, contextSignature? },
 *       codex:  { id, lastActivity, toolCallNames, contextSignature? }
 *     }
 *   }
 *
 * Legacy shape (pre-v0.6.0, implicitly Claude):
 *   { sessionId, lastActivity, toolCallNames, contextSignature? }
 * `parseSessionContext()` upgrades it to the keyed shape on read; the next
 * `setHarnessSession()` rewrites the row in the new shape. No DB migration
 * is required — the column is already nullable JSON.
 */

/**
 * Free-form harness identifier (e.g. "claude", "codex"). Kept a string — not a
 * `'claude' | 'codex'` union — so adding a third model family is a new registry
 * entry, not a type change rippling across the codebase.
 */
export type HarnessKey = string;

export interface HarnessSessionState {
  /** Resume token for this harness: Agent SDK `session_id` (claude) or `thread_id` (codex). */
  id: string;
  /** ISO-8601 timestamp of the most recent turn served by this harness. */
  lastActivity: string;
  /** Tool names invoked on the most recent turn (diagnostic only). */
  toolCallNames: string[];
  /** Hash of the system-prompt context at the last turn; drives lean-resume. */
  contextSignature?: string;
}

export interface ConversationSessionContext {
  /** Harness that served the most recent turn. */
  activeHarness: HarnessKey;
  /** Per-harness resume state, keyed by {@link HarnessKey}. */
  sessions: Record<HarnessKey, HarnessSessionState>;
}

/**
 * Map an `agent.model` string to its harness key.
 *   "claude-sonnet-4-6" -> "claude"
 *   "claude/sonnet-4-6" -> "claude"
 *   "codex/gpt-5.4"     -> "codex"
 * Unknown or empty values default to "claude" — today's only live harness.
 */
export function harnessKeyForModel(model: string | null | undefined): HarnessKey {
  if (!model) return "claude";
  const m = model.toLowerCase();
  // Prefer an explicit "<family>/<variant>" prefix when present.
  const family = m.includes("/") ? m.slice(0, m.indexOf("/")) : m;
  if (family.startsWith("codex") || family.startsWith("openai") || family.startsWith("gpt")) {
    return "codex";
  }
  return "claude";
}

/**
 * Parse a raw `session_context` value into the keyed shape. Accepts the
 * current keyed shape, the legacy flat (implicitly-Claude) shape, and returns
 * `null` for anything missing or malformed (caller starts a fresh session).
 */
export function parseSessionContext(raw: unknown): ConversationSessionContext | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  // New keyed shape.
  if (obj.sessions && typeof obj.sessions === "object") {
    const sessions = normalizeSessions(obj.sessions as Record<string, unknown>);
    const keys = Object.keys(sessions);
    if (keys.length === 0) return null;
    const activeHarness =
      typeof obj.activeHarness === "string" && sessions[obj.activeHarness]
        ? obj.activeHarness
        : keys[0];
    return { activeHarness, sessions };
  }

  // Legacy flat shape — implicitly Claude (pre-v0.6.0 rows).
  if (typeof obj.sessionId === "string" && typeof obj.lastActivity === "string") {
    return {
      activeHarness: "claude",
      sessions: {
        claude: {
          id: obj.sessionId,
          lastActivity: obj.lastActivity,
          toolCallNames: stringArray(obj.toolCallNames),
          ...(typeof obj.contextSignature === "string"
            ? { contextSignature: obj.contextSignature }
            : {}),
        },
      },
    };
  }

  return null;
}

/**
 * Return a new context with `key`'s session set to `state` and `activeHarness`
 * pointed at `key`. All other harnesses' sessions are preserved untouched —
 * this is the merge that keeps a model switch from dropping the sibling
 * harness's resume token.
 */
export function setHarnessSession(
  ctx: ConversationSessionContext | null,
  key: HarnessKey,
  state: HarnessSessionState,
): ConversationSessionContext {
  return {
    activeHarness: key,
    sessions: { ...(ctx?.sessions ?? {}), [key]: state },
  };
}

/** Read a single harness's session state, if present. */
export function getHarnessSession(
  ctx: ConversationSessionContext | null,
  key: HarnessKey,
): HarnessSessionState | undefined {
  return ctx?.sessions[key];
}

// -- internal ---------------------------------------------------------

function normalizeSessions(
  raw: Record<string, unknown>,
): Record<HarnessKey, HarnessSessionState> {
  const out: Record<HarnessKey, HarnessSessionState> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!val || typeof val !== "object") continue;
    const s = val as Record<string, unknown>;
    if (typeof s.id !== "string" || typeof s.lastActivity !== "string") continue;
    out[key] = {
      id: s.id,
      lastActivity: s.lastActivity,
      toolCallNames: stringArray(s.toolCallNames),
      ...(typeof s.contextSignature === "string" ? { contextSignature: s.contextSignature } : {}),
    };
  }
  return out;
}

function stringArray(val: unknown): string[] {
  return Array.isArray(val) ? val.filter((n): n is string => typeof n === "string") : [];
}
