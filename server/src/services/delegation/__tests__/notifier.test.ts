/**
 * DB-integration tests for the two-phase exactly-once notifier.
 *
 * Uses an in-memory SQLite (better-sqlite3) via createDb(":memory:"), which
 * runs the full v11 fresh-install SQL so every table + v0.4 column exists.
 * No mocks for drizzle; the SQL paths exercised here are the ones running
 * in production.
 *
 * Covers the eng-review critical test gap: "Telegram accept-but-drop" +
 * "deliver fails mid-flight" + "double-delivery race on flip" — the places
 * where exactly-once semantics are hardest to get right.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "@carsonos/db";
import {
  households,
  staffAgents,
  familyMembers,
  tasks,
  delegationNotifications,
} from "@carsonos/db";

import {
  DelegationNotifier,
  type NotifyPayload,
  type TelegramSendFn,
  type TelegramSendResult,
} from "../notifier.js";

// ── Helpers ────────────────────────────────────────────────────────

function freshDb(): Db {
  return createDb(":memory:");
}

async function seed(db: Db): Promise<{
  householdId: string;
  memberId: string;
  agentId: string;
  taskId: string;
}> {
  const [household] = await db
    .insert(households)
    .values({ name: "test household" })
    .returning();

  const [member] = await db
    .insert(familyMembers)
    .values({
      householdId: household.id,
      name: "Josh",
      role: "parent",
      age: 40,
      telegramUserId: "12345",
    })
    .returning();

  const [agent] = await db
    .insert(staffAgents)
    .values({
      householdId: household.id,
      name: "Carson",
      staffRole: "head_butler",
      isHeadButler: true,
    })
    .returning();

  const [task] = await db
    .insert(tasks)
    .values({
      householdId: household.id,
      agentId: agent.id,
      title: "Run a delegation",
      requestedBy: member.id,
      requiresApproval: false,
      delegationDepth: 1,
    })
    .returning();

  return { householdId: household.id, memberId: member.id, agentId: agent.id, taskId: task.id };
}

function makePayload(agentId: string, memberId: string, householdId: string): NotifyPayload {
  return {
    kind: "completion",
    text: "Bob finished the Todoist tool",
    householdId,
    memberId,
    agentId,
  };
}

// Record-calls-and-reply send fn. `replies` consumed in order; after the
// queue is empty, subsequent calls throw (tests should assert the queue
// drains cleanly).
function makeSpySend(replies: TelegramSendResult[]): TelegramSendFn & {
  calls: Array<{ agentId: string; memberId: string; text: string }>;
} {
  const calls: Array<{ agentId: string; memberId: string; text: string }> = [];
  const queue = [...replies];
  const fn = (async (args) => {
    calls.push({ agentId: args.agentId, memberId: args.memberId, text: args.text });
    const reply = queue.shift();
    if (!reply) throw new Error("spy send: queue exhausted");
    return reply;
  }) as TelegramSendFn & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("DelegationNotifier", () => {
  let db: Db;
  let seeded: Awaited<ReturnType<typeof seed>>;

  beforeEach(async () => {
    db = freshDb();
    seeded = await seed(db);
  });

  it("prepare sets terminal status + notify_payload; notified_at stays null", async () => {
    const notifier = new DelegationNotifier(db, async () => ({ ok: true }));
    const payload = makePayload(seeded.agentId, seeded.memberId, seeded.householdId);

    await notifier.prepare(seeded.taskId, { terminalStatus: "completed", payload });

    const [row] = await db.select().from(tasks).where(eq(tasks.id, seeded.taskId));
    expect(row.status).toBe("completed");
    expect(row.notifyPayload).toMatchObject({ kind: "completion", text: "Bob finished the Todoist tool" });
    expect(row.notifiedAt).toBeNull();
    expect(row.completedAt).toBeInstanceOf(Date);
  });

  it("prepare(completed) is refused when the task is already cancelled (cancel-sticky)", async () => {
    // v0.4 E2E testing caught this: the user cancels, the slow Agent SDK worker
    // finishes a few minutes later, and the final `completed` write flips the
    // task back out of `cancelled` with no real result. prepare() must refuse
    // any non-cancelled terminal status when the row is already cancelled.
    await db
      .update(tasks)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(tasks.id, seeded.taskId));

    const notifier = new DelegationNotifier(db, async () => ({ ok: true }));
    const payload = makePayload(seeded.agentId, seeded.memberId, seeded.householdId);

    const outcome = await notifier.prepare(seeded.taskId, {
      terminalStatus: "completed",
      payload,
    });

    expect(outcome.updated).toBe(false);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, seeded.taskId));
    expect(row.status).toBe("cancelled");
    expect(row.notifyPayload).toBeNull();
  });

  it("prepare(cancelled) is still allowed on an already-cancelled task (reconciler path)", async () => {
    // Tooling like the expired-approval sweep + the cancel hook itself may
    // re-prepare a cancellation payload. That specific overwrite stays allowed
    // so the UI can render the cancellation summary.
    await db
      .update(tasks)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(tasks.id, seeded.taskId));

    const notifier = new DelegationNotifier(db, async () => ({ ok: true }));
    const payload: NotifyPayload = {
      kind: "cancellation",
      text: "Bob's task cancelled by user",
      householdId: seeded.householdId,
      memberId: seeded.memberId,
      agentId: seeded.agentId,
    };

    const outcome = await notifier.prepare(seeded.taskId, {
      terminalStatus: "cancelled",
      payload,
    });

    expect(outcome.updated).toBe(true);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, seeded.taskId));
    expect(row.notifyPayload).toMatchObject({ kind: "cancellation" });
  });

  it("deliver: fresh task → send + write audit row + flip notified_at atomically", async () => {
    const send = makeSpySend([{ ok: true, messageId: "tg-100" }]);
    const notifier = new DelegationNotifier(db, send);
    const payload = makePayload(seeded.agentId, seeded.memberId, seeded.householdId);
    await notifier.prepare(seeded.taskId, { terminalStatus: "completed", payload });

    const result = await notifier.deliver(seeded.taskId);

    expect(result).toEqual({ delivered: true, messageId: "tg-100" });
    expect(send.calls).toHaveLength(1);
    expect(send.calls[0].text).toBe("Bob finished the Todoist tool");

    const [row] = await db.select().from(tasks).where(eq(tasks.id, seeded.taskId));
    expect(row.notifiedAt).toBeInstanceOf(Date);

    const [audit] = await db
      .select()
      .from(delegationNotifications)
      .where(eq(delegationNotifications.taskId, seeded.taskId));
    expect(audit.kind).toBe("completion");
    expect(audit.sentAt).toBeInstanceOf(Date);
    expect(audit.deliveredMessageId).toBe("tg-100");
  });

  it("deliver: already-delivered task → alreadyDelivered, no re-send", async () => {
    const send = makeSpySend([{ ok: true, messageId: "tg-200" }]);
    const notifier = new DelegationNotifier(db, send);
    const payload = makePayload(seeded.agentId, seeded.memberId, seeded.householdId);
    await notifier.prepare(seeded.taskId, { terminalStatus: "completed", payload });
    await notifier.deliver(seeded.taskId);
    // second delivery must be a no-op
    const result = await notifier.deliver(seeded.taskId);

    expect(result.delivered).toBe(true);
    expect(result.alreadyDelivered).toBe(true);
    expect(send.calls).toHaveLength(1); // send only called once
  });

  it("crash-between-send-and-flip: audit row has sentAt, but notified_at is null — retry must not re-send", async () => {
    const send = makeSpySend([{ ok: true, messageId: "tg-300" }]);
    const notifier = new DelegationNotifier(db, send);
    const payload = makePayload(seeded.agentId, seeded.memberId, seeded.householdId);

    // Simulate the crash scenario: prepare ran, THEN Telegram accepted the send
    // (we wrote the audit row with sentAt), THEN we crashed before flipping
    // notified_at. On reboot, the reconciler calls deliver() again.
    await notifier.prepare(seeded.taskId, { terminalStatus: "completed", payload });
    await db.insert(delegationNotifications).values({
      taskId: seeded.taskId,
      kind: "completion",
      payload,
      sentAt: new Date(),
      deliveredMessageId: "tg-300",
    });

    const result = await notifier.deliver(seeded.taskId);

    expect(result.delivered).toBe(true);
    expect(result.alreadyDelivered).toBe(true);
    expect(result.messageId).toBe("tg-300");
    expect(send.calls).toHaveLength(0); // zero sends — reused prior success

    const [row] = await db.select().from(tasks).where(eq(tasks.id, seeded.taskId));
    expect(row.notifiedAt).toBeInstanceOf(Date); // flip now runs
  });

  it("deliver: send returns ok:false → not delivered, no flip, no audit write", async () => {
    const send = makeSpySend([{ ok: false, error: "telegram 503" }]);
    const notifier = new DelegationNotifier(db, send);
    const payload = makePayload(seeded.agentId, seeded.memberId, seeded.householdId);
    await notifier.prepare(seeded.taskId, { terminalStatus: "completed", payload });

    const result = await notifier.deliver(seeded.taskId);

    expect(result).toEqual({ delivered: false, error: "telegram 503" });

    const [row] = await db.select().from(tasks).where(eq(tasks.id, seeded.taskId));
    expect(row.notifiedAt).toBeNull(); // flip did NOT run

    const audit = await db
      .select()
      .from(delegationNotifications)
      .where(eq(delegationNotifications.taskId, seeded.taskId));
    expect(audit).toHaveLength(0); // no audit row yet — reconciler will retry
  });

  it("deliver: send throws → caught, returned as error, no side effects", async () => {
    const notifier = new DelegationNotifier(db, async () => {
      throw new Error("network down");
    });
    const payload = makePayload(seeded.agentId, seeded.memberId, seeded.householdId);
    await notifier.prepare(seeded.taskId, { terminalStatus: "completed", payload });

    const result = await notifier.deliver(seeded.taskId);

    expect(result.delivered).toBe(false);
    expect(result.error).toBe("network down");

    const [row] = await db.select().from(tasks).where(eq(tasks.id, seeded.taskId));
    expect(row.notifiedAt).toBeNull();
  });

  it("deliver: no payload prepared → returns error, no send attempted", async () => {
    const send = makeSpySend([]); // empty queue — would throw if called
    const notifier = new DelegationNotifier(db, send);

    const result = await notifier.deliver(seeded.taskId);

    expect(result.delivered).toBe(false);
    expect(result.error).toContain("no notify_payload prepared");
    expect(send.calls).toHaveLength(0);
  });

  it("findPendingDelivery returns only tasks with prepared-but-undelivered notifications", async () => {
    // Task 1: prepared + delivered
    const payload1 = makePayload(seeded.agentId, seeded.memberId, seeded.householdId);
    const notifier = new DelegationNotifier(db, makeSpySend([{ ok: true, messageId: "a" }]));
    await notifier.prepare(seeded.taskId, { terminalStatus: "completed", payload: payload1 });
    await notifier.deliver(seeded.taskId);

    // Task 2: prepared, not yet delivered
    const [task2] = await db
      .insert(tasks)
      .values({
        householdId: seeded.householdId,
        agentId: seeded.agentId,
        title: "Second task",
        requiresApproval: false,
      })
      .returning();
    const notifier2 = new DelegationNotifier(db, async () => ({ ok: false, error: "queued" }));
    const payload2 = makePayload(seeded.agentId, seeded.memberId, seeded.householdId);
    payload2.kind = "failure";
    await notifier2.prepare(task2.id, { terminalStatus: "failed", payload: payload2 });
    // Intentionally DO NOT call deliver — this is the crash-before-deliver case

    // Task 3: terminal but no payload (shouldn't show up)
    await db
      .insert(tasks)
      .values({
        householdId: seeded.householdId,
        agentId: seeded.agentId,
        title: "Third task",
        requiresApproval: false,
        status: "completed",
      });

    const pending = await notifier.findPendingDelivery();

    expect(pending).toHaveLength(1);
    expect(pending[0].taskId).toBe(task2.id);
    expect(pending[0].kind).toBe("failure");
  });

  it("flip is atomic under race: concurrent deliver() calls produce exactly one audit row", async () => {
    // Both deliver calls see a fresh task with no prior audit + payload prepared.
    // Each tries to send + write the audit row + flip. The unique index on
    // (task_id, kind) serializes the audit insert so the second one fails.
    // The flip uses WHERE notified_at IS NULL as its exactly-once gate.
    const send1 = makeSpySend([{ ok: true, messageId: "race-1" }]);
    const send2 = makeSpySend([{ ok: true, messageId: "race-2" }]);
    const notifier1 = new DelegationNotifier(db, send1);
    const notifier2 = new DelegationNotifier(db, send2);
    const payload = makePayload(seeded.agentId, seeded.memberId, seeded.householdId);
    await notifier1.prepare(seeded.taskId, { terminalStatus: "completed", payload });

    const [r1, r2] = await Promise.allSettled([
      notifier1.deliver(seeded.taskId),
      notifier2.deliver(seeded.taskId),
    ]);

    // One delivered, one either delivered-already or rejected by the
    // delegation_notifications unique index.
    const results = [r1, r2];
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const delivered = fulfilled
      .map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof notifier1.deliver>>>).value)
      .filter((v) => v.delivered);
    expect(delivered.length).toBeGreaterThanOrEqual(1);

    // Exactly one audit row exists for (task, kind).
    const audit = await db
      .select()
      .from(delegationNotifications)
      .where(eq(delegationNotifications.taskId, seeded.taskId));
    expect(audit).toHaveLength(1);

    // notified_at set exactly once.
    const [row] = await db.select().from(tasks).where(eq(tasks.id, seeded.taskId));
    expect(row.notifiedAt).toBeInstanceOf(Date);
  });
});
