/**
 * Signal Relay Manager — one signal-cli daemon connection per agent.
 *
 * Mirrors MultiRelayManager but uses signal-cli in HTTP JSON-RPC daemon
 * mode as the transport instead of grammy/Telegram long-polling.
 *
 * Each family-visible agent with a configured Signal account gets its own
 * daemon connection. Incoming messages are received via a persistent SSE
 * connection to http://127.0.0.1:<port>/api/v1/events, which signal-cli uses
 * to push envelopes as they arrive — zero polling latency. Outbound sends
 * use the HTTP JSON-RPC endpoint at /api/v1/rpc. Automatic reconnection
 * with exponential backoff handles daemon restarts.
 *
 * ── signal-cli daemon setup (run once per account, before CarsonOS) ──
 *
 *   # Register (first time only — follow the interactive prompts):
 *   signal-cli -a +12025551234 register
 *   signal-cli -a +12025551234 verify <code>
 *
 *   # Link as secondary device to an existing Signal account:
 *   signal-cli link -n "Diakonos"
 *
 *   # Start daemon on a chosen port:
 *   signal-cli -a +12025551234 daemon --http 7583 --no-receive-stdout
 *
 * ── Schema requirements ───────────────────────────────────────────────
 *
 * Add these columns to staff_agents (migration needed before wiring in):
 *
 *   signal_account      TEXT  -- E.164 phone number, e.g. "+12025551234"
 *   signal_daemon_port  INTEGER  -- daemon HTTP port, e.g. 7583
 *
 * ── JSON-RPC wire format ──────────────────────────────────────────────
 *
 * All calls POST to http://localhost:<port>/api/v1/rpc
 *
 *   receive:     { method: "receive" }
 *   send:        { method: "send", params: { recipient: ["+E164"], message: "…" } }
 *   sendTyping:  { method: "sendTyping", params: { recipient: "+E164", stop: false } }
 */

import { EventEmitter } from "node:events";
import http from "node:http";
import { eq, and, or } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import {
  staffAgents,
  staffAssignments,
  familyMembers,
} from "@carsonos/db";
import type { ConstitutionEngine } from "./constitution-engine.js";
import type { DelegationService } from "./delegation-service.js";
import { createSignalStream, markdownToSignalText, chunkSignalMessage } from "./signal-streaming.js";
import { stripThinkingBlocks } from "./telegram-format.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface SignalRelayConfig {
  db: Db;
  engine: ConstitutionEngine;
  orchestrator: DelegationService;
}

/** A staff agent row augmented with Signal-specific columns. */
interface SignalAgent {
  id: string;
  name: string;
  householdId: string;
  signalAccount: string;   // E.164 phone number
  signalDaemonPort: number; // signal-cli daemon HTTP port
}

interface ManagedAccount {
  agentId: string;
  agentName: string;
  signalAccount: string;
  daemonPort: number;
  running: boolean;
  /** Active SSE request — destroyed on intentional stop */
  sseRequest: http.ClientRequest | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  lastActivity: number;
  /** Timestamps of recently processed messages — dedup window */
  recentTimestamps: Set<number>;
  highestTimestamp: number;
}

interface DebounceBuffer {
  messages: string[];
  timer: ReturnType<typeof setTimeout>;
  senderNumber: string;
}

// ── Constants ─────────────────────────────────────────────────────────

const RECONNECT_BASE_MS = 1_000;       // Initial reconnect delay
const RECONNECT_MAX_MS = 30_000;       // Cap on reconnect backoff
const DEBOUNCE_MS = 1_500;             // Paste buffering window
const MAX_DEBOUNCE_PARTS = 12;
const MAX_DEBOUNCE_CHARS = 50_000;
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 4_000;
const DEDUP_MAX_SIZE = 2_000;
const DAEMON_TIMEOUT_MS = 10_000;      // HTTP call timeout to daemon

// ── JSON-RPC client ───────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id: string | number;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  result?: T;
  error?: { code: number; message: string; data?: unknown };
  id: string | number;
}

/** Signal envelope as returned by signal-cli receive. */
interface SignalEnvelope {
  account: string;
  envelope: {
    source: string;
    sourceNumber: string;
    sourceUuid?: string;
    sourceName?: string;
    sourceDevice: number;
    timestamp: number;
    dataMessage?: {
      timestamp: number;
      message: string | null;
      groupInfo: unknown | null;
      attachments?: unknown[];
    };
    typingMessage?: unknown;
    receiptMessage?: unknown;
    syncMessage?: unknown;
  };
}

