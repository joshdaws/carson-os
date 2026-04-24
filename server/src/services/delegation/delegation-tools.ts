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
import { and, eq, inArray, gt, gte, or } from "drizzle-orm";

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
      "Propose hiring a new specialist agent. Always escalates to the principal via a Telegram approval card. On approval, the specialist is added to staff AND — if `originalUserRequest` is set — the hire flow automatically delegates that task to the newly-hired specialist without requiring the user to re-prompt. Use `originalUserRequest` whenever you're hiring in response to a specific ask (\"build me a Todoist tool\", \"research Netflix culture\"); omit it only for proactive hires without a tied task.\n\nThe `role` and `specialty` are free-form so you can bring in any kind of specialist — Developer, Researcher, Music specialist, Tutor, Coach, etc. Three specialties get first-class workspace provisioning: `tools` (sandbox), `project` (git worktree), `core` (carson-os worktree). Any other specialty runs as a conversation-driven agent with MCP tools + trust-level builtins (no workspace).\n\nDefaults by role: `Developer` → claude-opus-4-7 + full trust, anything else → claude-sonnet-4-6 + standard trust. Both autonomous. Override via the `model`/`trustLevel` args.",
    input_schema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          description: "Free-form role name (e.g., 'Developer', 'Researcher', 'Music specialist', 'Tutor').",
        },
        specialty: {
          type: "string",
          description:
            "Kebab-case specialty identifier. Reserved Developer specialties: 'tools', 'project', 'core' (these provision a workspace). Anything else (e.g., 'research', 'music', 'study-coach') runs without a workspace.",
        },
        reason: {
          type: "string",
          description: "Why this hire is needed. Shown to the principal on the approval card. Also used to generate operating instructions when customInstructions is absent.",
        },
        proposedName: {
          type: "string",
          description: "Suggested agent name (e.g., 'Bob', 'Lex', 'Mozart'). The principal can override.",
        },
        customInstructions: {
          type: "string",
          description: "Optional. When set, replaces the default specialty template for this specialist's operating instructions. Use for specialists outside the Developer flow — describe what they do and how they should behave.",
        },
        model: {
          type: "string",
          description: "Optional model override (e.g., 'claude-opus-4-7', 'claude-sonnet-4-6'). Defaults: Developer=opus, others=sonnet.",
        },
        trustLevel: {
          type: "string",
          enum: ["full", "standard", "restricted"],
          description: "Optional trust level override. Defaults: Developer=full, others=standard. Controls Claude Code builtin tools (Bash/Read/Write/etc).",
        },
        originalUserRequest: {
          type: "string",
          description: "The user's original ask in their own words — what they want the new specialist to DO. If set, the system auto-delegates this to the specialist immediately on approval; the user doesn't have to re-prompt. Example: if the user said 'build me a Todoist tool', pass 'build me a Todoist tool' (or a clean-up of it). Omit only for proactive hires not tied to a specific task.",
        },
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
      "List delegated tasks for the household — any that are currently in progress or queued, PLUS any that terminated within the last 60 minutes so you can answer 'any update on X?' after the task has already completed or failed. Includes the outcome (completed/failed/cancelled) and reason for recently-terminal tasks. Use this to resolve a specialist name to a runId before cancelling, or to give an honest status report.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_task_result",
    description:
      "Pull the full output of a previously-delegated task. When a task you delegated completes, you get a short notification; the specialist's full report stays on the task row. Call this when the user asks a follow-up question about what the specialist found (quotes, specifics, the exact code/write-up).\n\nOnly the delegator (you, or the agent you originally routed through) can read the result — a kid's agent can't peek at a parent's task, and vice versa. Pass the runId from the notification.",
    input_schema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Task id returned by delegate_task / surfaced in the completion notification." },
      },
      required: ["runId"],
    },
  },
  {
    name: "grant_delegation",
    description:
      "Allow a personal agent (e.g., a kid's personal agent, or a sibling CoS) to delegate tasks to an existing specialist. Creates a directional edge from delegator → specialist. The specialist stays shared — one Dev can be reached by Carson, Django, and any other granted personal agent without re-hiring.\n\nUse when a user asks to 'give <kid's agent name> access to <specialist name>', or when a kid's agent messages you asking for help that only a specialist can do.\n\nTopology rules: the delegator must be a personal agent or CoS; the specialist must NOT be a personal agent. Delegation is strictly tree-shaped — no re-delegation.",
    input_schema: {
      type: "object",
      properties: {
        delegator: { type: "string", description: "Name of the personal agent that will gain delegation access (e.g., 'Django', 'Carson')." },
        specialist: { type: "string", description: "Name of the existing specialist to grant access to (e.g., 'Dev', 'Lex')." },
      },
      required: ["delegator", "specialist"],
    },
  },
  {
    name: "revoke_delegation",
    description:
      "Remove a personal agent's ability to delegate to a specialist. Idempotent — revoking a grant that doesn't exist returns success. In-flight tasks already dispatched continue to run; only future delegate_task calls are blocked.",
    input_schema: {
      type: "object",
      properties: {
        delegator: { type: "string", description: "Name of the personal agent whose access is being revoked." },
        specialist: { type: "string", description: "Name of the specialist the delegator will no longer reach." },
      },
      required: ["delegator", "specialist"],
    },
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
    case "read_task_result":
      return handleReadTaskResult(input, context);
    case "grant_delegation":
      return handleGrantDelegation(input, context);
    case "revoke_delegation":
      return handleRevokeDelegation(input, context);
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
  const role = stringArg(input.role);
  const specialty = stringArg(input.specialty);
  const reason = stringArg(input.reason);
  const proposedName = stringArg(input.proposedName) ?? undefined;
  const customInstructions = stringArg(input.customInstructions) ?? undefined;
  const model = stringArg(input.model) ?? undefined;
  const trustLevel = stringArg(input.trustLevel) ?? undefined;
  const originalUserRequest = stringArg(input.originalUserRequest) ?? undefined;

  if (!role) return toolError("propose_hire requires `role` (e.g., 'Developer', 'Researcher', 'Music specialist')");
  if (!specialty) return toolError("propose_hire requires `specialty` (kebab-case; e.g., 'tools', 'research', 'music')");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(specialty)) {
    return toolError(`specialty must be lowercase kebab-case, got '${specialty}'`);
  }
  if (!reason) return toolError("propose_hire requires `reason` for the principal's approval card");
  if (trustLevel && !["full", "standard", "restricted"].includes(trustLevel)) {
    return toolError(`trustLevel must be one of 'full' | 'standard' | 'restricted', got '${trustLevel}'`);
  }

  const result = await ctx.delegationService.handleHireProposal({
    householdId: ctx.householdId,
    proposedByAgentId: ctx.agentId,
    proposedByMemberId: ctx.memberId,
    role,
    specialty,
    reason,
    proposedName,
    customInstructions,
    model,
    trustLevel: trustLevel as "full" | "standard" | "restricted" | undefined,
    originalUserRequest,
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
  const RECENT_TERMINAL_WINDOW_MS = 60 * 60 * 1000; // 60 min
  const recentCutoff = new Date(Date.now() - RECENT_TERMINAL_WINDOW_MS);

  // Scope to the caller's member. A kid's personal agent should not see parent
  // task results (task.result can contain sensitive specialist output). CoS
  // calls arrive with ctx.memberId=the-parent, so parent delegations stay
  // visible to their own CoS. Household-wide views are served by REST, not MCP.
  const rows = await ctx.db
    .select({
      id: tasks.id,
      agentId: tasks.agentId,
      title: tasks.title,
      status: tasks.status,
      result: tasks.result,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
      completedAt: tasks.completedAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.householdId, ctx.householdId),
        eq(tasks.requestedBy, ctx.memberId),
        gt(tasks.delegationDepth, 0),
        or(
          inArray(tasks.status, ["pending", "approved", "in_progress"]),
          and(
            inArray(tasks.status, ["completed", "failed", "cancelled"]),
            gte(tasks.updatedAt, recentCutoff),
          ),
        ),
      ),
    );

  if (rows.length === 0) {
    return toolOk("No active or recently-terminated delegated tasks.", { tasks: [] });
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
  const activeStatuses = new Set(["pending", "approved", "in_progress"]);

  const enriched = rows.map((r) => {
    const isActive = activeStatuses.has(r.status);
    const endTime = r.completedAt?.getTime() ?? r.updatedAt.getTime();
    return {
      runId: r.id,
      specialistName: nameById.get(r.agentId) ?? "(unknown)",
      goal: r.title,
      status: r.status,
      isActive,
      startedAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      durationSec: Math.floor(
        ((isActive ? now : endTime) - r.createdAt.getTime()) / 1000,
      ),
      // For terminal tasks, surface the outcome + short reason/result preview
      // so the caller can summarize without a second tool call.
      outcome: isActive
        ? undefined
        : {
            status: r.status,
            // task.result may be a reason string (failure/cancel) or the
            // specialist's response body (research completion). Trim for the
            // status summary; full contents stay in task.result.
            preview: r.result
              ? r.result.replace(/\s+/g, " ").slice(0, 300) + (r.result.length > 300 ? "…" : "")
              : undefined,
          },
    };
  });

  // Active first (oldest first), then recently-terminal (most-recent first).
  enriched.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return a.isActive
      ? a.startedAt.localeCompare(b.startedAt)
      : b.updatedAt.localeCompare(a.updatedAt);
  });

  const summary = enriched
    .map((t) => {
      const dur = formatDurationSec(t.durationSec);
      if (t.isActive) {
        return `${t.specialistName}: ${t.goal} (${t.status}, ${dur}) — runId ${t.runId}`;
      }
      const outcomeEmoji =
        t.status === "completed" ? "✅" : t.status === "failed" ? "❌" : "⏹";
      const reasonBit = t.outcome?.preview ? ` — ${t.outcome.preview}` : "";
      return `${outcomeEmoji} ${t.specialistName}: ${t.goal} (${t.status}, ${dur} ago)${reasonBit} — runId ${t.runId}`;
    })
    .join("\n");

  return toolOk(summary, { tasks: enriched });
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

