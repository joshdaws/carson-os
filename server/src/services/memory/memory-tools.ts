/**
 * Memory tool definitions + executor factory.
 *
 * Defines the Anthropic-format tool schemas for:
 *   - search_memory
 *   - save_memory
 *   - delete_memory
 *   - update_instructions
 *
 * The buildToolExecutor() factory creates an executor bound to a
 * specific agent/member context. It's passed into the adapter so the
 * tool_use loop can execute tools without knowing the details.
 */

import type {
  ToolDefinition,
  ToolResult,
  ToolExecutor,
  MemoryProvider,
  MemoryType,
} from "@carsonos/shared";
import type { Db } from "@carsonos/db";
import { staffAgents } from "@carsonos/db";
import { eq } from "drizzle-orm";

// ── Tool definitions (Anthropic SDK format) ────────────────────────

export const MEMORY_TOOLS: ToolDefinition[] = [
  {
    name: "search_memory",
    description:
      "Search your memory for relevant information. Use this before answering questions about the family, their preferences, past events, or commitments. Searches both the family member's personal memory and the shared household memory.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to search for. Be specific — use names, topics, dates.",
        },
        scope: {
          type: "string",
          enum: ["personal", "household", "both"],
          description:
            "Where to search. 'personal' = this member's memory. 'household' = shared family memory. 'both' = search both (default).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "save_memory",
    description:
      "Save something to memory. IMPORTANT: Always search_memory first to check for existing entries on the same topic. If one exists, delete it first, then save the updated version. Never create duplicates. Save only lasting facts worth remembering — not every conversational detail.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [
            "fact", "preference", "event", "decision", "commitment",
            "person", "project", "media", "place", "routine",
            "relationship", "goal", "skill",
          ],
          description: "The type of memory to save.",
        },
        title: {
          type: "string",
          description:
            "Short, descriptive title (e.g., 'Elsie soccer practice schedule').",
        },
        content: {
          type: "string",
          description:
            "The full memory content. Be detailed enough to be useful later.",
        },
        scope: {
          type: "string",
          enum: ["personal", "household"],
          description:
            "Where to save. 'personal' = this member's memory (default). 'household' = shared family memory.",
        },
        frontmatter: {
          type: "object",
          description:
            "Additional structured fields for this memory type (e.g., topics, date, status). See memory schema for available fields per type.",
        },
      },
      required: ["type", "title", "content"],
    },
  },
  {
    name: "delete_memory",
    description:
      "Delete an outdated or incorrect memory. Use the memory ID from search results.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The memory ID to delete (from search results).",
        },
        collection: {
          type: "string",
          description:
            "Which collection to delete from. Matches the collection name from search results.",
        },
      },
      required: ["id", "collection"],
    },
  },
  {
    name: "update_instructions",
    description:
      "Update your own operating instructions — your personal notes about how to behave with this family. Add observations like 'Josh prefers bullet points' or 'Never suggest pork recipes'. These persist across conversations and are injected into your system prompt.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "replace"],
          description:
            "'add' appends a new instruction. 'replace' replaces the entire document.",
        },
        content: {
          type: "string",
          description:
            "For 'add': the new instruction to append. For 'replace': the full replacement document.",
        },
      },
      required: ["action", "content"],
    },
  },
];

// ── Tool context ───────────────────────────────────────────────────

export interface ToolContext {
  db: Db;
  memoryProvider: MemoryProvider;
  agentId: string;
  memberId: string;
  memberName: string;
  householdId: string;
  /** The QMD collection name for this member's personal memory */
  memberCollection: string;
  /** The QMD collection name for shared household memory */
  householdCollection: string;
}

// ── Executor factory ───────────────────────────────────────────────

const OPERATING_INSTRUCTIONS_CAP = 2000; // ~500 tokens

/**
 * Build a tool executor bound to a specific agent + member context.
 * Returns both the executor function and an array that accumulates
 * tool call records (for activity logging).
 */
export function buildToolExecutor(
  ctx: ToolContext,
): { executor: ToolExecutor; calls: Array<{ name: string; input: Record<string, unknown>; result: ToolResult }> } {
  const calls: Array<{ name: string; input: Record<string, unknown>; result: ToolResult }> = [];

  const executor: ToolExecutor = async (name, input) => {
    let result: ToolResult;

    try {
      switch (name) {
        case "search_memory":
          result = await handleSearchMemory(ctx, input);
          break;
        case "save_memory":
          result = await handleSaveMemory(ctx, input);
          break;
        case "delete_memory":
          result = await handleDeleteMemory(ctx, input);
          break;
        case "update_instructions":
          result = await handleUpdateInstructions(ctx, input);
          break;
        default:
          result = { content: `Unknown tool: ${name}`, is_error: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { content: `Tool error: ${msg}`, is_error: true };
    }

    calls.push({ name, input, result });
    return result;
  };

  return { executor, calls };
}

// ── Tool handlers ──────────────────────────────────────────────────

async function handleSearchMemory(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const query = input.query as string;
  const scope = (input.scope as string) ?? "both";

  const results: Array<{ id: string; title: string; snippet: string; score: number; collection: string }> = [];

  if (scope === "personal" || scope === "both") {
    const personal = await ctx.memoryProvider.search(query, ctx.memberCollection, 5);
    results.push(...personal.entries);
  }

  if (scope === "household" || scope === "both") {
    const household = await ctx.memoryProvider.search(query, ctx.householdCollection, 3);
    results.push(...household.entries);
  }

  if (results.length === 0) {
    return { content: "No memories found matching that query." };
  }

  // Sort by score descending, take top results
  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, 8);

  const formatted = top
    .map(
      (r) =>
        `[${r.collection}] ${r.title} (id: ${r.id}, score: ${Math.round(r.score * 100)}%)\n${r.snippet}`,
    )
    .join("\n\n");

  return { content: formatted };
}

async function handleSaveMemory(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const type = input.type as MemoryType;
  const title = input.title as string;
  const content = input.content as string;
  const scope = (input.scope as string) ?? "personal";
  const frontmatter = (input.frontmatter as Record<string, unknown>) ?? {};

  const collection =
    scope === "household" ? ctx.householdCollection : ctx.memberCollection;

  // Add source metadata
  frontmatter.source = frontmatter.source ?? ctx.memberName;

  const { id, filePath } = await ctx.memoryProvider.save(collection, {
    type,
    title,
    content,
    frontmatter,
  });

  return {
    content: `Memory saved: "${title}" (id: ${id}) in ${collection}. File: ${filePath}`,
  };
}

async function handleDeleteMemory(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const id = input.id as string;
  const collection = input.collection as string;

  await ctx.memoryProvider.delete(collection, id);
  return { content: `Memory "${id}" deleted from ${collection}.` };
}

async function handleUpdateInstructions(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const action = input.action as "add" | "replace";
  const content = input.content as string;

  // Load current instructions
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

  const charCount = newInstructions.length;
  return {
    content: `Operating instructions updated (${charCount}/${OPERATING_INSTRUCTIONS_CAP} chars used).`,
  };
}
