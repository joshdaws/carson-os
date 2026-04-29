/**
 * Default memory schema — defines the 14 memory types agents can work with.
 *
 * Each type has a description (for the agent prompt) and frontmatter
 * fields (for structured YAML headers on markdown files). v5.0 adds the
 * `concept` type and a set of common fields (importance, corrects,
 * superseded_by) that apply to every memory regardless of type.
 *
 * Parents can override this schema in the dashboard (post-MVP).
 */

import type { MemorySchema } from "@carsonos/shared";

export const DEFAULT_MEMORY_SCHEMA: MemorySchema = {
  types: [
    {
      type: "fact",
      description: "Concrete information about the family or household",
      fields: [
        { name: "topics", type: "string[]", description: "Relevant topic tags" },
        { name: "source", type: "string", description: "Who provided this info" },
        { name: "confidence", type: "enum", enumValues: ["certain", "likely", "uncertain"], description: "How confident you are" },
      ],
    },
    {
      type: "preference",
      description: "Likes, dislikes, and ways of working",
      fields: [
        { name: "topics", type: "string[]", description: "Relevant topic tags" },
        { name: "strength", type: "enum", enumValues: ["strong", "moderate", "mild"], description: "How strong this preference is" },
      ],
    },
    {
      type: "event",
      description: "Things that happened — experiences, milestones, incidents",
      fields: [
        { name: "date", type: "date", description: "When it happened (YYYY-MM-DD)" },
        { name: "topics", type: "string[]", description: "Relevant topic tags" },
        { name: "participants", type: "string[]", description: "Who was involved" },
      ],
    },
    {
      type: "decision",
      description: "Choices the family has made",
      fields: [
        { name: "date", type: "date", description: "When decided (YYYY-MM-DD)" },
        { name: "topics", type: "string[]", description: "Relevant topic tags" },
        { name: "decidedBy", type: "string[]", description: "Who made the decision" },
        { name: "reasoning", type: "string", description: "Why this was decided" },
      ],
    },
    {
      type: "commitment",
      description: "Promises and obligations — things someone said they'd do",
      fields: [
        { name: "status", type: "enum", required: true, enumValues: ["open", "completed"], description: "Is this still active?" },
        { name: "owner", type: "string", description: "Who made the commitment" },
        { name: "dueDate", type: "date", description: "When it's due (YYYY-MM-DD)" },
        { name: "topics", type: "string[]", description: "Relevant topic tags" },
      ],
    },
    {
      type: "person",
      description: "Contact information and relationship notes for people outside the family",
      fields: [
        { name: "relationship", type: "string", description: "Relationship to the family" },
        { name: "contactInfo", type: "string", description: "Phone, email, etc." },
        { name: "topics", type: "string[]", description: "Relevant topic tags" },
      ],
    },
    {
      type: "project",
      description: "Ongoing efforts with status tracking",
      fields: [
        { name: "status", type: "enum", required: true, enumValues: ["active", "paused", "completed"], description: "Current project status" },
        { name: "owner", type: "string", description: "Who owns this project" },
        { name: "topics", type: "string[]", description: "Relevant topic tags" },
        { name: "startDate", type: "date", description: "When it started (YYYY-MM-DD)" },
      ],
    },
    {
      type: "media",
      description: "Books, movies, shows, articles, podcasts, games — content the family consumes",
      fields: [
        { name: "mediaType", type: "enum", required: true, enumValues: ["book", "movie", "show", "article", "podcast", "game", "music", "video"], description: "What kind of media" },
        { name: "creator", type: "string", description: "Author, director, artist, etc." },
        { name: "status", type: "enum", enumValues: ["watching", "reading", "finished", "want-to", "abandoned"], description: "Where are we with this" },
        { name: "opinion", type: "string", description: "What we thought of it" },
        { name: "recommendedBy", type: "string", description: "Who recommended it" },
        { name: "topics", type: "string[]", description: "Relevant topic tags" },
      ],
    },
    {
      type: "place",
      description: "Locations, restaurants, schools, doctors, travel destinations",
      fields: [
        { name: "locationType", type: "enum", enumValues: ["home", "restaurant", "school", "office", "doctor", "store", "church", "travel", "other"], description: "Kind of place" },
        { name: "address", type: "string", description: "Street address or general location" },
        { name: "associatedPeople", type: "string[]", description: "People connected to this place" },
        { name: "topics", type: "string[]", description: "Relevant topic tags" },
      ],
    },
    {
      type: "routine",
      description: "Recurring habits, schedules, and behavioral patterns",
      fields: [
        { name: "frequency", type: "enum", required: true, enumValues: ["daily", "weekly", "monthly", "seasonal", "as-needed"], description: "How often" },
        { name: "timeOfDay", type: "string", description: "When it happens (e.g., '6am', 'after school', 'evenings')" },
        { name: "dayOfWeek", type: "string[]", description: "Which days (e.g., ['Tuesday', 'Thursday'])" },
        { name: "associatedPeople", type: "string[]", description: "Who's involved" },
        { name: "active", type: "enum", enumValues: ["yes", "no"], description: "Is this still active" },
        { name: "topics", type: "string[]", description: "Relevant topic tags" },
      ],
    },
    {
      type: "relationship",
      description: "Connections between people — how two people relate to each other",
      fields: [
        { name: "person1", type: "string", required: true, description: "First person" },
        { name: "person2", type: "string", required: true, description: "Second person" },
        { name: "relationshipType", type: "enum", enumValues: ["family", "friend", "colleague", "neighbor", "coach", "teacher", "doctor", "other"], description: "Kind of relationship" },
        { name: "nature", type: "string", description: "Description of the relationship dynamics" },
        { name: "topics", type: "string[]", description: "Relevant topic tags" },
      ],
    },
    {
      type: "goal",
      description: "Aspirations and targets someone is working toward",
      fields: [
        { name: "status", type: "enum", required: true, enumValues: ["active", "achieved", "abandoned"], description: "Current status" },
        { name: "owner", type: "string", description: "Whose goal is this" },
        { name: "targetDate", type: "date", description: "When they want to achieve it (YYYY-MM-DD)" },
        { name: "progress", type: "string", description: "Current progress notes" },
        { name: "topics", type: "string[]", description: "Relevant topic tags" },
      ],
    },
    {
      type: "skill",
      description: "Things people know or are learning — capabilities and proficiency",
      fields: [
        { name: "person", type: "string", required: true, description: "Who has or is learning this skill" },
        { name: "proficiency", type: "enum", enumValues: ["beginner", "intermediate", "advanced", "expert"], description: "Current level" },
        { name: "status", type: "enum", enumValues: ["learning", "proficient", "rusty"], description: "Are they actively developing this" },
        { name: "topics", type: "string[]", description: "Relevant topic tags" },
      ],
    },
    {
      type: "concept",
      description: "A reusable mental model, framework, or family value that predates and outlasts specific decisions. New in v5.0. Distinct from `preference` (taste-shaped, individual), `decision` (a moment-in-time call), and `fact` (observable claim).",
      fields: [
        { name: "topics", type: "string[]", description: "Relevant topic tags" },
        { name: "scope", type: "enum", enumValues: ["household", "personal", "domain"], description: "Whose mental model is this" },
      ],
    },
  ],
  commonFields: [
    {
      name: "importance",
      type: "number",
      description: "Atom importance, 1–10 (default 5). Corrections are 10. The compilation agent top-bills high-importance atoms in the regenerable compiled view above the `---` line.",
    },
    {
      name: "corrects",
      type: "string",
      description: "Atom ID this entry corrects. Use the `correct_memory` tool when fixing a prior atom — it sets this field plus `importance: 10` and links the original via `superseded_by`.",
    },
    {
      name: "superseded_by",
      type: "string",
      description: "Atom ID that supersedes this entry. Set automatically when a correction lands.",
    },
    {
      name: "verbatim",
      type: "string",
      description: "Set to true when the body should be preserved exactly — never paraphrase. Pair with `verbatim_source` for attribution. A verbatim quote can be any type (decision, preference, concept, etc.) — verbatim is a field, not a type.",
    },
    {
      name: "verbatim_source",
      type: "string",
      description: "Who said the verbatim content. Required when `verbatim: true`.",
    },
  ],
};

