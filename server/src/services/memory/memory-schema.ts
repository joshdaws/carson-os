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
    "Use `search_memory` to find relevant memories before answering questions.",
    "Use `save_memory` when you learn something worth remembering.",
    "Use `delete_memory` to remove outdated or incorrect memories.",
  );

  return lines.join("\n");
}
