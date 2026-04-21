/**
 * DB-integration tests for DelegationService's race-safety + validation paths.
 *
 * Uses stubs for Adapter/Dispatcher/TaskEngine/CarsonOversight — the goal is to
 * verify the DB invariants (edge checks, depth-2 enforcement, atomic approve/
 * reject race) without spinning up the full adapter pipeline.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
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
  const taskEngine = new TaskEngine({
    db,
    adapter: adapter as never,
    constitutionEngine: undefined as never,
    broadcast: () => {},
  });
  const svc = new DelegationService(
    { db, adapter: adapter as never, broadcast: () => {} },
    dispatcher,
    taskEngine,
  );
  svc.setOversight(oversight);
  return { svc, dispatcher, oversight };
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
