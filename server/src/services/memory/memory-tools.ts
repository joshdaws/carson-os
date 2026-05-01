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
    name: "create_memory",
    description:
      "Create a NEW memory. Always search_memory first — if any existing memory covers the same person/project/topic, use update_memory instead. Use 'personal' scope for the member you're talking to, 'household' for things affecting the whole family. The 14 types: fact (verifiable claim), preference (taste/value), event (one-shot dated happening), routine (recurring pattern), decision (moment-in-time choice), commitment (active promise), goal (aspiration), skill (capability), person (human entity), project (multi-step effort), media (book/movie/etc), place (location), relationship (connection between two), concept (mental model/family value).",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [
            "fact", "preference", "event", "decision", "commitment",
            "person", "project", "media", "place", "routine",
            "relationship", "goal", "skill", "concept",
          ],
          description: "The type of memory to create.",
        },
        title: {
          type: "string",
          description:
            "Short, descriptive title (e.g., 'Elsie soccer practice schedule').",
        },
        content: {
          type: "string",
          description:
            "The full memory content. Be detailed enough to be useful later. Don't include a `# heading` line — storage adds that.",
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
            "Additional structured fields (topics, date, status, etc.). See memory schema for fields per type.",
        },
      },
      required: ["type", "title", "content"],
    },
  },
  {
    name: "update_memory",
    description:
      "Update an existing memory by APPENDING new content to it. For entity types (person/project/place/media/relationship/commitment/goal/concept), the content lands as a new atom in the Timeline section with provenance — the original is preserved (atoms-canonical). For flat types (fact/preference/event/decision/routine/skill), the content REPLACES the body. Either way, the entity is marked dirty so the compiled view re-renders shortly. Use this for: a) new info about an existing entity ('AD also writes a Substack' → atom append), or b) correcting a wrong fact (set importance=10 to flag as a correction). For 'throw it all out, the whole memory was wrong' use replace_memory instead.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The memory ID to update (from search_memory results).",
        },
        collection: {
          type: "string",
          description:
            "Which collection the memory is in. Matches the collection name from search results.",
        },
        content: {
          type: "string",
          description:
            "The new info to append (entity types) or the new body (flat types). Don't include a `# heading` line.",
        },
        importance: {
          type: "number",
          description:
            "Atom importance 1-10 (default 5). Use 10 for corrections — they get top-billing in the compiled view above the line.",
        },
        reason: {
          type: "string",
          description:
            "Optional. Why you're updating (e.g., 'Josh corrected spelling', 'parent verified', 'new info from today'). Surfaces in the atom block.",
        },
        frontmatter: {
          type: "object",
          description:
            "Optional frontmatter fields to merge (extend topics, set aliases, etc.). Shallow merge — arrays are replaced wholesale.",
        },
      },
      required: ["id", "collection", "content"],
    },
  },
  {
    name: "replace_memory",
    description:
      "WHOLESALE replace an existing memory. Throws away all prior content (including the atom timeline for entity types) and writes the new body in its place. Use only when the prior memory was completely wrong or no longer represents anything worth keeping — e.g., the user says 'no, you got that totally wrong, let me restart this entry.' For routine corrections to a single fact, use update_memory with importance=10 instead. The frontmatter (id, type, created, etc.) is preserved.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The memory ID to replace.",
        },
        collection: {
          type: "string",
          description: "Which collection the memory is in.",
        },
        content: {
          type: "string",
          description:
            "The new body, replacing whatever was there. Don't include a `# heading` line.",
        },
        title: {
          type: "string",
          description: "Optional new title.",
        },
        frontmatter: {
          type: "object",
          description: "Optional frontmatter fields to merge.",
        },
      },
      required: ["id", "collection", "content"],
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
  {
    name: "get_backlinks",
    description:
      "List the memories that reference a given slug via `[[wikilink]]` syntax. Useful when answering 'who/what is connected to X?' or surfacing context the user didn't explicitly ask for. Returns up to 20 backlinks with the type of relationship (parent, spouse, friend, lives_at, works_at, attends_school, likes, or generic 'references').",
    input_schema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description:
            "The memory slug to find backlinks for (e.g., 'grant-daws', 'lincoln-elementary'). Slug format: kebab-case lowercase, no slashes/dots/underscores.",
        },
      },
      required: ["slug"],
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
        case "create_memory":
        case "save_memory": // legacy alias — remove after one release
          result = await handleCreateMemory(ctx, input);
          break;
        case "update_memory":
          result = await handleUpdateMemory(ctx, input);
          break;
        case "replace_memory":
          result = await handleReplaceMemory(ctx, input);
          break;
        case "delete_memory":
          result = await handleDeleteMemory(ctx, input);
          break;
        case "read_memory":
          result = await handleReadMemory(ctx, input);
          break;
        case "get_backlinks":
          result = await handleGetBacklinks(ctx, input);
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

async function handleCreateMemory(
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

  // For entity types, give the file the v5 two-layer skeleton (placeholder
  // compiled view + Timeline + first atom) so subsequent updates append
  // cleanly. Flat types get a plain body.
  const body = isEntityType(type) ? wrapAsEntitySkeleton(content, ctx.memberName) : content;

  const { id, filePath } = await ctx.memoryProvider.save(collection, {
    type,
    title,
    content: body,
    frontmatter,
  });

  return {
    content: `Memory created: "${title}" (id: ${id}) in ${collection}. File: ${filePath}`,
  };
}

/**
 * Update an existing memory by APPENDING new content. For entity types
 * the content lands as a new atom in the Timeline section with full
 * provenance; the original is preserved (atoms-canonical). For flat
 * types the content REPLACES the body.
 */