let _rpcIdCounter = 1;

async function rpcCall<T = unknown>(
  port: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    method,
    params,
    id: _rpcIdCounter++,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DAEMON_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/v1/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`signal-cli daemon HTTP ${response.status}: ${await response.text()}`);
  }

  const json = (await response.json()) as JsonRpcResponse<T>;
  if (json.error) {
    throw new Error(`signal-cli RPC error ${json.error.code}: ${json.error.message}`);
  }

  return json.result as T;
}

/** Ping the daemon to verify it's reachable. */
async function isDaemonHealthy(port: number): Promise<boolean> {
  try {
    // "version" is a lightweight no-op probe (signal-cli 0.14.x)
    await rpcCall(port, "version");
    return true;
  } catch {
    return false;
  }
}

// ── Rate limiter (shared with Telegram layer) ─────────────────────────

class RateLimiter {
  private windows = new Map<string, { count: number; windowStart: number }>();

  check(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (!existing || now - existing.windowStart > windowMs) {
      this.windows.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (existing.count >= limit) return false;
    existing.count++;
    return true;
  }
}

// ── Signal Relay Manager ──────────────────────────────────────────────

export class SignalRelayManager {
  private db: Db;
  private engine: ConstitutionEngine;
  private orchestrator: DelegationService;

  private accounts = new Map<string, ManagedAccount>();
  private rateLimiter = new RateLimiter();
  private debounceBuffers = new Map<string, DebounceBuffer>();
  private agentQueues = new Map<string, Promise<void>>();
  private events = new EventEmitter();

  constructor(config: SignalRelayConfig) {
    this.db = config.db;
    this.engine = config.engine;
    this.orchestrator = config.orchestrator;

    this.events.on(
      "delegation.result",
      (data: {
        memberId: string | null;
        agentId: string;
        conversationId: string | null;
        response: string;
      }) => {
        this.deliverDelegationResult(data);
      },
    );
  }

  get eventBus(): EventEmitter {
    return this.events;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async startAll(): Promise<void> {
    const agents = await this.db
      .select()
      .from(staffAgents)
      .where(
        and(
          eq(staffAgents.visibility, "family"),
          eq(staffAgents.status, "active"),
        ),
      );

    const signalAgents = agents
      .map((a) => {
        if (!a.signalAccount || !a.signalDaemonPort) return null;
        return {
          id: a.id,
          name: a.name,
          householdId: a.householdId,
          signalAccount: a.signalAccount,
          signalDaemonPort: a.signalDaemonPort,
        } satisfies SignalAgent;
      })
      .filter((a): a is SignalAgent => a !== null);

    if (signalAgents.length === 0) {
      console.log("[signal-relay] No agents with Signal accounts configured");
      return;
    }

    console.log(`[signal-relay] Starting ${signalAgents.length} Signal account(s)...`);

    for (const agent of signalAgents) {
      await this.startAccount(agent.id);
    }
  }

  async stopAll(): Promise<void> {
    const stopPromises: Promise<void>[] = [];
    for (const [agentId, managed] of this.accounts) {
      if (managed.running) {
        stopPromises.push(
          this.stopAccount(agentId).catch((err) => {
            console.error(`[signal-relay] Error stopping ${managed.agentName}:`, err);
          }),
        );
      }
    }
    await Promise.all(stopPromises);
    this.accounts.clear();
    console.log("[signal-relay] All Signal accounts stopped");
  }

  async startAccount(agentId: string): Promise<void> {
    const existing = this.accounts.get(agentId);
    if (existing?.running) {
      console.log(`[signal-relay] Account for ${existing.agentName} already running`);
      return;
    }

    const agent = await this.db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, agentId))
      .then((rows) => rows[0]);

    if (!agent) {
      console.error(`[signal-relay] Agent ${agentId} not found`);
      return;
    }

    if (!agent.signalAccount || !agent.signalDaemonPort) {
      console.error(`[signal-relay] Agent ${agent.name} has no Signal account or daemon port configured`);
      return;
    }

    const signalAccount = agent.signalAccount;
    const daemonPort = agent.signalDaemonPort;

