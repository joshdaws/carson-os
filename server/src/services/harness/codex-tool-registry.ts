/**
 * Per-turn tool registry for the Codex HTTP MCP server.
 *
 * Codex connects to CarsonOS's loopback streamable-HTTP MCP endpoint with a
 * per-turn bearer token (see codex-auth-bridge HTTP config). This registry maps
 * that token to the turn's tool definitions + executor, so the MCP endpoint can
 * answer `tools/list` and `tools/call` for exactly that agent's turn — and the
 * tools execute IN the CarsonOS main process (unjailed), not in a subprocess.
 *
 * CodexHarness registers a turn before spawning codex and unregisters it when
 * the turn ends; the TTL is a backstop so a crashed/killed turn can't leak an
 * entry forever.
 */

import crypto from "node:crypto";
import type { ToolDefinition, ToolExecutor } from "@carsonos/shared";

export interface RegisteredTurn {
  tools: ToolDefinition[];
  executor: ToolExecutor;
  expiresAt: number;
}

/** A turn shouldn't outlive this; backstops leaks from crashed/killed turns. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class CodexToolRegistry {
  private readonly turns = new Map<string, RegisteredTurn>();

  /** Register a turn's tools + executor; returns a fresh opaque bearer token. */
  register(tools: ToolDefinition[], executor: ToolExecutor, ttlMs = DEFAULT_TTL_MS): string {
    this.sweep();
    const token = crypto.randomBytes(32).toString("base64url");
    this.turns.set(token, { tools, executor, expiresAt: Date.now() + ttlMs });
    return token;
  }

  /** Resolve a bearer token to its turn, or undefined if unknown/expired. */
  get(token: string): RegisteredTurn | undefined {
    const turn = this.turns.get(token);
    if (!turn) return undefined;
    if (Date.now() > turn.expiresAt) {
      this.turns.delete(token);
      return undefined;
    }
    return turn;
  }

  /** Drop a turn (call when the turn ends). Idempotent. */
  unregister(token: string): void {
    this.turns.delete(token);
  }

  /** Number of live registrations (for diagnostics/tests). */
  get size(): number {
    return this.turns.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, turn] of this.turns) {
      if (now > turn.expiresAt) this.turns.delete(token);
    }
  }
}
