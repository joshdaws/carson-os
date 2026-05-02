/**
 * Agent management tools.
 *
 * Two tiers:
 *   Self-management (any agent):
 *     - update_instructions, update_personality, update_role
 *
 *   Staff management (Chief of Staff only):
 *     - create_agent, delete_agent, list_agents
 *     - update_agent_assignment, pause_agent, resume_agent
 */

import { eq, and } from "drizzle-orm";
import type { ToolDefinition, ToolResult } from "@carsonos/shared";
import type { Db } from "@carsonos/db";
import { staffAgents, staffAssignments, familyMembers, scheduledTasks } from "@carsonos/db";
import type { MultiRelayManager } from "./multi-relay-manager.js";
import type { ToolRegistry } from "./tool-registry.js";

const OPERATING_INSTRUCTIONS_CAP = 2000;

export interface AgentToolContext {
  db: Db;
  agentId: string;
  memberId: string;
  memberName: string;
  householdId: string;
  isChiefOfStaff?: boolean;
  multiRelay?: MultiRelayManager;
  /** Required for grant/revoke tools. Optional because the type is shared with
   *  a few other call paths that don't need it. */
  toolRegistry?: ToolRegistry;
  /** Data dir root. When set, identity-mutating handlers (update_personality)
   *  also write to PERSONALITY.md so file-based reads stay consistent.
   *  Optional during the v0.5.0 transition. */
  dataDir?: string;
}

// ── Tool definitions ──────────────────────────────────────────────

// Self-management tools (every agent)
export const SELF_TOOLS: ToolDefinition[] = [
  {
    name: "update_instructions",
    description:
      "Update your own operating instructions — personal notes about how to behave. Add observations like 'Josh prefers bullet points' or 'Never suggest pork recipes'. Use proactively when you notice a preference or someone says 'don't ever do that again'.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "replace"], description: "'add' appends. 'replace' rewrites entirely." },
        content: { type: "string", description: "The instruction to add or the full replacement document." },
      },
      required: ["action", "content"],
    },
  },
  {
    name: "update_personality",
    description:
      "Update your own personality — tone, style, character. Use when your assigned member asks: 'be more casual', 'drop the Rocky thing', 'I want you to be like a coach'. Takes effect next conversation.",
    input_schema: {
      type: "object",
      properties: {
        personality: { type: "string", description: "Complete new personality. Write in second person: 'You are warm and casual...'" },
        reason: { type: "string", description: "Why this changed (logged for family visibility)." },
      },
      required: ["personality"],
    },
  },
  {
    name: "update_role",
    description:
      "Update your own role — what you focus on. Use when your member asks: 'help me with music, not homework', 'be more of a creative partner'. Takes effect next conversation.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string", description: "Complete new role. Write in second person: 'You help Grant with music production...'" },
        reason: { type: "string", description: "Why this changed (logged for family visibility)." },
      },
      required: ["role"],
    },
  },
];

