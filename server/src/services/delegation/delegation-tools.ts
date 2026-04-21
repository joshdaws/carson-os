/**
 * MCP tool definitions + dispatcher for v0.4 delegation.
 *
 * Five tools granted by default to head_butler + personal agents:
 *
 *   delegate_task({to, goal, context?, projectId?}) → {runId, status}
 *       Hands work to a hired specialist. Returns immediately; the child
 *       task runs async through the Dispatcher.
 *
 *   propose_hire({role, specialty, reason, proposedName?}) → {approvalTaskId}
 *       Proposes a new Developer. Always escalates to principal via Telegram
 *       inline buttons (Lane F). On approval, a staff_agents row is created
 *       with the specialty template's operating_instructions.
 *
 *   cancel_task({runId?, specialistName?}) → {status, alreadyTerminal?}
 *       Idempotent cancel. Accepts either a specific runId or a specialist
 *       name; the latter resolves to that specialist's currently-active task.
 *
 *   list_active_tasks({}) → {tasks: ActiveTask[]}
 *       Lets CoS answer "kill bob's task" by resolving specialist name → runId.
 *       Returns all non-terminal delegated tasks for the caller's household.
 *
 *   register_project({name, path, defaultBranch?, testCmd?, devCmd?, repoUrl?})
 *       → {projectId}
 *       Registers a project so Developer tasks can target it via projectId.
 *       v0.4 is explicit-registration only; folder-scan discovery is v0.5.
 *
 * Handler is injected with the same surfaces used by existing MCP tools:
 * Db for reads/writes, a DelegationService for task creation + edge
 * validation, a CarsonOversight for hire escalation.
 */

import type { ToolDefinition, ToolResult } from "@carsonos/shared";
import type { Db } from "@carsonos/db";
import { projects, tasks, staffAgents } from "@carsonos/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { DelegationService } from "../delegation-service.js";
import type { CarsonOversight } from "../carson-oversight.js";

export interface DelegationToolContext {
  db: Db;
  /** The agent calling the tool (the delegator). */
  agentId: string;
  /** Household scope for all DB reads/writes. */
  householdId: string;
  /** Member whose turn spawned this tool call. */
  memberId: string;
  /** The task row id of the calling agent's current turn, if it's inside one.
   * Used for depth-2 enforcement (child depth = caller depth + 1). */
  callerTaskId?: string;
  delegationService: DelegationService;
  oversight: CarsonOversight;
}

// ── Tool definitions ──────────────────────────────────────────────

export const DELEGATION_TOOLS: ToolDefinition[] = [
  {
    name: "delegate_task",
    description:
      "Hand a long-running task to a hired Developer specialist. Returns immediately with a runId; the Developer works in the background and messages back on completion. Use when the work would take more than a few turns (building a tool, fixing an external project, updating CarsonOS). The principal can cancel via 'kill <name>'s task'.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Specialist name (e.g., 'Bob', 'Alice'). Must be a hired Developer on staff." },
        goal: { type: "string", description: "What the Developer should accomplish. Be specific — this becomes the task title." },
        context: { type: "string", description: "Background, references, examples. Optional. Shown to the Developer as the task description." },
        projectId: { type: "string", description: "Required for project/core specialties. Omit for tools specialty. Resolve via list_projects if needed." },
      },
      required: ["to", "goal"],
    },
  },
  {
    name: "propose_hire",
    description:
      "Propose hiring a new Developer. Always escalates to the principal via a Telegram approval card. On approval, the Developer is added to staff with the specialty's operating instructions.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["Developer"], description: "Only 'Developer' is supported in v0.4." },
        specialty: { type: "string", enum: ["tools", "project", "core"], description: "What this Developer focuses on." },
        reason: { type: "string", description: "Why this hire is needed. Shown to the principal on the approval card." },
        proposedName: { type: "string", description: "Suggested name ('Bob', 'Alice', etc.). The principal can override." },
      },
      required: ["role", "specialty", "reason"],
    },
  },
  {
    name: "cancel_task",
    description:
      "Cancel an active delegated task. Idempotent — cancelling an already-terminal task returns success. Pass either runId (exact) or specialistName ('cancel Bob's task').",
    input_schema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Exact task id returned by delegate_task." },
        specialistName: { type: "string", description: "Specialist name — resolves to that specialist's currently-active task." },
      },
    },
  },
  {
    name: "list_active_tasks",
    description:
      "List delegated tasks that are currently in progress, queued, or awaiting approval for the household. Use to answer 'what's Bob working on?' or to resolve a specialist name to a runId before cancelling.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "register_project",
    description:
      "Register a project so Developers can target it via projectId. Required before delegating project/core specialty work. Explicit registration only — folder-scan discovery is a v0.5 feature.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short slug/name (e.g., 'homeschool-happy', 'carson-os')." },
        path: { type: "string", description: "Absolute filesystem path to the project's git checkout." },
        defaultBranch: { type: "string", description: "Default branch (e.g., 'main'). Defaults to 'main'." },
        testCmd: { type: "string", description: "Command to run tests. Empty → verification is skipped." },
        devCmd: { type: "string", description: "Command to run the dev server. Optional." },
        repoUrl: { type: "string", description: "Remote repo URL. Optional." },
      },
      required: ["name", "path"],
    },
  },
];

