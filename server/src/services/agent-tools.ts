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

const OPERATING_INSTRUCTIONS_CAP = 2000;

export interface AgentToolContext {
  db: Db;
  agentId: string;
  memberId: string;
  memberName: string;
  householdId: string;
  isChiefOfStaff?: boolean;
  multiRelay?: MultiRelayManager;
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
];

export const AGENT_TOOLS: ToolDefinition[] = [...SELF_TOOLS, ...STAFF_TOOLS];

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
    default: return { content: `Unknown agent tool: ${name}`, is_error: true };
  }
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