/**
 * Build the "How to Use Memory" instructions that get injected into the
 * agent's system prompt. Describes the available types and their fields
 * so the agent knows what to pass to save_memory.
 */
export function buildMemorySchemaInstructions(schema: MemorySchema): string {
  const lines: string[] = [
    "You have access to a persistent memory system. Memory is NOT pre-loaded — you must search it yourself.",
    "When a topic comes up that you might have prior knowledge about, use `search_memory` to check.",
    "Search proactively: if someone mentions a person, project, event, or preference, search before responding.",
    "Save important facts, preferences, events, and commitments as you learn them.",
    "",
    "Available memory types and their frontmatter fields:",
    "",
  ];

  for (const t of schema.types) {
    lines.push(`**${t.type}** — ${t.description}`);
    for (const f of t.fields) {
      const req = f.required ? " (required)" : "";
      const vals = f.enumValues ? ` [${f.enumValues.join(", ")}]` : "";
      lines.push(`  - ${f.name}: ${f.type}${vals}${req} — ${f.description}`);
    }
    lines.push("");
  }

  if (schema.commonFields && schema.commonFields.length > 0) {
    lines.push("**Common fields** (apply to every memory type):");
    for (const f of schema.commonFields) {
      const req = f.required ? " (required)" : "";
      const vals = f.enumValues ? ` [${f.enumValues.join(", ")}]` : "";
      lines.push(`  - ${f.name}: ${f.type}${vals}${req} — ${f.description}`);
    }
    lines.push("");
  }

  lines.push(
    "## How to use memory",
    "",
    "**Search first, always.** Before saving anything, search for existing memories on the same topic.",
    "If a relevant memory already exists, use `update_memory` to enrich it — don't create a duplicate.",
    "Never create a duplicate. One memory per fact.",
    "",
    "**When to save:** Save when you learn something genuinely new and worth remembering.",
    "Don't save every detail from a conversation — save the lasting facts.",
    "One conversation about westerns = one memory about their western preferences, not five.",
    "",
    "**When to update:** If you learn something new about an existing topic,",
    "use `update_memory` to enrich the existing entry.",
    "Example: if you already have 'Grant likes westerns' and learn he specifically",
    "loves True Grit, update that memory with the richer version.",
    "",
    "**When NOT to save:** Don't save things that are trivially obvious from context,",
    "things you just said, or things already covered by their profile.",
    "",
    "**Background enrichment.** A background worker captures atoms from your",
    "conversation turns automatically — entities mentioned, factual claims, dated",
    "events, commitments. You do NOT need to manually save every fact during",
    "natural conversation. The worker handles routine capture. Use the explicit",
    "tools below when you need to act deliberately on a specific memory.",
    "",
    "Tools (CRUD-shaped):",
    "- `search_memory` — find existing memories. Search before write.",
    "- `read_memory` — fetch full body of a memory found via `search_memory`.",
    "- `get_backlinks` — list memories that reference a given slug via `[[wikilink]]`.",
    "- `create_memory` — make a NEW memory. Always search first to avoid duplicates.",
    "- `update_memory` — append new info to an existing memory. For entity types",
    "  (person/project/place/media/relationship/commitment/goal/concept) the new",
    "  content lands as a Timeline atom with provenance — original is preserved.",
    "  For flat types (fact/preference/event/decision/routine/skill) it replaces",
    "  the body. Set `importance: 10` to flag a correction; the compilation agent",
    "  top-bills high-importance atoms in the regenerated compiled view.",
    "- `replace_memory` — wholesale replace. Discards all prior content. Only use",
    "  when the prior memory was completely wrong (rare).",
    "- `delete_memory` — remove a memory entirely.",
  );

  return lines.join("\n");
}