export const DELEGATION_TOOL_NAMES = new Set(DELEGATION_TOOLS.map((t) => t.name));

// ── Dispatcher ────────────────────────────────────────────────────

export async function handleDelegationTool(
  name: string,
  input: Record<string, unknown>,
  context: DelegationToolContext,
): Promise<ToolResult> {
  switch (name) {
    case "delegate_task":
      return handleDelegateTask(input, context);
    case "propose_hire":
      return handleProposeHire(input, context);
    case "cancel_task":
      return handleCancelTask(input, context);
    case "list_active_tasks":
      return handleListActiveTasks(context);
    case "register_project":
      return handleRegisterProject(input, context);
    default:
      return toolError(`unknown delegation tool: ${name}`);
  }
}

async function handleDelegateTask(
  input: Record<string, unknown>,
  ctx: DelegationToolContext,
): Promise<ToolResult> {
  const to = stringArg(input.to);
  const goal = stringArg(input.goal);
  if (!to || !goal) return toolError("delegate_task requires `to` and `goal`");
  const projectId = stringArg(input.projectId) ?? undefined;
  const context = stringArg(input.context) ?? undefined;

  const result = await ctx.delegationService.handleDelegateTaskCall({
    fromAgentId: ctx.agentId,
    householdId: ctx.householdId,
    toAgentName: to,
    goal,
    context,
    projectId,
    requestedByMember: ctx.memberId,
    callerTaskId: ctx.callerTaskId,
  });

  if (!result.ok) return toolError(result.error);
  return toolOk(
    `Queued ${to} on: ${goal}\nRunId: ${result.runId}\nStatus: ${result.status}`,
    { runId: result.runId, status: result.status },
  );
}

async function handleProposeHire(
  input: Record<string, unknown>,
  ctx: DelegationToolContext,
): Promise<ToolResult> {
  const role = stringArg(input.role) ?? "Developer";
  const specialty = stringArg(input.specialty);
  const reason = stringArg(input.reason);
  const proposedName = stringArg(input.proposedName) ?? undefined;

  if (!specialty || !["tools", "project", "core"].includes(specialty)) {
    return toolError("propose_hire requires specialty: 'tools' | 'project' | 'core'");
  }
  if (!reason) return toolError("propose_hire requires `reason` for the principal's approval card");

  const result = await ctx.delegationService.handleHireProposal({
    householdId: ctx.householdId,
    proposedByAgentId: ctx.agentId,
    proposedByMemberId: ctx.memberId,
    role,
    specialty: specialty as "tools" | "project" | "core",
    reason,
    proposedName,
  });

  if (!result.ok) return toolError(result.error);
  return toolOk(
    `Hire proposal submitted. Awaiting principal approval.\napprovalTaskId: ${result.approvalTaskId}`,
    { approvalTaskId: result.approvalTaskId },
  );
}

