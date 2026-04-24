/**
 * Two-phase exactly-once notifier for v0.4 delegation.
 *
 * Hard problem: a task completes → we set notified_at → we try to Telegram-send
 * → crash → on reboot the task looks delivered but nothing went out. Solution
 * is to decouple "prepare" from "deliver" and gate the flip on a conditional
 * UPDATE so only one winner flips the invariant.
 *
 * Phase 1 — prepare(taskId, {terminalStatus, payload}). One UPDATE sets both
 * status and notify_payload. notified_at stays NULL.
 *
 * Phase 2 — deliver(taskId). Reads the prepared payload, calls the injected
 * TelegramSendFn, on success runs UPDATE tasks SET notified_at=? WHERE id=?
 * AND notified_at IS NULL (atomic conditional). Also writes a
 * delegation_notifications row keyed on (task_id, kind) for server-side
 * dedup so a retry-after-silent-success is a no-op instead of a duplicate
 * Telegram message.
 *
 * Reconciler (Dispatcher.recoverStuckTasks extended) calls findPendingDelivery()
 * at boot and re-drives deliver() with a 100ms stagger to avoid Telegram
 * rate-limit bursts.
 *
 * Invariant: the user gets at least one completion message, and never more
 * than one distinguishable one.
 */

import { and, desc, eq, isNull, isNotNull, ne } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { tasks, delegationNotifications, conversations, messages } from "@carsonos/db";

import type { SummaryCard } from "./summary-card.js";

export type NotificationKind =
  | "completion"
  | "failure"
  | "cancellation"
  | "approval_request"
  | "hire_proposal";

export interface NotifyPayload {
  kind: NotificationKind;
  /** Pre-rendered Telegram message body (HTML-safe). */
  text: string;
  /** Inline buttons for approval cards. Shape intentionally unknown at this
   * layer — Lane F (Telegram callbacks) defines the exact type. */
  replyMarkup?: unknown;
  /** Routing: which household / member / agent's bot sends this. */
  householdId: string;
  memberId: string;
  agentId: string;
  /** Structured card retained for audit. Absent for approval_request / hire_proposal. */
  summaryCard?: SummaryCard;
}

export type TelegramSendResult =
  | { ok: true; messageId?: string }
  | { ok: false; error: string };

export type TelegramSendFn = (args: {
  agentId: string;
  memberId: string;
  text: string;
  replyMarkup?: unknown;
}) => Promise<TelegramSendResult>;

export interface DeliverResult {
  delivered: boolean;
  /** true when (task,kind) was already successfully sent on a prior attempt. */
  alreadyDelivered?: boolean;
  /** Telegram message id, when known. */
  messageId?: string;
  /** Populated when delivered=false. */
  error?: string;
}

export class DelegationNotifier {
  constructor(
    private readonly db: Db,
    private readonly send: TelegramSendFn,
  ) {}

  /**
   * Phase 1: atomically set the task's terminal status and persist the
   * composed notification payload. Calling prepare() is the signal that a
   * task has reached terminal state and is eligible for delivery.
   *
   * Idempotent: re-preparing a task that's already terminal overwrites the
   * payload (e.g., a reconciler may re-prepare a failure message with
   * updated reason text). Does not reset notified_at.
   *
   * Cancel-sticky: a task that's already `cancelled` stays cancelled. This
   * catches the slow-worker race where the SDK query finishes seconds or
   * minutes after cancel_task fired, and used to flip `cancelled` back to
   * `completed` (with a stale/empty result). The guard is a WHERE predicate so
   * we can tell the caller whether the update actually landed.
   */
  async prepare(
    taskId: string,
    params: {
      terminalStatus: "completed" | "failed" | "cancelled";
      payload: NotifyPayload;
    },
  ): Promise<{ updated: boolean }> {
    const now = new Date();
    // A reconciler re-preparing an explicit cancellation is allowed (lets the
    // cancel path still attach a payload). Any other terminal status is
    // refused if the task is already cancelled.
    const allowOverwriteCancelled = params.terminalStatus === "cancelled";
    const whereClause = allowOverwriteCancelled
      ? eq(tasks.id, taskId)
      : and(eq(tasks.id, taskId), ne(tasks.status, "cancelled"));

    const result = await this.db
      .update(tasks)
      .set({
        status: params.terminalStatus,
        notifyPayload: params.payload,
        completedAt: now,
        updatedAt: now,
      })
      .where(whereClause)
      .returning({ id: tasks.id });

    return { updated: result.length > 0 };
  }

