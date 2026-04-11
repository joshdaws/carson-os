/**
 * Default memory schema — defines the 7 memory types agents can work with.
 *
 * Each type has a description (for the agent prompt) and frontmatter
 * fields (for structured YAML headers on markdown files).
 *
 * Parents can override this schema in the dashboard (post-MVP).
 * For v1.0, this is the only schema.
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
  ],
};

/**
 * Build the "How to Use Memory" instructions that get injected into the
 * agent's system prompt. Describes the available types and their fields
 * so the agent knows what to pass to save_memory.
 */
export function buildMemorySchemaInstructions(schema: MemorySchema): string {
  const lines: string[] = [
    "You have access to a persistent memory system. Use it proactively — save important facts, preferences, events, and commitments as you learn them. Search memory before answering questions about the family.",
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

  lines.push(
    "## How to use memory",
    "",
    "**Search first, always.** Before saving anything, search for existing memories on the same topic.",
    "If a relevant memory already exists, decide: update it (delete old + save new) or skip.",
    "Never create a duplicate. One memory per fact.",
    "",
    "**When to save:** Save when you learn something new and genuinely worth remembering.",
    "Don't save every detail from a conversation — save the lasting facts.",
    "One conversation about westerns = one memory about their western preferences, not five.",
    "",
    "**When to update:** If you learn something new about an existing topic,",
    "delete the old memory and save a new, more complete version.",
    "Example: if you already have 'Grant likes westerns' and learn he specifically",
    "loves True Grit, delete the old one and save a richer version.",
    "",
    "**When NOT to save:** Don't save things that are trivially obvious from context,",
    "things you just said, or things already covered by their profile.",
    "",
    "Tools:",
    "- `search_memory` — search before answering AND before saving",
    "- `save_memory` — save new memories (search first to avoid duplicates)",
    "- `delete_memory` — remove outdated, incorrect, or superseded memories",
  );

  return lines.join("\n");
}
