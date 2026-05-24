/**
 * The Harness abstraction (v0.6.0). A harness owns one model family's agent
 * loop: it runs a single turn, streams normalized {@link HarnessEvent}s back,
 * and owns its own session resume. `ClaudeHarness` wraps the existing Claude
 * Agent SDK adapter; `CodexHarness` (later) shells out to `codex exec --json`.
 *
 * Consumers (the engine, the Telegram streaming layer) read the event stream
 * and the declared {@link HarnessCapabilities} — never a hardcoded model
 * enum — so adding a third family is a registry entry, not a type change.
 *
 * See harness/CONTRACT.md for the streaming guarantees implementors must hold.
 */

import type { HarnessEvent, HarnessTurnParams } from "@carsonos/shared";

/**
 * What a harness can do. Read by the engine and the UI picker so neither has
 * to branch on a model string. The registry owns these declarations.
 */
export interface HarnessCapabilities {
  /** Accepts image attachments on a turn. */
  supportsImages: boolean;
  /** Exposes system tools to the model via MCP. */
  supportsMcp: boolean;
  /**
   * When a tool-list change takes effect:
   *   'mid-turn'  — usable within the current turn (Claude).
   *   'per-turn'  — usable on the next turn only (Codex).
   */
  refreshTier: "mid-turn" | "per-turn";
  /** Reasoning levels this harness honors, if any (Codex). Undefined = none. */
  reasoningLevels?: readonly string[];
  /** Shape of the resume token this harness persists. */
  resumeKind: "session_id" | "thread_id";
}

export interface AgentHarness {
  /** Stable harness key, e.g. "claude" or "codex". Matches the registry key. */
  readonly id: string;
  readonly capabilities: HarnessCapabilities;

  /**
   * Run one agent turn, streaming normalized events. Must NOT throw — failures
   * are emitted as a terminal `{ type: 'error' }` event. Aborting `signal`
   * stops compute; the stream then flushes buffered events and ends with
   * `{ type: 'error', recoverable: true, error: 'aborted' }`.
   */
  streamTurn(params: HarnessTurnParams, signal: AbortSignal): AsyncIterable<HarnessEvent>;

  /** Whether this harness can currently serve a turn (binary/auth/reachability). */
  healthCheck(): Promise<{ healthy: boolean; reason?: string }>;
}