    // Verify daemon is reachable before starting the poll loop
    const healthy = await isDaemonHealthy(daemonPort);
    if (!healthy) {
      console.error(
        `[signal-relay] Daemon for ${agent.name} not reachable on port ${daemonPort}. ` +
        `Start it with: signal-cli -a ${signalAccount} daemon --http ${daemonPort} --no-receive-stdout`,
      );
      return;
    }

    const managed: ManagedAccount = {
      agentId,
      agentName: agent.name,
      signalAccount,
      daemonPort,
      running: false,
      sseRequest: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      lastActivity: Date.now(),
      recentTimestamps: new Set(),
      highestTimestamp: 0,
    };

    managed.running = true;
    this.accounts.set(agentId, managed);
    this.connectSSE(agentId);

    console.log(
      `[signal-relay] Started account for ${agent.name} (${signalAccount}) on daemon port ${daemonPort}`,
    );
  }

  async stopAccount(agentId: string): Promise<void> {
    const managed = this.accounts.get(agentId);
    if (!managed) return;

    // Mark stopped first so reconnect logic doesn't re-open after close
    managed.running = false;

    if (managed.reconnectTimer) {
      clearTimeout(managed.reconnectTimer);
      managed.reconnectTimer = null;
    }

    if (managed.sseRequest) {
      managed.sseRequest.destroy();
      managed.sseRequest = null;
    }

    this.accounts.delete(agentId);
    console.log(`[signal-relay] Stopped account for ${managed.agentName}`);
  }

  // ── SSE receive layer ────────────────────────────────────────────────

  /**
   * Open a persistent SSE connection to the signal-cli daemon at
   * GET /api/v1/events and process inbound envelopes as they arrive.
   *
   * signal-cli pushes each received envelope as an SSE event:
   *   data: {"account":"…","envelope":{…}}\n\n
   *
   * Reconnects on close or error with exponential backoff, capped at
   * RECONNECT_MAX_MS. Backoff resets to zero on each successful connection.
   */
  private connectSSE(agentId: string): void {
    const managed = this.accounts.get(agentId);
    if (!managed?.running) return;

    const url = `http://127.0.0.1:${managed.daemonPort}/api/v1/events`;

    const scheduleReconnect = (reason: string) => {
      managed.sseRequest = null;

      if (!managed.running) return; // intentional stop — do not reconnect

      const delay = Math.min(
        RECONNECT_BASE_MS * 2 ** managed.reconnectAttempts,
        RECONNECT_MAX_MS,
      );
      managed.reconnectAttempts++;

      console.warn(
        `[signal-relay:${managed.agentName}] SSE disconnected (${reason}). ` +
        `Reconnecting in ${delay / 1_000}s (attempt ${managed.reconnectAttempts})...`,
      );

      managed.reconnectTimer = setTimeout(() => {
        managed.reconnectTimer = null;
        this.connectSSE(agentId);
      }, delay);
    };

    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        console.error(
          `[signal-relay:${managed.agentName}] SSE endpoint returned HTTP ${res.statusCode}`,
        );
        res.resume(); // drain and discard
        scheduleReconnect(`HTTP ${res.statusCode}`);
        return;
      }

      managed.reconnectAttempts = 0;
      managed.lastActivity = Date.now();
      console.log(`[signal-relay:${managed.agentName}] SSE connected (${url})`);

      let buf = "";

      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        managed.lastActivity = Date.now();
        buf += chunk;

        // SSE frames are separated by double-newlines; process complete frames
        const frames = buf.split(/\n\n+/);
        buf = frames.pop() ?? ""; // last element may be incomplete

        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;