async function handleCancelTask(
  input: Record<string, unknown>,
  ctx: DelegationToolContext,
): Promise<ToolResult> {
  const runId = stringArg(input.runId) ?? undefined;
  const specialistName = stringArg(input.specialistName) ?? undefined;
  if (!runId && !specialistName) {
    return toolError("cancel_task requires either `runId` or `specialistName`");
  }

  const result = await ctx.delegationService.handleCancelTask({
    householdId: ctx.householdId,
    runId,
    specialistName,
  });

  if (!result.ok) return toolError(result.error);
  return toolOk(
    result.alreadyTerminal
      ? `Task already terminal (${result.status}) — no action taken.`
      : `Task cancelled. Workspace teardown queued.`,
    { status: result.status, alreadyTerminal: result.alreadyTerminal },
  );
}

async function handleListActiveTasks(
  ctx: DelegationToolContext,
): Promise<ToolResult> {
  const rows = await ctx.db
    .select({
      id: tasks.id,
      agentId: tasks.agentId,
      title: tasks.title,
      status: tasks.status,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.householdId, ctx.householdId),
        inArray(tasks.status, ["pending", "approved", "in_progress"]),
        isNotNull(tasks.parentTaskId),
      ),
    );

  if (rows.length === 0) {
    return toolOk("No active delegated tasks.", { tasks: [] });
  }

  // Resolve specialist names for the caller's convenience
  const agentIds = Array.from(new Set(rows.map((r) => r.agentId)));
  const agents = agentIds.length
    ? await ctx.db
        .select({ id: staffAgents.id, name: staffAgents.name })
        .from(staffAgents)
        .where(inArray(staffAgents.id, agentIds))
    : [];
  const nameById = new Map(agents.map((a) => [a.id, a.name] as const));

  const now = Date.now();
  const active = rows.map((r) => ({
    runId: r.id,
    specialistName: nameById.get(r.agentId) ?? "(unknown)",
    goal: r.title,
    status: r.status,
    startedAt: r.createdAt.toISOString(),
    durationSec: Math.floor((now - r.createdAt.getTime()) / 1000),
  }));

  const summary = active
    .map(
      (t) =>
        `${t.specialistName}: ${t.goal} (${t.status}, ${formatDurationSec(t.durationSec)}) — runId ${t.runId}`,
    )
    .join("\n");

  return toolOk(summary, { tasks: active });
}

async function handleRegisterProject(
  input: Record<string, unknown>,
  ctx: DelegationToolContext,
): Promise<ToolResult> {
  const name = stringArg(input.name);
  const path = stringArg(input.path);
  if (!name || !path) return toolError("register_project requires `name` and `path`");

  const defaultBranch = stringArg(input.defaultBranch) ?? "main";
  const testCmd = stringArg(input.testCmd) ?? null;
  const devCmd = stringArg(input.devCmd) ?? null;
  const repoUrl = stringArg(input.repoUrl) ?? null;

  try {
    const [row] = await ctx.db
      .insert(projects)
      .values({
        householdId: ctx.householdId,
        name,
        path,
        defaultBranch,
        testCmd,
        devCmd,
        repoUrl,
        enabled: true,
      })
      .returning();
    return toolOk(
      `Registered project '${name}' at ${path}.\nprojectId: ${row.id}`,
      { projectId: row.id, name: row.name, path: row.path, defaultBranch: row.defaultBranch },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE constraint failed")) {
      return toolError(`A project named '${name}' already exists in this household.`);
    }
    return toolError(`Failed to register project: ${msg}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function stringArg(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toolOk(text: string, _data?: unknown): ToolResult {
  // Structured return would be nice but ToolResult.content is a plain string
  // in this codebase — embed the key fields in the text and let the LLM parse.
  return { content: text };
}

function toolError(message: string): ToolResult {
  return { content: `Error: ${message}`, is_error: true };
}

function formatDurationSec(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
