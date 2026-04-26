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

// ── Tool definitions (Anthropic SDK format) ────────────────────────

export const MEMORY_TOOLS: ToolDefinition[] = [
  {
    name: "search_memory",
    description:
      "Search your memory for relevant information. Use this before answering questions about the family, their preferences, past events, or commitments. Default scope 'both' searches the family member's personal memory and shared household memory together.",
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
          enum: ["personal", "household", "both", "all"],
          description:
            "Where to search. 'personal' = this member's memory. 'household' = shared family memory. 'both' = personal + household (default). 'all' = every family member's memory + household (Chief of Staff only). Use 'all' whenever the conversation mentions or asks about a different family member by name.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "save_memory",
    description:
      "Save something to memory. IMPORTANT: Always search_memory first to check for existing entries on the same topic. If one exists, use update_memory instead. Never create duplicates. Save only lasting facts worth remembering — not every conversational detail. Use 'personal' scope for things specific to this person (their preferences, their schedule, their goals). Use 'household' scope for things that affect the whole family (family events, shared decisions, household rules).",
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
    name: "update_memory",
    description:
      "Update an existing memory with new or corrected information. Use this instead of delete+save when a memory exists but needs to be enriched or corrected. Preserves the original entry and updates it in place — no data loss.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The memory ID to update (from search results).",
        },
        collection: {
          type: "string",
          description:
            "Which collection the memory is in. Matches the collection name from search results.",
        },
        title: {
          type: "string",
          description: "New title (optional — keeps existing if not provided).",
        },
        content: {
          type: "string",
          description:
            "New content (optional — keeps existing if not provided). Provide the full updated content, not just the diff.",
        },
        frontmatter: {
          type: "object",
          description:
            "Updated frontmatter fields to merge (optional). Only provided fields are changed.",
        },
      },
      required: ["id", "collection"],
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
    name: "read_memory",
    description:
      "Read the full content of a specific memory entry. Use after search_memory when the snippet preview isn't enough — for example, when the user asks for a URL, quote, or detail that lives inside the body of a memory rather than its title.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The memory ID to read (from a prior search_memory result).",
        },
        collection: {
          type: "string",
          description:
            "Which collection the memory lives in. Matches the collection name from search_memory results (e.g. 'josh', 'household').",
        },
      },
      required: ["id", "collection"],
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
  /** Whether this agent is the Chief of Staff (can search all collections) */
  isChiefOfStaff?: boolean;
  /** All member collection names in the household (for Chief of Staff "all" scope) */
  allMemberCollections?: string[];
  /** Collections this agent is allowed to read/write (for validation) */
  allowedCollections?: string[];
}

// ── Executor factory ───────────────────────────────────────────────


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
        case "update_memory":
          result = await handleUpdateMemory(ctx, input);
          break;
        case "delete_memory":
          result = await handleDeleteMemory(ctx, input);
          break;
        case "read_memory":
          result = await handleReadMemory(ctx, input);
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

  // "all" scope is only available to the Chief of Staff
  if (scope === "all" && !ctx.isChiefOfStaff) {
    return { content: "The 'all' search scope is only available to the Chief of Staff.", is_error: true };
  }

  const results: Array<{ id: string; title: string; snippet: string; score: number; collection: string }> = [];

  // "all" scope: Chief of Staff searches every member collection + household.
  // Default "both" stays narrow (current member + household) to avoid latency.
  if (scope === "all" && ctx.isChiefOfStaff && ctx.allMemberCollections) {
    const searches = ctx.allMemberCollections.map((col) =>
      ctx.memoryProvider.search(query, col, 3),
    );
    searches.push(ctx.memoryProvider.search(query, ctx.householdCollection, 3));
    const allResults = await Promise.all(searches);
    for (const r of allResults) {
      results.push(...r.entries);
    }
  } else {
    if (scope === "both") {
      const [personal, household] = await Promise.all([
        ctx.memoryProvider.search(query, ctx.memberCollection, 5),
        ctx.memoryProvider.search(query, ctx.householdCollection, 3),
      ]);
      results.push(...personal.entries, ...household.entries);
    } else if (scope === "personal") {
      const personal = await ctx.memoryProvider.search(query, ctx.memberCollection, 5);
      results.push(...personal.entries);
    } else if (scope === "household") {
      const household = await ctx.memoryProvider.search(query, ctx.householdCollection, 3);
      results.push(...household.entries);
    }
  }

  if (results.length === 0) {
    return { content: "No memories found matching that query." };
  }

  // Sort by score descending, take top results
  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, 10);

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

async function handleUpdateMemory(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const id = input.id as string;
  const collection = input.collection as string;
  const title = input.title as string | undefined;
  const content = input.content as string | undefined;
  const frontmatter = input.frontmatter as Record<string, unknown> | undefined;

  // Validate collection access
  if (ctx.allowedCollections && !ctx.allowedCollections.includes(collection)) {
    return { content: `You don't have access to the "${collection}" collection.`, is_error: true };
  }

  if (!title && !content && !frontmatter) {
    return { content: "Nothing to update — provide at least title, content, or frontmatter." };
  }

  const { id: updatedId, filePath } = await ctx.memoryProvider.update(
    collection,
    id,
    { title, content, frontmatter },
  );

  return {
    content: `Memory updated: "${title ?? updatedId}" (id: ${updatedId}) in ${collection}. File: ${filePath}`,
  };
}

async function handleDeleteMemory(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const id = input.id as string;
  const collection = input.collection as string;

  // Validate collection access
  if (ctx.allowedCollections && !ctx.allowedCollections.includes(collection)) {
    return { content: `You don't have access to the "${collection}" collection.`, is_error: true };
  }

  await ctx.memoryProvider.delete(collection, id);
  return { content: `Memory "${id}" deleted from ${collection}.` };
}

async function handleReadMemory(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const id = input.id as string;
  const collection = input.collection as string;

  if (ctx.allowedCollections && !ctx.allowedCollections.includes(collection)) {
    return { content: `You don't have access to the "${collection}" collection.`, is_error: true };
  }

  const entry = await ctx.memoryProvider.read(collection, id);
  if (!entry) {
    return { content: `Memory "${id}" not found in collection "${collection}".`, is_error: true };
  }

  const fmLines = Object.entries(entry.frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: ${v.join(", ")}`;
      return `${k}: ${String(v)}`;
    })
    .join("\n");

  return {
    content: `[${collection}] ${entry.title} (id: ${entry.id})\n\n--- frontmatter ---\n${fmLines}\n\n--- content ---\n${entry.content}`,
  };
}
