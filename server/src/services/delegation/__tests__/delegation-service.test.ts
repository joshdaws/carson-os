/**
 * DB-integration tests for DelegationService's race-safety + validation paths.
 *
 * Uses stubs for Adapter/Dispatcher/TaskEngine/CarsonOversight — the goal is to
 * verify the DB invariants (edge checks, depth-2 enforcement, atomic approve/
 * reject race) without spinning up the full adapter pipeline.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "@carsonos/db";
import {
  households,
  staffAgents,
  familyMembers,
  tasks,
  delegationEdges,
} from "@carsonos/db";
import { DelegationService } from "../../delegation-service.js";
import { TaskEngine } from "../../task-engine.js";
import type { Dispatcher } from "../../dispatcher.js";
import type { CarsonOversight } from "../../carson-oversight.js";

// ── Stubs ────────────────────────────────────────────────────────

function stubAdapter() {
  return {
    name: "stub",
    execute: vi.fn().mockResolvedValue({ content: "stub" }),
    healthCheck: vi.fn().mockResolvedValue(true),
  };
}

function stubDispatcher() {
  return {
    handleTaskAssignment: vi.fn().mockResolvedValue(undefined),
  } as unknown as Dispatcher;
}

function stubOversight() {
  return {
    reviewHireProposal: vi.fn().mockResolvedValue({
      approved: false,
      reason: "Hire proposals always require principal approval",
    }),
  } as unknown as CarsonOversight;
}

// ── Seed helpers ─────────────────────────────────────────────────

async function seedBasics(db: Db) {
  const [household] = await db
    .insert(households)
    .values({ name: "test" })
    .returning();

  const [principal] = await db
    .insert(familyMembers)
    .values({ householdId: household.id, name: "Josh", role: "parent", age: 40, telegramUserId: "1" })
    .returning();

  const [cos] = await db
    .insert(staffAgents)
    .values({
      householdId: household.id,
      name: "Carson",
      staffRole: "head_butler",
      isHeadButler: true,
    })
    .returning();

  const [bob] = await db
    .insert(staffAgents)
    .values({
      householdId: household.id,
      name: "Bob",
      staffRole: "custom",
      specialty: "tools",
      visibility: "internal",
      model: "claude-opus-4-7",
      trustLevel: "full",
      autonomyLevel: "autonomous",
    })
    .returning();

  return { householdId: household.id, principalId: principal.id, cosId: cos.id, bobId: bob.id };
}

function makeService(db: Db) {
  const adapter = stubAdapter();
  const dispatcher = stubDispatcher();
  const oversight = stubOversight();
  // Capture broadcasts so cancellation/double-cancel tests can assert
  // single-fire semantics without needing the full event bus.
  const broadcasts: Array<{ type: string; data?: unknown }> = [];
  const capture = (e: { type: string; data?: unknown }) => {
    broadcasts.push(e);
  };
  const taskEngine = new TaskEngine({
    db,
    adapter: adapter as never,
    constitutionEngine: undefined as never,
    broadcast: capture,
  });
  const svc = new DelegationService(
    { db, adapter: adapter as never, broadcast: capture },
    dispatcher,
    taskEngine,
  );
  svc.setOversight(oversight);
  return { svc, dispatcher, oversight, broadcasts };
}

// ── Tests ────────────────────────────────────────────────────────

describe("DelegationService — handleDelegateTaskCall", () => {
  let db: Db;
  let ids: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    db = createDb(":memory:");
    ids = await seedBasics(db);
  });

  it("E_NO_EDGE when delegation_edges has no (from, to) row", async () => {
    const { svc } = makeService(db);
    const result = await svc.handleDelegateTaskCall({
      fromAgentId: ids.cosId,
      householdId: ids.householdId,
      toAgentName: "Bob",
      goal: "build todoist tool",
      requestedByMember: ids.principalId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_NO_EDGE");
  });

  it("succeeds when the edge exists and dispatcher is called", async () => {
    await db.insert(delegationEdges).values({ fromAgentId: ids.cosId, toAgentId: ids.bobId });
    const { svc, dispatcher } = makeService(db);

    const result = await svc.handleDelegateTaskCall({
      fromAgentId: ids.cosId,
      householdId: ids.householdId,
      toAgentName: "Bob",
      goal: "build todoist tool",
      requestedByMember: ids.principalId,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runId).toBeDefined();
      expect(result.status).toBe("pending");
    }
    // Give the async dispatch a tick to fire
    await new Promise((r) => setTimeout(r, 5));
    expect(dispatcher.handleTaskAssignment).toHaveBeenCalledTimes(1);

    const [task] = await db.select().from(tasks).where(eq(tasks.agentId, ids.bobId));
    expect(task.title).toBe("build todoist tool");
    expect(task.delegationDepth).toBe(1);
    expect(task.notifyAgentId).toBe(ids.cosId);
    expect(task.workspaceKind).toBe("tool_sandbox");
  });

  it("E_DEPTH_EXCEEDED when caller is already a delegated task", async () => {
    // Create a second Developer (Alice) and the edge Bob → Alice, so the edge
    // check passes. The depth check should then fire because Bob is running
    // inside a delegationDepth=1 task.
    const [alice] = await db
      .insert(staffAgents)
      .values({
        householdId: ids.householdId,
        name: "Alice",
        staffRole: "custom",
        specialty: "project",
        visibility: "internal",
      })
      .returning();
    await db.insert(delegationEdges).values({ fromAgentId: ids.bobId, toAgentId: alice.id });

    const [callerTask] = await db
      .insert(tasks)
      .values({
        householdId: ids.householdId,
        agentId: ids.bobId,
        title: "running inside a delegation",
        requiresApproval: false,
        delegationDepth: 1,
      })
      .returning();

    const { svc } = makeService(db);
    const result = await svc.handleDelegateTaskCall({
      fromAgentId: ids.bobId,
      householdId: ids.householdId,
      toAgentName: "Alice",
      goal: "recurse",
      requestedByMember: ids.principalId,
      callerTaskId: callerTask.id,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_DEPTH_EXCEEDED");
  });

  it("E_AGENT_NOT_FOUND with case-insensitive retry on a typo", async () => {
    const { svc } = makeService(db);
    const result = await svc.handleDelegateTaskCall({
      fromAgentId: ids.cosId,
      householdId: ids.householdId,
      toAgentName: "nonexistent",
      goal: "x",
      requestedByMember: ids.principalId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_AGENT_NOT_FOUND");
  });
});

describe("DelegationService — handleHireApproval / Rejection race gate", () => {
  let db: Db;
  let ids: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    db = createDb(":memory:");
    ids = await seedBasics(db);
  });

  async function createPendingHireTask(description: string) {
    return db
      .insert(tasks)
      .values({
        householdId: ids.householdId,
        agentId: ids.cosId,
        requestedBy: ids.principalId,
        title: "Hire Alice (project)",
        description,
        requiresApproval: true,
        status: "pending",
        delegationDepth: 0,
      })
      .returning();
  }

  it("approval materializes a Developer + edge + marks task completed", async () => {
    const [approvalTask] = await createPendingHireTask(
      JSON.stringify({
        kind: "hire_proposal",
        role: "Developer",
        specialty: "tools",
        reason: "need a tool builder",
        proposedName: "Bob2",
      }),
    );

    const { svc } = makeService(db);
    const result = await svc.handleHireApproval(approvalTask.id, "josh-tg");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyResolved).toBeFalsy();
    expect(result.developerAgentId).toBeDefined();

    // Developer row exists
    const [dev] = await db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, result.developerAgentId!));
    expect(dev.name).toBe("Bob2");
    expect(dev.specialty).toBe("tools");
    expect(dev.model).toBe("claude-opus-4-7");
    expect(dev.trustLevel).toBe("full");
    expect(dev.autonomyLevel).toBe("autonomous");
    expect(dev.operatingInstructions).toContain("Operating Instructions");

    // Edge CoS → Developer exists
    const edges = await db
      .select()
      .from(delegationEdges)
      .where(eq(delegationEdges.fromAgentId, ids.cosId));
    expect(edges.some((e) => e.toAgentId === result.developerAgentId)).toBe(true);

    // Approval task marked completed
    const [t] = await db.select().from(tasks).where(eq(tasks.id, approvalTask.id));
    expect(t.status).toBe("completed");
  });

  it("double-tap Approve → only one win, second is alreadyResolved", async () => {
    const [approvalTask] = await createPendingHireTask(
      JSON.stringify({ kind: "hire_proposal", specialty: "tools", reason: "x", proposedName: "RaceBob" }),
    );
    const { svc } = makeService(db);

    const [r1, r2] = await Promise.all([
      svc.handleHireApproval(approvalTask.id, "josh-tg-1"),
      svc.handleHireApproval(approvalTask.id, "josh-tg-2"),
    ]);

    const wins = [r1, r2].filter((r) => r.ok && !r.alreadyResolved);
    const loses = [r1, r2].filter((r) => r.ok && r.alreadyResolved);
    expect(wins).toHaveLength(1);
    expect(loses).toHaveLength(1);

    // Only one Developer row materialized
    const devs = await db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.name, "RaceBob"));
    expect(devs).toHaveLength(1);
  });

  it("approve + reject race → exactly one wins, task ends in a single terminal state", async () => {
    const [approvalTask] = await createPendingHireTask(
      JSON.stringify({ kind: "hire_proposal", specialty: "project", reason: "x" }),
    );
    const { svc } = makeService(db);

    const [r1, r2] = await Promise.all([
      svc.handleHireApproval(approvalTask.id, "josh-approve"),
      svc.handleHireRejection(approvalTask.id, "josh-reject"),
    ]);

    const outcomes = [r1, r2];
    const wins = outcomes.filter((r) => r.ok && !r.alreadyResolved);
    expect(wins).toHaveLength(1);

    const [t] = await db.select().from(tasks).where(eq(tasks.id, approvalTask.id));
    expect(["completed", "cancelled"]).toContain(t.status);
  });
});

describe("DelegationService — handleCancelTask", () => {
  let db: Db;
  let ids: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    db = createDb(":memory:");
    ids = await seedBasics(db);
  });

  it("resolves specialistName → an active task and marks it cancelled", async () => {
    // Completed tasks should be ignored; only active ones are targeted.
    await db.insert(tasks).values({
      householdId: ids.householdId,
      agentId: ids.bobId,
      title: "old done",
      requiresApproval: false,
      status: "completed",
    });
    const [active] = await db
      .insert(tasks)
      .values({
        householdId: ids.householdId,
        agentId: ids.bobId,
        title: "active task",
        requiresApproval: false,
        status: "in_progress",
      })
      .returning();

    const { svc } = makeService(db);
    const result = await svc.handleCancelTask({
      householdId: ids.householdId,
      specialistName: "Bob",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("cancelled");

    const [r] = await db.select().from(tasks).where(eq(tasks.id, active.id));
    expect(r.status).toBe("cancelled");
  });

  it("two concurrent cancels → exactly one fires side effects, the other reports alreadyTerminal", async () => {
    // Codex flagged this race: the previous read-then-update sequence let two
    // callers both observe non-terminal, both flip + log + broadcast. The
    // conditional UPDATE in handleCancelTask turns this into compare-and-swap
    // so only the first caller returns a fresh cancellation and any loser
    // sees alreadyTerminal=true without double-firing the broadcast.
    const [active] = await db
      .insert(tasks)
      .values({
        householdId: ids.householdId,
        agentId: ids.bobId,
        title: "doomed",
        requiresApproval: false,
        status: "in_progress",
      })
      .returning();

    const { svc, broadcasts } = makeService(db);

    const [first, second] = await Promise.all([
      svc.handleCancelTask({ householdId: ids.householdId, runId: active.id }),
      svc.handleCancelTask({ householdId: ids.householdId, runId: active.id }),
    ]);

    expect(first.ok && second.ok).toBe(true);

    const winners = [first, second].filter(
      (r) => r.ok && !(r as { alreadyTerminal?: boolean }).alreadyTerminal,
    );
    const losers = [first, second].filter(
      (r) => r.ok && (r as { alreadyTerminal?: boolean }).alreadyTerminal,
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, active.id));
    expect(row.status).toBe("cancelled");

    const cancelBroadcasts = broadcasts.filter((b) => b.type === "task.cancelled");
    expect(cancelBroadcasts).toHaveLength(1);
  });

  it("idempotent: cancelling a terminal task returns alreadyTerminal without mutation", async () => {
    const [task] = await db
      .insert(tasks)
      .values({
        householdId: ids.householdId,
        agentId: ids.bobId,
        title: "done",
        requiresApproval: false,
        status: "completed",
      })
      .returning();

    const { svc } = makeService(db);
    const result = await svc.handleCancelTask({
      householdId: ids.householdId,
      runId: task.id,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyTerminal).toBe(true);
      expect(result.status).toBe("completed");
    }
  });
});

describe("DelegationService — grant/revoke delegation (v0.4 N:M)", () => {
  let db: Db;
  let ids: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    db = createDb(":memory:");
    ids = await seedBasics(db);
  });

  async function seedPersonalKid(dbRef: Db, householdId: string) {
    const [kidAgent] = await dbRef
      .insert(staffAgents)
      .values({
        householdId,
        name: "Django",
        staffRole: "personal",
        model: "claude-sonnet-4-6",
        trustLevel: "standard",
      })
      .returning();
    return kidAgent;
  }

  it("grants an edge from a personal agent to a specialist, idempotent on re-grant", async () => {
    const kid = await seedPersonalKid(db, ids.householdId);
    const { svc } = makeService(db);

    const first = await svc.handleGrantDelegation({
      householdId: ids.householdId,
      delegatorId: kid.id,
      specialistId: ids.bobId,
    });
    expect(first).toMatchObject({ ok: true, created: true });

    const second = await svc.handleGrantDelegation({
      householdId: ids.householdId,
      delegatorId: kid.id,
      specialistId: ids.bobId,
    });
    expect(second).toMatchObject({ ok: true, created: false });

    const edges = await db
      .select()
      .from(delegationEdges)
      .where(and(eq(delegationEdges.fromAgentId, kid.id), eq(delegationEdges.toAgentId, ids.bobId)));
    expect(edges).toHaveLength(1);
  });

  it("rejects grants where the delegator is not a personal agent", async () => {
    // Can't use Bob (custom specialty) as a delegator — he's the one being
    // delegated to, not delegating. Enforces the tree-shape rule.
    const { svc } = makeService(db);
    const second = await db
      .insert(staffAgents)
      .values({
        householdId: ids.householdId,
        name: "Alice",
        staffRole: "custom",
        specialty: "tools",
        model: "claude-opus-4-7",
        trustLevel: "full",
      })
      .returning();

    const result = await svc.handleGrantDelegation({
      householdId: ids.householdId,
      delegatorId: ids.bobId,
      specialistId: second[0].id,
    });
    expect(result).toMatchObject({ ok: false, code: "E_INVALID_ROLE" });
  });

  it("rejects grants where the specialist is a personal agent (no personal→personal)", async () => {
    // Carson → Django is the forbidden case: we don't re-delegate through
    // personal agents. Flow is always personal → specialist.
    const kid = await seedPersonalKid(db, ids.householdId);
    const { svc } = makeService(db);

    const result = await svc.handleGrantDelegation({
      householdId: ids.householdId,
      delegatorId: ids.cosId,
      specialistId: kid.id,
    });
    expect(result).toMatchObject({ ok: false, code: "E_INVALID_ROLE" });
  });

  it("rejects self-grants", async () => {
    const { svc } = makeService(db);
    const result = await svc.handleGrantDelegation({
      householdId: ids.householdId,
      delegatorId: ids.cosId,
      specialistId: ids.cosId,
    });
    expect(result).toMatchObject({ ok: false, code: "E_SELF" });
  });

  it("revokes an existing edge and is idempotent on a missing edge", async () => {
    const kid = await seedPersonalKid(db, ids.householdId);
    const { svc } = makeService(db);

    await svc.handleGrantDelegation({
      householdId: ids.householdId,
      delegatorId: kid.id,
      specialistId: ids.bobId,
    });

    const first = await svc.handleRevokeDelegation({
      householdId: ids.householdId,
      delegatorId: kid.id,
      specialistId: ids.bobId,
    });
    expect(first).toMatchObject({ ok: true, removed: true });

    const second = await svc.handleRevokeDelegation({
      householdId: ids.householdId,
      delegatorId: kid.id,
      specialistId: ids.bobId,
    });
    expect(second).toMatchObject({ ok: true, removed: false });

    const edges = await db
      .select()
      .from(delegationEdges)
      .where(and(eq(delegationEdges.fromAgentId, kid.id), eq(delegationEdges.toAgentId, ids.bobId)));
    expect(edges).toHaveLength(0);
  });

  it("concurrent grants resolve idempotently — UNIQUE constraint loser returns created:false", async () => {
    // Codex flagged this race: two simultaneous grants both miss the
    // precheck, then the insert hits the (from,to) unique index. Loser used
    // to throw, which bubbled as a 500 on the REST path. Caller should see
    // clean idempotent semantics instead.
    const kid = await seedPersonalKid(db, ids.householdId);
    const { svc } = makeService(db);

    const [first, second] = await Promise.all([
      svc.handleGrantDelegation({
        householdId: ids.householdId,
        delegatorId: kid.id,
        specialistId: ids.bobId,
      }),
      svc.handleGrantDelegation({
        householdId: ids.householdId,
        delegatorId: kid.id,
        specialistId: ids.bobId,
      }),
    ]);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      const createdCount = [first, second].filter((r) => r.created).length;
      expect(createdCount).toBe(1);
    }

    const edges = await db
      .select()
      .from(delegationEdges)
      .where(and(eq(delegationEdges.fromAgentId, kid.id), eq(delegationEdges.toAgentId, ids.bobId)));
    expect(edges).toHaveLength(1);
  });

  it("revoke with a mismatched householdId is rejected — no cross-household deletes", async () => {
    // Codex flagged that handleRevokeDelegation used to ignore input.householdId
    // so a caller who happened to know a pair of agent ids could delete an
    // edge even without belonging to that household. Revoke now applies the
    // same scoping grant does.
    const kid = await seedPersonalKid(db, ids.householdId);
    const { svc } = makeService(db);

    await svc.handleGrantDelegation({
      householdId: ids.householdId,
      delegatorId: kid.id,
      specialistId: ids.bobId,
    });

    const result = await svc.handleRevokeDelegation({
      householdId: "some-other-household",
      delegatorId: kid.id,
      specialistId: ids.bobId,
    });
    expect(result).toMatchObject({ ok: false, code: "E_AGENT_NOT_FOUND" });

    const edges = await db
      .select()
      .from(delegationEdges)
      .where(and(eq(delegationEdges.fromAgentId, kid.id), eq(delegationEdges.toAgentId, ids.bobId)));
    expect(edges).toHaveLength(1);
  });

  it("broadcasts delegation.edge.granted on first grant and nothing on no-op re-grant", async () => {
    const kid = await seedPersonalKid(db, ids.householdId);
    const { svc, broadcasts } = makeService(db);

    await svc.handleGrantDelegation({
      householdId: ids.householdId,
      delegatorId: kid.id,
      specialistId: ids.bobId,
    });
    await svc.handleGrantDelegation({
      householdId: ids.householdId,
      delegatorId: kid.id,
      specialistId: ids.bobId,
    });

    const granted = broadcasts.filter((b) => b.type === "delegation.edge.granted");
    expect(granted).toHaveLength(1);
  });
});