            const raw = line.slice(5).trim();
            if (!raw) continue;

            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              console.warn(`[signal-relay:${managed.agentName}] Non-JSON SSE data — skipping`);
              continue;
            }

            const envelope = (parsed as Record<string, unknown>).envelope as
              | SignalEnvelope["envelope"]
              | undefined;
            if (!envelope) continue;

            const dataMessage = envelope.dataMessage;
            if (!dataMessage?.message) continue;       // typing, receipts, etc.
            if (dataMessage.groupInfo) continue; // group messages — skip for now

            const timestamp = envelope.timestamp;
            // Modern Signal clients may withhold sourceNumber if the sender
            // has phone-number privacy enabled. In that case envelope.source
            // is the ACI UUID and sourceUuid is populated. We keep track of
            // both so identity lookup can match on either.
            const senderNumber = envelope.sourceNumber || undefined;
            const senderUuid = envelope.sourceUuid || (envelope.source && /^[0-9a-f-]{36}$/i.test(envelope.source) ? envelope.source : undefined);
            const senderIdentifier = senderNumber || senderUuid || envelope.source;
            if (!senderIdentifier) continue;

            // Deduplication by timestamp
            if (managed.recentTimestamps.has(timestamp)) continue;
            managed.recentTimestamps.add(timestamp);

            if (timestamp > managed.highestTimestamp) {
              managed.highestTimestamp = timestamp;
            }

            // Prune old dedup entries
            if (managed.recentTimestamps.size > DEDUP_MAX_SIZE) {
              const cutoff = managed.highestTimestamp - DEDUP_MAX_SIZE * 1_000;
              for (const ts of managed.recentTimestamps) {
                if (ts < cutoff) managed.recentTimestamps.delete(ts);
              }
            }

            // Route to the message pipeline — errors are caught so one bad
            // message never tears down the SSE connection
            this.handleIncomingMessage(agentId, senderIdentifier, senderNumber, senderUuid, dataMessage.message).catch((err) => {
              console.error(`[signal-relay:${managed.agentName}] handleIncomingMessage error:`, err);
            });
          }
        }
      });

      res.on("end", () => scheduleReconnect("stream ended"));
      res.on("error", (err) => scheduleReconnect(err.message));
    });

    req.on("error", (err) => scheduleReconnect(err.message));
    req.setTimeout(0); // no request-level timeout — connection is intentionally long-lived

    managed.sseRequest = req;
  }

  // ── Message handling ─────────────────────────────────────────────────

  private async handleIncomingMessage(
    agentId: string,
    senderIdentifier: string,
    senderNumber: string | undefined,
    senderUuid: string | undefined,
    text: string,
  ): Promise<void> {
    const managed = this.accounts.get(agentId);
    if (!managed) return;

    console.log(
      `[signal-relay:${managed.agentName}] Message from ${senderIdentifier}: ${text.slice(0, 50)}`,
    );

    if (text.length > MAX_MESSAGE_LENGTH) {
      await this.sendRaw(managed.daemonPort, senderIdentifier, "That message is too long. Try breaking it into shorter messages.");
      return;
    }

    // Identify family member by signal_number OR signal_uuid. Modern Signal
    // senders with phone-number privacy enabled deliver envelopes with only
    // the ACI UUID, so we try to match on either identifier.
    const identityClauses = [
      senderNumber ? eq(familyMembers.signalNumber, senderNumber) : undefined,
      senderUuid ? eq(familyMembers.signalUuid, senderUuid) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    if (identityClauses.length === 0) {
      await this.sendRaw(managed.daemonPort, senderIdentifier, "Could not identify your Signal account.");
      return;
    }

    const member = await this.db
      .select()
      .from(familyMembers)
      .where(identityClauses.length === 1 ? identityClauses[0] : or(...identityClauses))
      .then((rows) => rows[0]);

    if (!member) {
      await this.sendRaw(
        managed.daemonPort,
        senderIdentifier,
        "I don't recognize your Signal identity. Ask your family admin to add you in the CarsonOS dashboard.",
      );
      return;
    }

    // Opportunistically backfill the other identifier when we matched on one
    // and the envelope provided the other. Lets admins bootstrap with just
    // the UUID or just the phone and auto-fill the counterpart on first
    // successful message.
    const needsNumberFill = senderNumber && !member.signalNumber;
    const needsUuidFill = senderUuid && !member.signalUuid;
    if (needsNumberFill || needsUuidFill) {
      await this.db
        .update(familyMembers)
        .set({
          ...(needsNumberFill && { signalNumber: senderNumber }),
          ...(needsUuidFill && { signalUuid: senderUuid }),
        })
        .where(eq(familyMembers.id, member.id));
    }

    // Verify agent is assigned to this member
    const assignment = await this.db
      .select()
      .from(staffAssignments)
      .where(
        and(
          eq(staffAssignments.agentId, agentId),
          eq(staffAssignments.memberId, member.id),
        ),
      )
      .then((rows) => rows[0]);

    if (!assignment) {
      await this.sendRaw(managed.daemonPort, senderIdentifier, "I'm not your assigned agent. Contact your household admin.");
      return;
    }

    // Rate limit
    if (!this.rateLimiter.check(member.id, RATE_LIMIT, RATE_WINDOW_MS)) {
      await this.sendRaw(managed.daemonPort, senderIdentifier, "You're sending messages too fast. Please wait a moment.");
      return;
    }

    // Paste debouncing — buffer rapid successive messages before processing
    const bufferKey = `${agentId}:${member.id}`;
    const existingBuf = this.debounceBuffers.get(bufferKey);

    if (existingBuf) {
      clearTimeout(existingBuf.timer);
      const totalChars = existingBuf.messages.reduce((s, m) => s + m.length, 0) + text.length;

      if (
        existingBuf.messages.length < MAX_DEBOUNCE_PARTS &&
        totalChars < MAX_DEBOUNCE_CHARS
      ) {
        existingBuf.messages.push(text);
        existingBuf.timer = setTimeout(
          () => this.flushBuffer(bufferKey, agentId, senderIdentifier, member),
          DEBOUNCE_MS,
        );
      } else {
        // Buffer full — flush now, start fresh
        this.flushBuffer(bufferKey, agentId, senderIdentifier, member);
        this.debounceBuffers.set(bufferKey, {
          messages: [text],
          senderNumber: senderIdentifier,
          timer: setTimeout(
            () => this.flushBuffer(bufferKey, agentId, senderIdentifier, member),
            DEBOUNCE_MS,
          ),
        });
      }
    } else {
      this.debounceBuffers.set(bufferKey, {
        messages: [text],
        senderNumber: senderIdentifier,
        timer: setTimeout(
          () => this.flushBuffer(bufferKey, agentId, senderIdentifier, member),
          DEBOUNCE_MS,
        ),
      });
    }
  }

  private flushBuffer(
    bufferKey: string,
    agentId: string,
    senderNumber: string,
    member: typeof familyMembers.$inferSelect,
  ): void {
    const buffer = this.debounceBuffers.get(bufferKey);
    if (!buffer) return;

    this.debounceBuffers.delete(bufferKey);

    const combinedMessage = buffer.messages.join("\n");

    // Serialize per-agent so responses don't interleave for concurrent senders
    const previousWork = this.agentQueues.get(agentId) ?? Promise.resolve();
    const currentWork = previousWork.then(async () => {
      try {
        await this.processMessage(agentId, senderNumber, member, combinedMessage);
      } catch (err) {
        console.error(`[signal-relay] processMessage error:`, err);
        try {
          await this.sendRaw(
            this.accounts.get(agentId)!.daemonPort,
            senderNumber,
            "I'm having trouble right now. Try again in a minute.",
          );
        } catch { /* swallow */ }
      }
    });

    this.agentQueues.set(agentId, currentWork);
  }

  private async processMessage(
    agentId: string,
    senderNumber: string,
    member: typeof familyMembers.$inferSelect,
    message: string,
  ): Promise<void> {
    const managed = this.accounts.get(agentId);
    if (!managed) return;

    const { daemonPort } = managed;

    // Build the stream consumer: typing indicator + one-shot send on completion
    const stream = createSignalStream(
      // sendTyping
      () => rpcCall(daemonPort, "sendTyping", { recipient: senderNumber, stop: false }),
      // onComplete: deliver the final formatted text
      (text) => this.sendFormatted(daemonPort, senderNumber, text),
    );

    // Run message through the constitution engine with streaming
    let engineResult;
    try {
      engineResult = await this.engine.processMessage({
        agentId,
        memberId: member.id,
        householdId: member.householdId,
        message,
        channel: "signal",
        onTextDelta: stream.onDelta,
      });
    } catch (err) {
      await stream.finish();
      throw err;
    }

    // finish() stops the typing indicator and sends the accumulated text
    await stream.finish();

    if (engineResult.blocked) {
      await this.sendFormatted(daemonPort, senderNumber, engineResult.response);
      return;
    }

    // v0.4: delegation happens during the agent's turn via MCP tool calls
    // (delegate_task etc.), not as a post-processing XML-parse step. The
    // engine response is already streamed to the user above; nothing more
    // to do here.
  }

  // ── Sending ─────────────────────────────────────────────────────────

  /**
   * Send plain text directly via the daemon — no formatting applied.
   * Used for error messages and short system notices.
   */
  private async sendRaw(
    daemonPort: number,
    recipient: string,
    text: string,
  ): Promise<void> {
    await rpcCall(daemonPort, "send", {
      recipient: [recipient],
      message: text.slice(0, MAX_MESSAGE_LENGTH),
    });
  }

  /**
   * Format markdown as Signal-friendly plain text, chunk if needed,
   * and send each chunk in order.
   */
  private async sendFormatted(
    daemonPort: number,
    recipient: string,
    text: string,
  ): Promise<void> {
    const cleaned = stripThinkingBlocks(text);
    const formatted = markdownToSignalText(cleaned);
    const chunks = chunkSignalMessage(formatted);

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      try {
        await rpcCall(daemonPort, "send", {
          recipient: [recipient],
          message: chunk,
        });
      } catch (err) {
        console.error(`[signal-relay] sendFormatted failed:`, err);
        // Attempt plain truncated fallback
        try {
          await rpcCall(daemonPort, "send", {
            recipient: [recipient],
            message: cleaned.slice(0, MAX_MESSAGE_LENGTH),
          });
        } catch { /* give up */ }
        break;
      }
    }
  }

  // ── Proactive sending (used by scheduler) ───────────────────────────

  /**
   * Send a message to a Signal number via a specific agent's account.
   * Mirrors MultiRelayManager.sendMessage() for scheduler compatibility.
   */
  async sendMessage(
    agentId: string,
    signalNumber: string,
    text: string,
  ): Promise<void> {
    const managed = this.accounts.get(agentId);
    if (!managed?.running) {
      throw new Error(`Signal account for agent ${agentId} is not running`);
    }
    await this.sendFormatted(managed.daemonPort, signalNumber, text);
  }

  /**
   * Try every running account until one succeeds.
   * Fallback for when the primary account can't reach a user.
   * Returns true if any account succeeded.
   */
  async sendToAnyAccount(
    signalNumber: string,
    text: string,
    excludeAgentId?: string,
  ): Promise<boolean> {
    for (const [agentId, managed] of this.accounts) {
      if (agentId === excludeAgentId || !managed.running) continue;
      try {
        await this.sendFormatted(managed.daemonPort, signalNumber, text);
        console.log(`[signal-relay] Fallback delivery via ${managed.agentName} succeeded`);
        return true;
      } catch { /* try next */ }
    }
    return false;
  }

  /**
   * Check if any running account can reach a Signal number.
   * Uses a lightweight send-typing probe; cached for 5 minutes.
   */
  private reachabilityCache = new Map<string, { reachable: boolean; expiresAt: number }>();

  async canReachUser(signalNumber: string): Promise<boolean> {
    const cached = this.reachabilityCache.get(signalNumber);
    if (cached && Date.now() < cached.expiresAt) return cached.reachable;

    for (const [, managed] of this.accounts) {
      if (!managed.running) continue;
      try {
        // sendTyping stop=true is a no-op send that still validates reachability
        await rpcCall(managed.daemonPort, "sendTyping", {
          recipient: signalNumber,
          stop: true,
        });
        this.reachabilityCache.set(signalNumber, {
          reachable: true,
          expiresAt: Date.now() + 5 * 60_000,
        });
        return true;
      } catch { /* try next */ }
    }

    this.reachabilityCache.set(signalNumber, {
      reachable: false,
      expiresAt: Date.now() + 5 * 60_000,
    });
    return false;
  }

  // ── Delegation result delivery ────────────────────────────────────

  private async deliverDelegationResult(data: {
    memberId: string | null;
    agentId: string;
    conversationId: string | null;
    response: string;
  }): Promise<void> {
    if (!data.memberId || !data.response) return;

    const managed = this.accounts.get(data.agentId);
    if (!managed?.running) {
      console.warn(`[signal-relay] Cannot deliver delegation result: account for ${data.agentId} not running`);
      return;
    }

    const member = await this.db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, data.memberId))
      .then((rows) => rows[0]);

    const signalNumber = member?.signalNumber;
    if (!signalNumber) {
      console.warn(`[signal-relay] Cannot deliver: member ${data.memberId} has no Signal number`);
      return;
    }

    try {
      await this.sendFormatted(managed.daemonPort, signalNumber, data.response);
      console.log(`[signal-relay:${managed.agentName}] Delivered delegation result to ${member?.name}`);
    } catch (err) {
      console.error(`[signal-relay:${managed.agentName}] Failed to deliver delegation result:`, err);
    }
  }

}