// Staff management tools (Chief of Staff only)
export const STAFF_TOOLS: ToolDefinition[] = [
  {
    name: "list_agents",
    description:
      "List all agents in the household with their roles, assignments, status, and trust level. Use when someone asks 'what agents do we have?' or before creating/modifying agents.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_agent",
    description:
      "Create a new agent for the household. Use when a parent says 'set up a tutor for Claire' or 'we need a fitness coach'. Sets up the agent with a role and assigns it to a member.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name (e.g., 'Ms. Hughes', 'Coach K')." },
        staff_role: { type: "string", enum: ["personal", "tutor", "coach", "scheduler", "custom"], description: "Agent type." },
        role_content: { type: "string", description: "What this agent does. Write in second person." },
        assign_to_member: { type: "string", description: "Name of the family member to assign this agent to." },
        trust_level: { type: "string", enum: ["full", "standard", "restricted"], description: "Tool access level. 'restricted' for kids, 'standard' for teens, 'full' for parents. Default: 'restricted'." },
      },
      required: ["name", "staff_role", "role_content", "assign_to_member"],
    },
  },
  {
    name: "delete_agent",
    description:
      "Delete an agent permanently. Use when someone says 'we don't need the tutor anymore'. Cannot delete the Chief of Staff.",
    input_schema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Name of the agent to delete." },
      },
      required: ["agent_name"],
    },
  },
  {
    name: "pause_agent",
    description:
      "Pause an agent — stops its Telegram bot and prevents it from running. Less destructive than deleting. Use: 'take Django offline for now'.",
    input_schema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Name of the agent to pause." },
      },
      required: ["agent_name"],
    },
  },
  {
    name: "resume_agent",
    description:
      "Resume a paused agent — restarts its Telegram bot. Use: 'bring Django back online'.",
    input_schema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Name of the agent to resume." },
      },
      required: ["agent_name"],
    },
  },
  {
    name: "update_agent_assignment",
    description:
      "Change which family members an agent serves. Use: 'assign Django to Grant too', 'remove Carson from Claire'.",
    input_schema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Name of the agent." },
        action: { type: "string", enum: ["assign", "remove"], description: "'assign' adds a member, 'remove' removes one." },
        member_name: { type: "string", description: "Name of the family member." },
      },
      required: ["agent_name", "action", "member_name"],
    },
  },
  {
    name: "list_agent_tools",
    description:
      "List the tools another agent currently has access to. Use before granting/revoking to see what's already there. Example: list_agent_tools({ agent_name: 'Django' }).",
    input_schema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Name of the agent whose tools to list." },
      },
      required: ["agent_name"],
    },
  },
  {
    name: "grant_tool_to_agent",
    description:
      "Give another agent access to a tool. The tool can be a custom tool this household has created (e.g., 'ynab_list_budgets'), a built-in toggleable tool (e.g., 'list_calendar_events', 'gmail_triage'), or any tool name from list_custom_tools. Always tell the user which tool was granted and why. Example: grant_tool_to_agent({ agent_name: 'Django', tool_name: 'ynab_list_budgets', reason: 'Grant requested read-only budget access for his agent.' }). " +
      "IMPORTANT: Respect trust levels. Don't grant full-privilege tools (Bash, Write, Edit) to restricted agents (kids). If the target agent's trust level is 'restricted', pause and ask the user to confirm before granting write/execute tools.",
    input_schema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Name of the agent to grant the tool to." },
        tool_name: { type: "string", description: "Tool name exactly as it appears in list_custom_tools or the built-in tool set." },
        reason: { type: "string", description: "Short note explaining why this grant makes sense. Stored for audit." },
      },
      required: ["agent_name", "tool_name"],
    },
  },
  {
    name: "revoke_tool_from_agent",
    description:
      "Remove a tool from another agent's access. Example: revoke_tool_from_agent({ agent_name: 'Django', tool_name: 'ynab_update_category_budget', reason: 'Kid access should be read-only for now.' }).",
    input_schema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Name of the agent to revoke the tool from." },
        tool_name: { type: "string", description: "Tool name exactly as it's currently granted." },
        reason: { type: "string", description: "Short note explaining why revoked. Stored for audit." },
      },
      required: ["agent_name", "tool_name"],
    },
  },
];

/**
 * System-level tools — touch the host process (e.g., restart for an update).
 * Stricter trust gate than STAFF_TOOLS: requires CoS AND a parent-role member.
 * A kid asking the CoS to update CarsonOS gets politely refused; a parent
 * asking gets the actual restart.
 */