async function handleReadTaskResult(
  input: Record<string, unknown>,
  ctx: DelegationToolContext,
): Promise<ToolResult> {
  const runId = stringArg(input.runId);
  if (!runId) return toolError("read_task_result requires `runId`");

  const [task] = await ctx.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, runId))
    .limit(1);
  if (!task) return toolError(`task ${runId} not found`);

  // Household scope first — can't reach into another family's tasks even if
  // you happen to guess a runId.
  if (task.householdId !== ctx.householdId) {
    return toolError(`task ${runId} not found`);
  }

  // Authorization: either the delegator (notify_agent_id is us) or the user
  // who asked for it (requested_by matches our member). Keeps a kid's agent
  // from snooping on a parent's delegation results even if they got a runId
  // from another channel.
  const isDelegator = task.notifyAgentId === ctx.agentId;
  const isRequester = task.requestedBy === ctx.memberId;
  if (!isDelegator && !isRequester) {
    return toolError("you don't have access to this task's result");
  }

  const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
  if (!terminalStatuses.has(task.status)) {
    return toolOk(
      `Task ${runId} is still ${task.status}. No result to read yet. Use list_active_tasks to check status.`,
      { status: task.status },
    );
  }

  const resultText = task.result ?? "(no output captured)";
  return toolOk(
    `Task: ${task.title}\nStatus: ${task.status}\n\n---\n${resultText}`,
    { status: task.status, title: task.title, result: resultText },
  );
}

