/**
 * Critical-path tests for Planner v2 infrastructure.
 *
 * Four groups, each verifying one load-bearing structural guarantee:
 *   A. Frontmatter parser — valid + malformed plans
 *   B. accept_plan       — state transitions + household scoping
 *   C. propose_hire      — plan validation gate
 *   D. revision linkage  — parent_plan_task_id chain
 *
 * Stubs follow the existing delegation-service.test.ts pattern: real DB
 * (in-memory), stub Adapter / Dispatcher / TaskEngine / Oversight. The goal
 * is DB-invariant verification, not subprocess pipelines.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "@carsonos/db";
import {
  households,
  staffAgents,
  familyMembers,
  tasks,
  taskEvents,
  delegationEdges,
} from "@carsonos/db";
import { DelegationService } from "../../delegation-service.js";
import { TaskEngine } from "../../task-engine.js";
import type { Dispatcher } from "../../dispatcher.js";
import type { CarsonOversight } from "../../carson-oversight.js";
import { parsePlanResult } from "../plan-parser.js";

// ── Shared fixtures ─────────────────────────────────────────────

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

async function seedHousehold(db: Db) {
  const [household] = await db.insert(households).values({ name: "test" }).returning();
  const [principal] = await db
    .insert(familyMembers)
    .values({ householdId: household.id, name: "Josh", role: "parent", age: 40, telegramUserId: "1" })
    .returning();
  const [cos] = await db
    .insert(staffAgents)
    .values({ householdId: household.id, name: "Carson", staffRole: "head_butler", isHeadButler: true })
    .returning();
  const [planner] = await db
    .insert(staffAgents)
    .values({
      householdId: household.id,
      name: "Pat",
      staffRole: "custom",
      specialty: "planning",
      visibility: "internal",
      autonomyLevel: "autonomous",
    })
    .returning();
  return { householdId: household.id, principalId: principal.id, cosId: cos.id, plannerId: planner.id };
}

function makeService(db: Db) {
  const adapter = stubAdapter();
  const dispatcher = stubDispatcher();
  const oversight = stubOversight();
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

type PlanStatus = "pending_approval" | "accepted" | "revise" | "replan";

async function createPendingPlanTask(
  db: Db,
  ids: { householdId: string; principalId: string; plannerId: string },
  overrides: { status?: string; planStatus?: PlanStatus | null; description?: string } = {},
) {
  const [task] = await db
    .insert(tasks)
    .values({
      householdId: ids.householdId,
      agentId: ids.plannerId,
      requestedBy: ids.principalId,
      title: "design the auth refactor",
      description: overrides.description ?? "the original brief",
      status: overrides.status ?? "completed",
      requiresApproval: false,
      delegationDepth: 1,
      planStatus:
        overrides.planStatus === undefined ? "pending_approval" : overrides.planStatus,
    })
    .returning();
  return task;
}

// ── Group A: Frontmatter parser ─────────────────────────────────

describe("parsePlanResult", () => {
  it("parses a valid complete plan with frontmatter", () => {
    const body = `---
plan_state: complete
target_developer: core
foundational_invariant: "depth-2 holds"
state_location: "tasks.delegation_depth"
failure_modes_considered:
  - "infinite recursion"
prior_plans_consulted: []
decisions_referenced: []
estimated_complexity: small
out_of_scope: []
open_questions: []
---

# Interpretation

We need to enforce depth-2 properly.
`;
    const result = parsePlanResult(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frontmatter.plan_state).toBe("complete");
    if (result.frontmatter.plan_state === "complete") {
      expect(result.frontmatter.target_developer).toBe("core");
      expect(result.frontmatter.estimated_complexity).toBe("small");
    }
    expect(result.body).toContain("Interpretation");
  });

  it("parses a valid programming_incomplete plan", () => {
    const body = `---
plan_state: programming_incomplete
programming_questions:
  - "should we use postgres or sqlite?"
prior_plans_consulted: []
decisions_referenced: []
---

The brief leaves the storage layer undecided.
`;
    const result = parsePlanResult(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frontmatter.plan_state).toBe("programming_incomplete");
    if (result.frontmatter.plan_state === "programming_incomplete") {
      expect(result.frontmatter.programming_questions).toHaveLength(1);
    }
  });

  it("rejects a complete plan missing foundational_invariant", () => {
    const body = `---
plan_state: complete
target_developer: core
state_location: "tasks.delegation_depth"
failure_modes_considered: []
prior_plans_consulted: []
decisions_referenced: []
estimated_complexity: small
out_of_scope: []
open_questions: []
---

body
`;
    const result = parsePlanResult(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("foundational_invariant");
  });

  it("rejects a plan with invalid target_developer value", () => {
    const body = `---
plan_state: complete
target_developer: kernel
foundational_invariant: "x"
state_location: "y"
failure_modes_considered: []
prior_plans_consulted: []
decisions_referenced: []
estimated_complexity: small
out_of_scope: []
open_questions: []
---

body
`;
    const result = parsePlanResult(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("target_developer");
  });

  it("tolerates leading narration before frontmatter", () => {
    const body = `Let me read the codebase first.
Reading packages/db/src/schema.ts...
Reading the dispatcher hook now.
Let me check the existing tests too.
Now writing the plan.

---
plan_state: complete
target_developer: core
foundational_invariant: "x"
state_location: "y"
failure_modes_considered: []
prior_plans_consulted: []
decisions_referenced: []
estimated_complexity: small
out_of_scope: []
open_questions: []
---

# Interpretation

The actual plan body.
`;
    const result = parsePlanResult(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.frontmatter.plan_state === "complete") {
      expect(result.frontmatter.target_developer).toBe("core");
    }
    expect(result.body).toContain("# Interpretation");
    expect(result.body).toContain("The actual plan body");
    expect(result.body).not.toContain("Let me read the codebase");
  });

  it("tolerates a yaml code fence wrapping the frontmatter", () => {
    const body = [
      "Some narration first.",
      "",
      "```yaml",
      "---",
      "plan_state: complete",
      "target_developer: tools",
      'foundational_invariant: "x"',
      'state_location: "y"',
      "failure_modes_considered: []",
      "prior_plans_consulted: []",
      "decisions_referenced: []",
      "estimated_complexity: medium",
      "out_of_scope: []",
      "open_questions: []",
      "---",
      "",
      "# Interpretation",
      "",
      "fenced plan body content",
      "```",
      "",
      "trailing notes outside the fence",
    ].join("\n");

    const result = parsePlanResult(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.frontmatter.plan_state === "complete") {
      expect(result.frontmatter.target_developer).toBe("tools");
    }
    expect(result.body).toContain("# Interpretation");
    expect(result.body).toContain("fenced plan body content");
    expect(result.body).toContain("trailing notes outside the fence");
    expect(result.body).not.toContain("```");
  });

  it("tolerates narration plus markdown horizontal rule before fenced frontmatter", () => {
    // Pattern 3 from the parser's tolerance NOTE — observed in three smoke-
    // test runs (2026-04-26): the Planner emits narration, then a standalone
    // '---' (markdown horizontal rule), then a fenced yaml block whose own
    // '---' delimiters carry the real frontmatter.
    const body = [
      "I'll read the codebase first.",
      "Now let me check the memory tools.",
      "I have a complete picture. Producing the plan now.",
      "",
      "---",
      "",
      "```yaml",
      "---",
      "plan_state: complete",
      "target_developer: project",
      'foundational_invariant: "x"',
      'state_location: "y"',
      "failure_modes_considered: []",
      "prior_plans_consulted: []",
      "decisions_referenced: []",
      "estimated_complexity: large",
      "out_of_scope: []",
      "open_questions: []",
      "---",
      "```",
      "",
      "## Interpretation",
      "",
      "The plan body content here.",
    ].join("\n");

    const result = parsePlanResult(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.frontmatter.plan_state === "complete") {
      expect(result.frontmatter.target_developer).toBe("project");
      expect(result.frontmatter.estimated_complexity).toBe("large");
    }
    expect(result.body).toContain("## Interpretation");
    expect(result.body).toContain("The plan body content here");
    expect(result.body).not.toContain("```");
    expect(result.body).not.toContain("I'll read the codebase");
  });

  it("still rejects input with no frontmatter delimiter at all", () => {
    const body = `# Just markdown

No frontmatter here, just prose. Nothing for the parser to anchor on.
`;
    const result = parsePlanResult(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("missing required YAML frontmatter");
  });
});

// ── Group B: accept_plan state transitions ──────────────────────

describe("acceptPlan", () => {
  let db: Db;
  let ids: Awaited<ReturnType<typeof seedHousehold>>;

  beforeEach(async () => {
    db = createDb(":memory:");
    ids = await seedHousehold(db);
  });

  it("transitions pending_approval to accepted on decision=accept", async () => {
    const planTask = await createPendingPlanTask(db, ids);
    const { svc } = makeService(db);

    const result = await svc.handleAcceptPlan({
      acceptingAgentId: ids.cosId,
      householdId: ids.householdId,
      taskId: planTask.id,
      decision: "accept",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision).toBe("accept");

    const [updated] = await db.select().from(tasks).where(eq(tasks.id, planTask.id));
    expect(updated.planStatus).toBe("accepted");

    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, planTask.id));
    expect(events.some((e) => e.eventType === "plan_accepted")).toBe(true);
  });

  it("creates child task with parent_plan_task_id on decision=revise", async () => {
    const planTask = await createPendingPlanTask(db, ids);
    const { svc, dispatcher } = makeService(db);

    const result = await svc.handleAcceptPlan({
      acceptingAgentId: ids.cosId,
      householdId: ids.householdId,
      taskId: planTask.id,
      decision: "revise",
      notes: "tighten the depth-2 explanation",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision).toBe("revise");
    if (result.decision !== "revise") return;
    expect(result.childTaskId).toBeDefined();

    const [child] = await db.select().from(tasks).where(eq(tasks.id, result.childTaskId));
    expect(child.parentPlanTaskId).toBe(planTask.id);
    expect(child.agentId).toBe(ids.plannerId);
    expect(child.notifyAgentId).toBe(ids.cosId);

    // Dispatch fired for the revision task (fire-and-forget, give it a tick)
    await new Promise((r) => setTimeout(r, 5));
    expect(dispatcher.handleTaskAssignment).toHaveBeenCalledWith(result.childTaskId);
  });

  it("rejects acceptance of a task in a different household", async () => {
    const planTask = await createPendingPlanTask(db, ids);
    const [otherHousehold] = await db.insert(households).values({ name: "other" }).returning();

    const { svc } = makeService(db);

    const result = await svc.handleAcceptPlan({
      acceptingAgentId: ids.cosId,
      householdId: otherHousehold.id,
      taskId: planTask.id,
      decision: "accept",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("E_WRONG_HOUSEHOLD");
  });

  it("rejects acceptance of a non-Planner task", async () => {
    // Seed a non-Planner agent + a task on it carrying a plan_status (which
    // shouldn't happen in normal flow but we want to verify the gate is on
    // the agent's specialty, not just plan_status).
    const [bob] = await db
      .insert(staffAgents)
      .values({
        householdId: ids.householdId,
        name: "Bob",
        staffRole: "custom",
        specialty: "tools",
        visibility: "internal",
      })
      .returning();
    const [bobTask] = await db
      .insert(tasks)
      .values({
        householdId: ids.householdId,
        agentId: bob.id,
        requestedBy: ids.principalId,
        title: "build something",
        status: "completed",
        requiresApproval: false,
        delegationDepth: 1,
        planStatus: "pending_approval",
      })
      .returning();

    const { svc } = makeService(db);
    const result = await svc.handleAcceptPlan({
      acceptingAgentId: ids.cosId,
      householdId: ids.householdId,
      taskId: bobTask.id,
      decision: "accept",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("E_NOT_A_PLAN");
  });
});

// ── Group C: propose_hire plan validation ───────────────────────

describe("proposeHire plan validation", () => {
  let db: Db;
  let ids: Awaited<ReturnType<typeof seedHousehold>>;

  beforeEach(async () => {
    db = createDb(":memory:");
    ids = await seedHousehold(db);
  });

  it("rejects a Developer hire without plan_task_id", async () => {
    const { svc } = makeService(db);

    const result = await svc.handleHireProposal({
      householdId: ids.householdId,
      proposedByAgentId: ids.cosId,
      proposedByMemberId: ids.principalId,
      role: "Developer",
      specialty: "tools",
      reason: "build the todoist tool",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("E_PLAN_REQUIRED");
  });

  it("rejects a Developer hire with a plan_task_id that's not accepted", async () => {
    const planTask = await createPendingPlanTask(db, ids); // plan_status = pending_approval
    const { svc } = makeService(db);

    const result = await svc.handleHireProposal({
      householdId: ids.householdId,
      proposedByAgentId: ids.cosId,
      proposedByMemberId: ids.principalId,
      role: "Developer",
      specialty: "tools",
      reason: "ship the todoist tool",
      planTaskId: planTask.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("E_PLAN_NOT_ACCEPTED");
  });

  it("accepts a non-Developer hire (planning) without plan_task_id", async () => {
    const { svc } = makeService(db);

    const result = await svc.handleHireProposal({
      householdId: ids.householdId,
      proposedByAgentId: ids.cosId,
      proposedByMemberId: ids.principalId,
      role: "Planner",
      specialty: "planning",
      reason: "we need an architect",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approvalTaskId).toBeDefined();
  });
});

// ── Group D: Revision linkage ───────────────────────────────────

describe("plan revision", () => {
  let db: Db;
  let ids: Awaited<ReturnType<typeof seedHousehold>>;

  beforeEach(async () => {
    db = createDb(":memory:");
    ids = await seedHousehold(db);
    // Edge needed if dispatch path inspects edges; the revision dispatch in
    // accept_plan goes directly through dispatcher.handleTaskAssignment, but
    // wiring the edge keeps the seed faithful to a real CoS->Planner setup.
    await db.insert(delegationEdges).values({ fromAgentId: ids.cosId, toAgentId: ids.plannerId });
  });

  it("creates child task with correct parent_plan_task_id on revise", async () => {
    const planTask = await createPendingPlanTask(db, ids, { description: "make it tidy" });
    const { svc } = makeService(db);

    const result = await svc.handleAcceptPlan({
      acceptingAgentId: ids.cosId,
      householdId: ids.householdId,
      taskId: planTask.id,
      decision: "revise",
      notes: "rework section 3",
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.decision !== "revise") return;

    const [child] = await db.select().from(tasks).where(eq(tasks.id, result.childTaskId));
    expect(child.parentPlanTaskId).toBe(planTask.id);
    expect(child.description).toContain("rework section 3");
    expect(child.description).toContain("make it tidy");

    const childEvents = await db.select().from(taskEvents).where(eq(taskEvents.taskId, child.id));
    expect(childEvents.some((e) => e.eventType === "created")).toBe(true);
  });

  it("updates parent plan_status to 'revise' on revision", async () => {
    const planTask = await createPendingPlanTask(db, ids);
    const { svc } = makeService(db);

    await svc.handleAcceptPlan({
      acceptingAgentId: ids.cosId,
      householdId: ids.householdId,
      taskId: planTask.id,
      decision: "revise",
      notes: "narrow the scope",
    });

    const [updated] = await db.select().from(tasks).where(eq(tasks.id, planTask.id));
    expect(updated.planStatus).toBe("revise");

    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, planTask.id));
    expect(events.some((e) => e.eventType === "plan_revised")).toBe(true);
  });
});
