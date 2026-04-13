/**
 * Agent self-management tools.
 *
 * Tools that let agents modify themselves — personality, role, operating
 * instructions. Separate from memory (knowledge) and scheduling (tasks).
 *
 * Future: create_agent, delete_agent (Chief of Staff only).
 *
 * Trust gating:
 *   - update_personality, update_role: any agent, for its own assigned member
 *   - update_instructions: any agent (already exists in memory-tools, moved here)
 *   - create_agent: Chief of Staff only (future)
 */

import { eq } from "drizzle-orm";
import type { ToolDefinition, ToolResult } from "@carsonos/shared";
import type { Db } from "@carsonos/db";
import { staffAgents } from "@carsonos/db";

const OPERATING_INSTRUCTIONS_CAP = 2000;

export interface AgentToolContext {
  db: Db;
  agentId: string;
  memberId: string;
  memberName: string;
  householdId: string;
}

// ── Tool definitions ──────────────────────────────────────────────

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: "update_instructions",
    description:
      "Update your own operating instructions — your personal notes about how to behave with this family. Add observations like 'Josh prefers bullet points' or 'Never suggest pork recipes'. These persist across conversations and are injected into your system prompt. Use this proactively when you notice a preference or when someone says 'don't ever mention that again' or 'always do it this way'.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "replace"],
          description: "'add' appends a new instruction. 'replace' replaces the entire document.",
        },
        content: {
          type: "string",
          description: "For 'add': the new instruction to append. For 'replace': the full replacement document.",
        },
      },
      required: ["action", "content"],
    },
  },
  {
    name: "update_personality",
    description:
      "Update your own personality — how you communicate, your tone, style, and character. Use this when the person you're assigned to asks you to change how you act: 'be more casual', 'stop being so formal', 'I want you to be like a coach', 'drop the Rocky thing'. Write the full new personality description. This takes effect on the next conversation.",
    input_schema: {
      type: "object",
      properties: {
        personality: {
          type: "string",
          description: "The complete new personality description. Write in second person: 'You are warm and encouraging. You use casual language...' This replaces your current personality entirely.",
        },
        reason: {
          type: "string",
          description: "Brief note about why this changed (e.g., 'Grant asked for a more casual tone'). Logged for the family's visibility.",
        },
      },
      required: ["personality"],
    },
  },
  {
    name: "update_role",
    description:
      "Update your own role description — what you do and what you focus on. Use this when the person you're assigned to asks you to change your focus: 'I want you to help me with music, not homework', 'focus on my fitness goals', 'be more of a creative partner'. Write the full new role. This takes effect on the next conversation.",
    input_schema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          description: "The complete new role description. Write in second person: 'You help Grant with music production, songwriting, and creative projects...' This replaces your current role entirely.",
        },
        reason: {
          type: "string",
          description: "Brief note about why this changed. Logged for the family's visibility.",
        },
      },
      required: ["role"],
    },
  },
];

// ── Handlers ──────────────────────────────────────────────────────

export async function handleAgentTool(
  ctx: AgentToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "update_instructions": return handleUpdateInstructions(ctx, input);
    case "update_personality": return handleUpdatePersonality(ctx, input);
    case "update_role": return handleUpdateRole(ctx, input);
    default: return { content: `Unknown agent tool: ${name}`, is_error: true };
  }
}

async function handleUpdateInstructions(
  ctx: AgentToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
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

  await ctx.db
    .update(staffAgents)
    .set({ operatingInstructions: newInstructions })
    .where(eq(staffAgents.id, ctx.agentId));

  return {
    content: `Operating instructions updated (${newInstructions.length}/${OPERATING_INSTRUCTIONS_CAP} chars used).`,
  };
}

async function handleUpdatePersonality(
  ctx: AgentToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const personality = input.personality as string;
  const reason = (input.reason as string) ?? "Updated by agent";

  if (!personality.trim()) {
    return { content: "Personality cannot be empty.", is_error: true };
  }

  await ctx.db
    .update(staffAgents)
    .set({ soulContent: personality, updatedAt: new Date() })
    .where(eq(staffAgents.id, ctx.agentId));

  console.log(`[agent-tools] Personality updated for agent ${ctx.agentId}: ${reason}`);

  return {
    content: `Personality updated. This will take effect on our next conversation.\n\nReason: ${reason}`,
  };
}

async function handleUpdateRole(
  ctx: AgentToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const role = input.role as string;
  const reason = (input.reason as string) ?? "Updated by agent";

  if (!role.trim()) {
    return { content: "Role cannot be empty.", is_error: true };
  }

  await ctx.db
    .update(staffAgents)
    .set({ roleContent: role, updatedAt: new Date() })
    .where(eq(staffAgents.id, ctx.agentId));

  console.log(`[agent-tools] Role updated for agent ${ctx.agentId}: ${reason}`);

  return {
    content: `Role updated. This will take effect on our next conversation.\n\nReason: ${reason}`,
  };
}