async function handleGrantDelegation(
  input: Record<string, unknown>,
  ctx: DelegationToolContext,
): Promise<ToolResult> {
  const delegatorName = stringArg(input.delegator);
  const specialistName = stringArg(input.specialist);
  if (!delegatorName || !specialistName) {
    return toolError("grant_delegation requires `delegator` and `specialist`");
  }

  const [delegator, specialist] = await Promise.all([
    loadAgentByName(ctx, delegatorName),
    loadAgentByName(ctx, specialistName),
  ]);
  if (!delegator) return toolError(`no agent named '${delegatorName}' found`);
  if (!specialist) return toolError(`no agent named '${specialistName}' found`);

  const result = await ctx.delegationService.handleGrantDelegation({
    householdId: ctx.householdId,
    delegatorId: delegator.id,
    specialistId: specialist.id,
  });
  if (!result.ok) return toolError(result.error);
  return toolOk(
    result.created
      ? `Granted ${delegatorName} access to delegate to ${specialistName}.`
      : `${delegatorName} already had access to ${specialistName} — no change.`,
    { created: result.created },
  );
}

async function handleRevokeDelegation(
  input: Record<string, unknown>,
  ctx: DelegationToolContext,
): Promise<ToolResult> {
  const delegatorName = stringArg(input.delegator);
  const specialistName = stringArg(input.specialist);
  if (!delegatorName || !specialistName) {
    return toolError("revoke_delegation requires `delegator` and `specialist`");
  }

  const [delegator, specialist] = await Promise.all([
    loadAgentByName(ctx, delegatorName),
    loadAgentByName(ctx, specialistName),
  ]);
  if (!delegator) return toolError(`no agent named '${delegatorName}' found`);
  if (!specialist) return toolError(`no agent named '${specialistName}' found`);

  const result = await ctx.delegationService.handleRevokeDelegation({
    householdId: ctx.householdId,
    delegatorId: delegator.id,
    specialistId: specialist.id,
  });
  if (!result.ok) return toolError(result.error);
  return toolOk(
    result.removed
      ? `Revoked ${delegatorName}'s access to ${specialistName}. In-flight tasks continue; new delegations will be rejected.`
      : `${delegatorName} did not have access to ${specialistName} — nothing to revoke.`,
    { removed: result.removed },
  );
}

/** Scoped-to-household lookup by name, case-insensitive. Mirrors the
 * DelegationService's internal lookup so grant/revoke can resolve the same
 * names agents type. */
async function loadAgentByName(
  ctx: DelegationToolContext,
  name: string,
): Promise<{ id: string; name: string; staffRole: string; isHeadButler: boolean } | null> {
  const { staffAgents } = await import("@carsonos/db");
  const { and, eq } = await import("drizzle-orm");
  const [hit] = await ctx.db
    .select({ id: staffAgents.id, name: staffAgents.name, staffRole: staffAgents.staffRole, isHeadButler: staffAgents.isHeadButler })
    .from(staffAgents)
    .where(
      and(
        eq(staffAgents.householdId, ctx.householdId),
        eq(staffAgents.name, name),
        eq(staffAgents.status, "active"),
      ),
    )
    .limit(1);
  if (hit) return hit;
  const all = await ctx.db
    .select({ id: staffAgents.id, name: staffAgents.name, staffRole: staffAgents.staffRole, isHeadButler: staffAgents.isHeadButler })
    .from(staffAgents)
    .where(
      and(
        eq(staffAgents.householdId, ctx.householdId),
        eq(staffAgents.status, "active"),
      ),
    );
  return all.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? null;
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