  /**
   * Phase 2: deliver the prepared payload.
   *
   * Order of operations:
   *   1. Load task. If notified_at already set, return alreadyDelivered.
   *   2. Check delegation_notifications for a prior successful send on
   *      (task_id, kind). If present, flip notified_at without re-sending —
   *      this handles the "Telegram accepted but we crashed before the flip"
   *      case.
   *   3. Call send(). On failure, return early — reconciler retries.
   *   4. Upsert delegation_notifications with sent_at + delivered_message_id.
   *   5. Atomic flip: UPDATE tasks SET notified_at=? WHERE id=? AND
   *      notified_at IS NULL. If zero rows changed, someone else won the race;
   *      treat as already delivered.
   */
  async deliver(taskId: string): Promise<DeliverResult> {
    const [task] = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));

    if (!task) return { delivered: false, error: "task not found" };
    if (task.notifiedAt) return { delivered: true, alreadyDelivered: true };
    if (!task.notifyPayload) return { delivered: false, error: "no notify_payload prepared" };

    const payload = task.notifyPayload as NotifyPayload;

    const [existing] = await this.db
      .select()
      .from(delegationNotifications)
      .where(
        and(
          eq(delegationNotifications.taskId, taskId),
          eq(delegationNotifications.kind, payload.kind),
        ),
      )
      .limit(1);

    if (existing?.sentAt) {
      await this.flip(taskId);
      return {
        delivered: true,
        alreadyDelivered: true,
        messageId: existing.deliveredMessageId ?? undefined,
      };
    }

    let result: TelegramSendResult;
    try {
      result = await this.send({
        agentId: payload.agentId,
        memberId: payload.memberId,
        text: payload.text,
        replyMarkup: payload.replyMarkup,
      });
    } catch (err) {
      return {
        delivered: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (!result.ok) {
      return { delivered: false, error: result.error };
    }

    const sentAt = new Date();
    if (existing) {
      await this.db
        .update(delegationNotifications)
        .set({ sentAt, deliveredMessageId: result.messageId ?? null })
        .where(eq(delegationNotifications.id, existing.id));
    } else {
      await this.db.insert(delegationNotifications).values({
        taskId,
        kind: payload.kind,
        payload,
        sentAt,
        deliveredMessageId: result.messageId ?? null,
      });
    }

    await this.flip(taskId);

    // Thread the delivered notification into the sending agent's conversation
    // with the recipient member as an assistant message. This is what closes
    // the loop between "Dev finished and the notifier sent the result to
    // Josh" and "Carson has a record of what was said on his behalf." Without
    // this, Carson has no context on his next turn and has to re-fetch the
    // task result or re-do the work. Best-effort: failures here don't fail
    // the notification (it's already delivered).
    await this.threadIntoConversation(payload).catch((err) =>
      console.warn(`[notifier] threadIntoConversation(${taskId}) failed:`, err),
    );

    return { delivered: true, messageId: result.messageId };
  }

  /**
   * Persist the delivered text as an assistant-role message in the
   * (agentId, memberId) conversation so the sending agent's history reflects
   * what got sent on their behalf. No-op if no conversation exists yet.
   */
  private async threadIntoConversation(payload: NotifyPayload): Promise<void> {
    const [conversation] = await this.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.agentId, payload.agentId),
          eq(conversations.memberId, payload.memberId),
        ),
      )
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1);

    if (!conversation) return;

    const now = new Date();
    await this.db.insert(messages).values({
      conversationId: conversation.id,
      role: "assistant",
      content: payload.text,
      metadata: { source: "notifier", kind: payload.kind },
    });
    await this.db
      .update(conversations)
      .set({ lastMessageAt: now.toISOString() })
      .where(eq(conversations.id, conversation.id));
  }

  /**
   * Find all tasks with a prepared payload but no successful delivery.
   * Dispatcher calls this at boot and paces retries with a 100ms stagger.
   */
  async findPendingDelivery(): Promise<
    { taskId: string; kind: NotificationKind }[]
  > {
    const rows = await this.db
      .select({ id: tasks.id, payload: tasks.notifyPayload })
      .from(tasks)
      .where(and(isNotNull(tasks.notifyPayload), isNull(tasks.notifiedAt)));
    return rows
      .filter((r) => r.payload != null)
      .map((r) => ({
        taskId: r.id,
        kind: (r.payload as NotifyPayload).kind,
      }));
  }

  /**
   * Atomic conditional flip. `WHERE notified_at IS NULL` is the exactly-once
   * gate: if two reconcilers race, only one UPDATE actually modifies a row.
   */
  private async flip(taskId: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(tasks)
      .set({ notifiedAt: now, updatedAt: now })
      .where(and(eq(tasks.id, taskId), isNull(tasks.notifiedAt)));
  }

  /**
   * Publicly mark a task as delivered without going through `send()`. Used by
   * the v0.4 back-channel wake path: the delegator's agent already spoke to
   * the user in-voice, so the templated notifier card must NOT be replayed
   * on restart (prepare left notifyPayload set, notifiedAt null — same shape
   * the reconciler looks for). Calling this closes that loop.
   *
   * Same atomic `WHERE notified_at IS NULL` guard as `flip`.
   */
  async markDeliveredByWake(taskId: string): Promise<void> {
    return this.flip(taskId);
  }
}
