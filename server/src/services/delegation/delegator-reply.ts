/**
 * DelegatorReply — make sure the delegator gets the last word, every time.
 *
 * When a delegated run reaches terminal state, the delegator (the agent who
 * delegated the work) replies to the user in their own voice. The wake path
 * runs a turn in the delegator's session so the response is in-character;
 * the templated notifier card is the safety net for cases where wake
 * legitimately can't run (member deleted, data invariant violated, retry
 * budget exhausted).
 *
 * Policy:
 *   - Wake first.
 *   - Retry transient wake failures with backoff (boot ordering, engine
 *     refusing the turn, model blips, network errors). Default budget:
 *     three retries at 5s / 15s / 30s.
 *   - Skip retries for terminal reasons (task gone, member without
 *     telegram_user_id, etc.) — they won't fix themselves.
 *   - Templated fallback fires only after the budget is spent, or
 *     immediately on a terminal reason. Logs a structured warning so the
 *     fallback path is observable.
 *
 * This module owns ONE invariant: delegators always speak about their
 * specialists' work in their own voice unless that's truly impossible.
 * See docs/adr/0001 for the surrounding self-modifying-runtime context
 * and CONTEXT.md for the vocabulary.
 */

import type { DelegationNotifier } from "./notifier.js";

export type WakeResult = { delivered: boolean; reason?: string };
export type WakeFn = (taskId: string) => Promise<WakeResult>;

export interface Clock {
  sleep(ms: number): Promise<void>;
}

export interface DelegatorReplyDeps {
  notifier: DelegationNotifier;
  wake: WakeFn;
  /** Override for tests (default: real setTimeout-backed sleep). */
  clock?: Clock;
  /** Override for tests (default: [5_000, 15_000, 30_000]). */
  retryDelaysMs?: number[];
  /** Override for tests (default: console.warn). */
  log?: (msg: string) => void;
}

const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

const realClock: Clock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Reasons that won't fix themselves. Anchored exact-match (or `task status is X`
 * prefix-match) against the known set returned by delegation-service.wakeDelegator.
 *
 * Anything not listed is treated as transient and retried. That intentionally
 * includes unknown thrown-error messages: better to retry spuriously than to
 * drop into templated when a transient blip would have cleared on the next
 * attempt. Exact-match avoids a substring-match trust-boundary hole where an
 * `err.message` containing one of the terminal phrases could misclassify.
 */
const TERMINAL_WAKE_REASONS = new Set([
  "task not found",
  "missing notify_agent_id or requested_by",
  "delegator, member, or specialist not found",
  "member has no telegram_user_id",
]);

function isTerminalReason(reason: string | undefined): boolean {
  if (!reason) return false;
  if (TERMINAL_WAKE_REASONS.has(reason)) return true;
  // `task status is <status>` is the only family-shaped reason — anchor the
  // prefix and require a non-terminal status follows. Wake is only invoked
  // for terminal-state tasks, so any "task status is …" reason here is a
  // race/data-invariant — don't retry, fall through to templated.
  if (reason.startsWith("task status is ")) return true;
  return false;
}

const MARK_DELIVERED_RETRY_COUNT = 3;
const MARK_DELIVERED_RETRY_DELAY_MS = 100;

export class DelegatorReply {
  private readonly notifier: DelegationNotifier;
  private readonly wake: WakeFn;
  private readonly clock: Clock;
  private readonly retryDelaysMs: number[];
  private readonly log: (msg: string) => void;

  constructor(deps: DelegatorReplyDeps) {
    this.notifier = deps.notifier;
    this.wake = deps.wake;
    this.clock = deps.clock ?? realClock;
    this.retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.log = deps.log ?? ((msg) => console.warn(msg));
  }

  /**
   * Deliver the delegator's reply for a task that has reached terminal state.
   * Safe to call from both the live terminal-state path and boot-time replay
   * — both flow through the same retry-and-fallback policy so a host-restart
   * recovery gets the same in-voice treatment as a live completion.
   */
  async handleTerminal(taskId: string): Promise<void> {
    let lastReason: string | undefined;

    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      // Wrap wake in try/catch — wakeDelegator catches its own errors today,
      // but a future custom WakeFn (or a contract change) could throw, and
      // an unhandled rejection here would skip the templated fallback and
      // leave the user with no reply at all.
      let result: WakeResult;
      try {
        result = await this.wake(taskId);
      } catch (err) {
        result = {
          delivered: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      if (result.delivered) {
        await this.markDeliveredByWakeWithRetry(taskId);
        return;
      }
      lastReason = result.reason;

      if (isTerminalReason(lastReason)) break;
      if (attempt >= this.retryDelaysMs.length) break;

      await this.clock.sleep(this.retryDelaysMs[attempt]);
    }

    this.log(
      `[delegator-reply] wake(${taskId}) did not deliver (last reason: ${lastReason ?? "unknown"}); falling back to templated notifier`,
    );
    await this.notifier.deliver(taskId);
  }

  /**
   * Retry the atomic `notified_at` flip on transient DB hiccups. If the flip
   * is dropped, replay on the next boot will re-fire wake → user sees the
   * in-voice reply twice. A small retry budget here significantly narrows
   * that race window without blocking the dispatcher.
   */
  private async markDeliveredByWakeWithRetry(taskId: string): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MARK_DELIVERED_RETRY_COUNT; attempt++) {
      try {
        await this.notifier.markDeliveredByWake(taskId);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < MARK_DELIVERED_RETRY_COUNT - 1) {
          await this.clock.sleep(MARK_DELIVERED_RETRY_DELAY_MS);
        }
      }
    }
    this.log(
      `[delegator-reply] markDeliveredByWake(${taskId}) failed after ${MARK_DELIVERED_RETRY_COUNT} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)} — boot replay may re-fire wake`,
    );
  }
}