export const SYSTEM_TOOLS: ToolDefinition[] = [
  {
    name: "apply_system_update",
    description:
      "Apply the available CarsonOS update. Pulls main, installs dependencies, and restarts the family runtime. The host will go offline briefly during the restart; the family will see bots stop responding for ~30-60 seconds. Only call this when a parent has explicitly asked you to apply the update — kids cannot trigger it (the tool will refuse). Returns immediately with 'restart in progress'; the actual restart happens in a detached subprocess. After the restart you'll come back up and tell the family what changed (the boot path queues that announcement automatically).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

export const AGENT_TOOLS: ToolDefinition[] = [...SELF_TOOLS, ...STAFF_TOOLS, ...SYSTEM_TOOLS];

// ── Handler ───────────────────────────────────────────────────────

export async function handleAgentTool(
  ctx: AgentToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  // Gate staff management tools to Chief of Staff
  const staffToolNames = STAFF_TOOLS.map((t) => t.name);
  if (staffToolNames.includes(name) && !ctx.isChiefOfStaff) {
    return { content: "Only the Chief of Staff can manage other agents.", is_error: true };
  }

  // Gate system tools (apply_system_update) to CoS + parent-role member.
  // A kid chatting with Carson can't trigger the family runtime to restart;
  // they get a polite "ask a parent" refusal. The member-role lookup is
  // cheap and the refusal message tells the agent how to proceed.
  const systemToolNames = SYSTEM_TOOLS.map((t) => t.name);
  if (systemToolNames.includes(name)) {
    if (!ctx.isChiefOfStaff) {
      return {
        content:
          "apply_system_update is only available to the Chief of Staff. Personal agents can ask CoS to apply the update on their member's behalf, but only if a parent is asking.",
        is_error: true,
      };
    }
    // Scope the lookup with householdId — defense-in-depth so a CoS in
    // household A can never authorize an update on behalf of a member from
    // household B even if memberId somehow gets crossed. Single-family
    // CarsonOS rarely sees this race, but the guard is one extra clause.
    const [member] = await ctx.db
      .select({ role: familyMembers.role, name: familyMembers.name })
      .from(familyMembers)
      .where(and(
        eq(familyMembers.id, ctx.memberId),
        eq(familyMembers.householdId, ctx.householdId),
      ))
      .limit(1);
    if (!member) {
      return { content: "Could not resolve the requesting member.", is_error: true };
    }
    if (member.role !== "parent") {
      return {
        content: `${member.name} is a ${member.role}, not a parent. Updates can only be applied at a parent's request — politely tell them to ask a parent instead.`,
        is_error: true,
      };
    }
  }

  switch (name) {
    case "update_instructions": return handleUpdateInstructions(ctx, input);
    case "update_personality": return handleUpdatePersonality(ctx, input);
    case "update_role": return handleUpdateRole(ctx, input);
    case "list_agents": return handleListAgents(ctx);
    case "create_agent": return handleCreateAgent(ctx, input);
    case "delete_agent": return handleDeleteAgent(ctx, input);
    case "pause_agent": return handlePauseResume(ctx, input, "paused");
    case "resume_agent": return handlePauseResume(ctx, input, "active");
    case "update_agent_assignment": return handleUpdateAssignment(ctx, input);
    case "list_agent_tools": return handleListAgentTools(ctx, input);
    case "grant_tool_to_agent": return handleGrantToolToAgent(ctx, input);
    case "revoke_tool_from_agent": return handleRevokeToolFromAgent(ctx, input);
    case "apply_system_update": return handleApplySystemUpdate(ctx);
    default: return { content: `Unknown agent tool: ${name}`, is_error: true };
  }
}

// ── apply_system_update handler ────────────────────────────────────

/**
 * Apply the pending CarsonOS update by writing a `update_pending` state
 * row and spawning `./scripts/update-service.sh` as a detached subprocess.
 *
 * The detached spawn matters: the script will eventually run
 * `launchctl bootstrap` to restart `com.carsonos.server`, which kills THIS
 * process. By detaching with `stdio: 'ignore'` we ensure the script
 * survives the parent exit and completes the restart.
 *
 * The handler returns immediately with "restart in progress" so the
 * agent has a final response to give the user before their session dies.
 * The post-restart announcement (TODO-3.5) is what closes the loop in
 * voice on the new instance.
 */
async function handleApplySystemUpdate(ctx: AgentToolContext): Promise<ToolResult> {
  // Resolve which update we're applying. Read the live state — don't
  // trust the agent's prompt-bound copy of from/to, which could be stale
  // if the user reshipped between the CoS reading the prompt and calling
  // the tool.
  const { readUpdateAvailable, writeUpdatePending } = await import(
    "./system-update-check.js"
  );
  const available = await readUpdateAvailable(ctx.db);
  if (!available) {
    return {
      content:
        "No CarsonOS update is currently available. The update-check may not have run yet, or the system is already current. Try again later or ask the user if there's an update they're expecting.",
      is_error: true,
    };
  }

  // Locate the script. Resolve from the running server's __dirname so
  // we work both in tsx-watch (running from server/src/) and after a
  // tsc build (running from server/dist/). The script lives at the repo
  // root: server/src/services/.. → repo root.
  const { spawn } = await import("node:child_process");
  const { join } = await import("node:path");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const scriptPath = join(import.meta.dirname, "..", "..", "..", "scripts", "update-service.sh");

  // Capture the script's stdout + stderr to a timestamped log so partial
  // failures (git pull error, pnpm install error, launchctl kickstart
  // error) leave a forensic trail. Without this redirect the script
  // ran with stdio:'ignore' and no logs landed anywhere — debugging
  // a half-applied update would require re-running the script by hand.
  const logDir = join(os.homedir(), ".carsonos", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const tsForFile = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = join(logDir, `update-${tsForFile}.log`);

  // Spawn FIRST. Only after the OS confirms the child started do we
  // write update_pending — otherwise a missing/EACCES script would
  // leave a poison row in instance_settings that makes the next CoS
  // turn re-propose the update against a system that won't apply it.
  let child: ReturnType<typeof spawn>;
  try {
    const logFd = fs.openSync(logPath, "a");
    child = spawn(scriptPath, [], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    // The fd is now owned by the spawned child via dup2 inside spawn —
    // close our reference so the parent doesn't keep it open.
    fs.closeSync(logFd);
  } catch (err) {
    return {
      content: `Failed to spawn update script: ${err instanceof Error ? err.message : String(err)}. No update was triggered. Verify ${scriptPath} exists and is executable.`,
      is_error: true,
    };
  }

  // Spawn succeeded (the OS reported a pid). Now persist update_pending
  // so the post-restart announcement can fire. Re-read update_available
  // immediately before the write to pick up any concurrent scheduler-
  // tick rewrite — e.g., main bumped from 0.5.1 to 0.5.2 between our
  // pre-spawn read and now. The script is going to git-pull main, so
  // the freshest known `to` matches what we'll actually land on; using
  // the stale snapshot would make announceUpdateApplied see
  // cmp(current, pending.to) > 0 on the post-restart boot and skip the
  // announcement. If the row was cleared between read and re-read (the
  // tick decided we're current — rare, only if local VERSION moved),
  // fall back to the snapshot since spawn already kicked off and we
  // still want the announcement to fire. SQLite is single-writer, so
  // re-reading right before write narrows the race window to negligible.
  // If this write fails, the update will still apply but the new
  // instance won't know to announce it — log loudly.
  try {
    const fresh = await readUpdateAvailable(ctx.db);
    const target = fresh ?? available;
    await writeUpdatePending(ctx.db, {
      from: target.from,
      to: target.to,
      changelogExcerpt: target.changelogExcerpt,
      requestedAt: new Date().toISOString(),
      householdId: ctx.householdId,
      requestedByMemberId: ctx.memberId,
    });
  } catch (err) {
    console.error(
      `[apply-update] CRITICAL: spawn succeeded but writeUpdatePending failed:`,
      err,
      `— the restart will proceed but the post-restart announcement will not fire.`,
    );
    // Don't abort — the update IS in flight, the user just won't get
    // the in-voice announcement on the new instance.
  }

  console.log(
    `[apply-update] kicked off update v${available.from} → v${available.to} (requested by member ${ctx.memberId}) — pid ${child.pid}, log ${logPath}`,
  );

  return {
    content: `Restart in progress. Pulling main, installing dependencies, and restarting com.carsonos.server. Tell ${ctx.memberName} the family runtime will be offline briefly (about 30-60 seconds) while it updates from v${available.from} to v${available.to}, then comes back up. After the restart, you'll automatically tell them what changed. (Script log: ${logPath})`,
  };
}

// ── Self-management handlers ──────────────────────────────────────

async function handleUpdateInstructions(ctx: AgentToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const action = input.action as "add" | "replace";
  const content = input.content as string;

  const [agent] = await ctx.db
    .select({ operatingInstructions: staffAgents.operatingInstructions })
    .from(staffAgents)
    .where(eq(staffAgents.id, ctx.agentId))
    .limit(1);

  let newInstructions: string;
  if (action === "replace") {
    newInstructions = content.slice(0, OPERATING_INSTRUCTIONS_CAP);
  } else {
    const current = agent?.operatingInstructions ?? "";
    const appended = current ? `${current}\n- ${content}` : `- ${content}`;
    newInstructions = appended.slice(0, OPERATING_INSTRUCTIONS_CAP);
  }

  await ctx.db.update(staffAgents).set({ operatingInstructions: newInstructions }).where(eq(staffAgents.id, ctx.agentId));
  return { content: `Operating instructions updated (${newInstructions.length}/${OPERATING_INSTRUCTIONS_CAP} chars).` };
}

async function handleUpdatePersonality(ctx: AgentToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const personality = input.personality as string;
  const reason = (input.reason as string) ?? "Updated by agent";
  if (!personality.trim()) return { content: "Personality cannot be empty.", is_error: true };

  await ctx.db.update(staffAgents).set({ soulContent: personality, updatedAt: new Date() }).where(eq(staffAgents.id, ctx.agentId));

  // Mirror into PERSONALITY.md when dataDir is plumbed (v0.5.0+). Reads
  // prefer the file; without this mirror, the next read would return
  // stale content. Best-effort — file errors don't fail the update.
  if (ctx.dataDir) {
    try {
      const [agent] = await ctx.db
        .select({ name: staffAgents.name })
        .from(staffAgents)
        .where(eq(staffAgents.id, ctx.agentId))
        .limit(1);
      if (agent) {
        const { writePersonalityMd, slugifyName } = await import("./identity-files.js");
        writePersonalityMd(ctx.dataDir, slugifyName(agent.name), personality);
      }
    } catch (err) {
      console.warn(`[agent-tools] Failed to mirror personality to PERSONALITY.md:`, err);
    }
  }

  console.log(`[agent-tools] Personality updated for agent ${ctx.agentId}: ${reason}`);
  return { content: `Personality updated. Takes effect next conversation.\nReason: ${reason}` };
}

async function handleUpdateRole(ctx: AgentToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const role = input.role as string;
  const reason = (input.reason as string) ?? "Updated by agent";
  if (!role.trim()) return { content: "Role cannot be empty.", is_error: true };

  await ctx.db.update(staffAgents).set({ roleContent: role, updatedAt: new Date() }).where(eq(staffAgents.id, ctx.agentId));
  console.log(`[agent-tools] Role updated for agent ${ctx.agentId}: ${reason}`);
  return { content: `Role updated. Takes effect next conversation.\nReason: ${reason}` };
}

// ── Helpers ────────────────────────────────────────────────────────

/** Case-insensitive agent lookup by name within household. Excludes soft-deleted agents. */
function findAgent(ctx: AgentToolContext, name: string) {
  const agents = ctx.db.select().from(staffAgents)
    .where(eq(staffAgents.householdId, ctx.householdId))
    .all()
    .filter((a) => a.status !== "deleted");
  return agents.find((a) => a.name === name) ?? agents.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/** Case-insensitive member lookup by name within household. */
function findMember(ctx: AgentToolContext, name: string) {
  const members = ctx.db.select().from(familyMembers).where(eq(familyMembers.householdId, ctx.householdId)).all();
  return members.find((m) => m.name === name) ?? members.find((m) => m.name.toLowerCase() === name.toLowerCase()) ?? null;
}

// ── Staff management handlers (Chief of Staff only) ───────────────

async function handleListAgents(ctx: AgentToolContext): Promise<ToolResult> {
  const agents = ctx.db
    .select()
    .from(staffAgents)
    .where(eq(staffAgents.householdId, ctx.householdId))
    .all();

  if (agents.length === 0) return { content: "No agents found." };

  const lines = await Promise.all(agents.map(async (a) => {
    const assignments = ctx.db
      .select({ memberName: familyMembers.name })
      .from(staffAssignments)
      .innerJoin(familyMembers, eq(familyMembers.id, staffAssignments.memberId))
      .where(eq(staffAssignments.agentId, a.id))
      .all();

    const assignedTo = assignments.map((x) => x.memberName).join(", ") || "unassigned";
    const isHead = a.isHeadButler ? " (Chief of Staff)" : "";
    return `- ${a.name}${isHead} — ${a.staffRole}, ${a.status}, trust: ${a.trustLevel}\n  Assigned to: ${assignedTo}`;
  }));

  return { content: `${agents.length} agent(s):\n\n${lines.join("\n\n")}` };
}

async function handleCreateAgent(ctx: AgentToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const name = (input.name as string)?.trim();
  const staffRole = input.staff_role as string;
  const roleContent = (input.role_content as string)?.trim();
  const assignToMember = input.assign_to_member as string;
  const trustLevel = (input.trust_level as string) ?? "restricted";

  // Validate required fields
  if (!name) return { content: "Agent name cannot be empty.", is_error: true };
  if (!roleContent) return { content: "Role description cannot be empty.", is_error: true };

  // Validate staff_role — block head_butler (only one Chief of Staff allowed)
  const allowedRoles = ["personal", "tutor", "coach", "scheduler", "custom"];
  if (!allowedRoles.includes(staffRole)) {
    return { content: `Invalid role "${staffRole}". Must be one of: ${allowedRoles.join(", ")}`, is_error: true };
  }

  // Validate trust_level
  const allowedTrust = ["full", "standard", "restricted"];
  if (!allowedTrust.includes(trustLevel)) {
    return { content: `Invalid trust level "${trustLevel}". Must be one of: ${allowedTrust.join(", ")}`, is_error: true };
  }

  // Check for duplicate name
  const existing = findAgent(ctx, name);
  if (existing) return { content: `An agent named "${name}" already exists.`, is_error: true };

  // Fix #5: case-insensitive member lookup
  const member = findMember(ctx, assignToMember);
  if (!member) return { content: `Family member "${assignToMember}" not found.`, is_error: true };

  const [agent] = await ctx.db
    .insert(staffAgents)
    .values({ householdId: ctx.householdId, name, staffRole, roleContent, trustLevel, visibility: "family" })
    .returning();

  await ctx.db.insert(staffAssignments).values({ agentId: agent.id, memberId: member.id, relationship: "primary" });

  return { content: `Agent "${name}" created (${staffRole}, trust: ${trustLevel}) and assigned to ${member.name}.` };
}

async function handleDeleteAgent(ctx: AgentToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const agentName = input.agent_name as string;

  const agent = findAgent(ctx, agentName);
  if (!agent) return { content: `Agent "${agentName}" not found.`, is_error: true };
  if (agent.isHeadButler) return { content: "Cannot delete the Chief of Staff.", is_error: true };
  // Fix #9: prevent self-deletion
  if (agent.id === ctx.agentId) return { content: "You cannot delete yourself.", is_error: true };

  // Fix #3: soft delete — set status to "deleted" instead of removing rows.
  // Preserves conversation history, activity logs, and audit trail.
  // Scheduled tasks for this agent are disabled.
  await ctx.db.update(staffAgents).set({ status: "deleted", updatedAt: new Date() }).where(eq(staffAgents.id, agent.id));

  // Disable any scheduled tasks for this agent
  ctx.db.update(scheduledTasks).set({ enabled: false }).where(eq(scheduledTasks.agentId, agent.id)).run();

  // Remove assignments (so they don't show in the UI)
  ctx.db.delete(staffAssignments).where(eq(staffAssignments.agentId, agent.id)).run();

  // Stop the bot if running
  if (ctx.multiRelay) {
    ctx.multiRelay.stopBot(agent.id).catch(() => {});
  }

  return { content: `Agent "${agent.name}" deactivated. Scheduled tasks disabled, assignments removed.` };
}

async function handlePauseResume(ctx: AgentToolContext, input: Record<string, unknown>, newStatus: string): Promise<ToolResult> {
  const agentName = input.agent_name as string;

  const agent = findAgent(ctx, agentName);
  if (!agent) return { content: `Agent "${agentName}" not found.`, is_error: true };
  if (agent.status === "deleted") return { content: `Agent "${agent.name}" has been deleted and cannot be ${newStatus === "paused" ? "paused" : "resumed"}.`, is_error: true };
  if (agent.isHeadButler && newStatus === "paused") return { content: "Cannot pause the Chief of Staff.", is_error: true };

  if (agent.status === newStatus) {
    return { content: `Agent "${agent.name}" is already ${newStatus}.` };
  }

  await ctx.db.update(staffAgents).set({ status: newStatus, updatedAt: new Date() }).where(eq(staffAgents.id, agent.id));

  // Stop/start the Telegram bot
  if (ctx.multiRelay) {
    if (newStatus === "paused") {
      await ctx.multiRelay.stopBot(agent.id).catch(() => {});
    } else if (newStatus === "active" && agent.telegramBotToken) {
      await ctx.multiRelay.startBot(agent.id).catch(() => {});
    }
  }

  // Disable/enable scheduled tasks to match agent status
  ctx.db.update(scheduledTasks)
    .set({ enabled: newStatus === "active" })
    .where(eq(scheduledTasks.agentId, agent.id))
    .run();

  return { content: `Agent "${agent.name}" ${newStatus === "paused" ? "paused — scheduled tasks disabled" : "resumed — scheduled tasks re-enabled"}.` };
}

async function handleUpdateAssignment(ctx: AgentToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const agentName = input.agent_name as string;
  const action = input.action as "assign" | "remove";
  const memberName = input.member_name as string;

  const agent = findAgent(ctx, agentName);
  if (!agent) return { content: `Agent "${agentName}" not found.`, is_error: true };

  const member = findMember(ctx, memberName);
  if (!member) return { content: `Family member "${memberName}" not found.`, is_error: true };

  if (action === "assign") {
    // Check if already assigned
    const existing = ctx.db
      .select()
      .from(staffAssignments)
      .where(and(eq(staffAssignments.agentId, agent.id), eq(staffAssignments.memberId, member.id)))
      .get();

    if (existing) return { content: `${agentName} is already assigned to ${memberName}.` };

    await ctx.db.insert(staffAssignments).values({
      agentId: agent.id,
      memberId: member.id,
      relationship: "secondary",
    });

    return { content: `${agentName} now also serves ${memberName}.` };
  } else {
    ctx.db.delete(staffAssignments)
      .where(and(eq(staffAssignments.agentId, agent.id), eq(staffAssignments.memberId, member.id)))
      .run();

    return { content: `${agentName} no longer serves ${memberName}.` };
  }
}

// ── Tool grant handlers (Chief of Staff only) ─────────────────────

async function handleListAgentTools(
  ctx: AgentToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const agentName = String(input.agent_name ?? "");
  const agent = findAgent(ctx, agentName);
  if (!agent) return { content: `Agent "${agentName}" not found.`, is_error: true };
  if (!ctx.toolRegistry) {
    return { content: "Tool registry not available in this context.", is_error: true };
  }

  // ToolRegistry.getAgentTools resolves role defaults + explicit grants into
  // the final set of ToolDefinitions the agent can actually call. That's the
  // right view here — matches what the agent sees in its own system prompt.
  const defs = await ctx.toolRegistry.getAgentTools(agent.id);
  if (defs.length === 0) {
    return { content: `${agent.name} has no granted tools. Trust level: ${agent.trustLevel}.` };
  }
  const lines = defs
    .map((d) => `- ${d.name}`)
    .sort()
    .join("\n");
  return {
    content: `${agent.name} (${agent.trustLevel} trust) has ${defs.length} tools:\n${lines}`,
  };
}

async function handleGrantToolToAgent(
  ctx: AgentToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const agentName = String(input.agent_name ?? "");
  const toolName = String(input.tool_name ?? "").trim();
  const reason = input.reason ? String(input.reason) : "No reason provided";

  if (!toolName) return { content: "tool_name is required.", is_error: true };
  const agent = findAgent(ctx, agentName);
  if (!agent) return { content: `Agent "${agentName}" not found.`, is_error: true };
  if (!ctx.toolRegistry) {
    return { content: "Tool registry not available in this context.", is_error: true };
  }
  if (agent.id === ctx.agentId) {
    return { content: "You already have all your own tools — grant to a different agent.", is_error: true };
  }

  try {
    await ctx.toolRegistry.grant(agent.id, toolName, ctx.agentId);
  } catch (err) {
    return {
      content: `Grant failed: ${(err as Error).message}. Confirm the tool exists (use list_custom_tools) and the agent name is spelled correctly.`,
      is_error: true,
    };
  }

  console.log(`[staff-tools] Grant: ${toolName} → ${agent.name} (by ${ctx.agentId}). Reason: ${reason}`);
  return {
    content: `Granted '${toolName}' to ${agent.name}. Available on their next message.\nReason logged: ${reason}`,
  };
}

async function handleRevokeToolFromAgent(
  ctx: AgentToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const agentName = String(input.agent_name ?? "");
  const toolName = String(input.tool_name ?? "").trim();
  const reason = input.reason ? String(input.reason) : "No reason provided";

  if (!toolName) return { content: "tool_name is required.", is_error: true };
  const agent = findAgent(ctx, agentName);
  if (!agent) return { content: `Agent "${agentName}" not found.`, is_error: true };
  if (!ctx.toolRegistry) {
    return { content: "Tool registry not available in this context.", is_error: true };
  }

  try {
    await ctx.toolRegistry.revoke(agent.id, toolName);
  } catch (err) {
    return {
      content: `Revoke failed: ${(err as Error).message}.`,
      is_error: true,
    };
  }

  console.log(`[staff-tools] Revoke: ${toolName} from ${agent.name} (by ${ctx.agentId}). Reason: ${reason}`);
  return {
    content: `Revoked '${toolName}' from ${agent.name}. Takes effect on their next message.\nReason logged: ${reason}`,
  };
}