async function handleUpdateMemory(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const id = input.id as string;
  const collection = input.collection as string;
  const content = input.content as string;
  const importanceRaw = input.importance;
  const importance =
    typeof importanceRaw === "number" && importanceRaw >= 1 && importanceRaw <= 10
      ? Math.round(importanceRaw)
      : 5;
  const reason = input.reason as string | undefined;
  const incomingFrontmatter = (input.frontmatter as Record<string, unknown>) ?? {};

  if (ctx.allowedCollections && !ctx.allowedCollections.includes(collection)) {
    return { content: `You don't have access to the "${collection}" collection.`, is_error: true };
  }
  if (!content || content.trim().length === 0) {
    return { content: "update_memory requires `content`.", is_error: true };
  }

  const existing = await ctx.memoryProvider.read(collection, id);
  if (!existing) {
    return { content: `Memory "${id}" not found in collection "${collection}".`, is_error: true };
  }

  const type = String(existing.frontmatter.type ?? "");
  const isEntity = isEntityType(type);

  let newBody: string;
  if (isEntity) {
    // Atoms-canonical: append a new atom block. Source defaults to
    // 'agent' (this turn's source) — the worker uses 'enrichment-worker'
    // for its own appends; corrections set importance: 10.
    const today = new Date().toISOString().slice(0, 10);
    const source = importance === 10 ? "correction" : "agent";
    const atomBlock = formatAtomBlock(today, source, ctx.memberName, importance, reason, content.trim());
    newBody = existing.content.replace(/\s*$/, "") + "\n\n" + atomBlock + "\n";
  } else {
    // Flat types: replace body wholesale.
    newBody = content;
  }

  const newFrontmatter = {
    ...incomingFrontmatter,
    ...(importance === 10 ? { last_corrected_at: new Date().toISOString().slice(0, 10) } : {}),
  };

  const { id: updatedId, filePath } = await ctx.memoryProvider.update(
    collection,
    id,
    { content: newBody, frontmatter: newFrontmatter },
  );

  return {
    content: `Memory updated: "${existing.title}" (id: ${updatedId}) in ${collection}.${isEntity ? ` Atom appended (importance: ${importance}).` : ""} File: ${filePath}`,
  };
}

/**
 * Wholesale replace an existing memory's body. Frontmatter is merged.
 * For entity types this throws away the prior atom timeline — only use
 * when the prior memory was completely wrong. Marks dirty.
 */
async function handleReplaceMemory(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const id = input.id as string;
  const collection = input.collection as string;
  const content = input.content as string;
  const title = input.title as string | undefined;
  const frontmatter = input.frontmatter as Record<string, unknown> | undefined;

  if (ctx.allowedCollections && !ctx.allowedCollections.includes(collection)) {
    return { content: `You don't have access to the "${collection}" collection.`, is_error: true };
  }
  if (!content || content.trim().length === 0) {
    return { content: "replace_memory requires `content`.", is_error: true };
  }

  const existing = await ctx.memoryProvider.read(collection, id);
  if (!existing) {
    return { content: `Memory "${id}" not found in collection "${collection}".`, is_error: true };
  }

  const type = String(existing.frontmatter.type ?? "");
  const isEntity = isEntityType(type);

  // For entity types, wrap the new body in the v5 two-layer skeleton —
  // placeholder + `---` + Timeline + first atom carrying the new content.
  const newBody = isEntity
    ? wrapAsEntitySkeleton(content, ctx.memberName)
    : content;

  const { id: updatedId, filePath } = await ctx.memoryProvider.update(
    collection,
    id,
    { title, content: newBody, frontmatter },
  );

  return {
    content: `Memory replaced: "${title ?? existing.title}" (id: ${updatedId}) in ${collection}. Prior content discarded. File: ${filePath}`,
  };
}

// ── Atom + entity helpers ───────────────────────────────────────────

const ENTITY_TYPES = new Set([
  "person", "project", "place", "media",
  "relationship", "commitment", "goal", "concept",
]);

function isEntityType(type: string): boolean {
  return ENTITY_TYPES.has(type);
}

function formatAtomBlock(
  date: string,
  source: string,
  by: string,
  importance: number,
  reason: string | undefined,
  content: string,
): string {
  const header = `### ${date} | source: ${source} | by: ${by} | importance: ${importance}`;
  const reasonLine = reason ? `\n_Reason:_ ${reason}\n` : "";
  return `${header}${reasonLine}\n${content}`;
}

function wrapAsEntitySkeleton(content: string, memberName: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const atomBlock = formatAtomBlock(today, "manual", memberName, 5, undefined, content);
  return [
    "(Compiled view — provisional. The compilation agent regenerates this from the atoms below shortly. Until then, treat the timeline below as canonical.)",
    "",
    "---",
    "",
    "## Timeline",
    "",
    atomBlock,
  ].join("\n");
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

/** List memories that reference a given slug via [[wikilink]]. */
async function handleGetBacklinks(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const slug = input.slug as string;
  if (!slug || slug.trim().length === 0) {
    return { content: "Slug cannot be empty.", is_error: true };
  }

  const { getBacklinks } = await import("./memory-links.js");
  const backlinks = await getBacklinks(ctx.db, slug);

  if (backlinks.length === 0) {
    return { content: `No backlinks found for "${slug}".` };
  }

  const limited = backlinks.slice(0, 20);
  const lines = limited.map(
    (b) => `- [${b.fromCollection}] ${b.fromSlug} (${b.linkType}${b.source !== "markdown" ? `, source: ${b.source}` : ""})`,
  );
  const more = backlinks.length > 20 ? `\n\n(${backlinks.length - 20} more not shown)` : "";

  return {
    content: `${backlinks.length} memory/memories link to "${slug}":\n\n${lines.join("\n")}${more}`,
  };
}

