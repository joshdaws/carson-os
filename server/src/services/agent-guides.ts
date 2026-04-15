/**
 * Agent Guides — lazy-loaded markdown playbooks that agents reference when
 * they need to follow a specific workflow (tool creation, delegation, etc.).
 *
 * Guides live co-located with the module they describe (e.g.,
 * server/src/services/custom-tools/GUIDE.md), and are registered here by
 * short name. Agents invoke them via the `get_agent_guide` MCP tool.
 *
 * Why a guide instead of stuffing everything into operating_instructions:
 *   - Operating instructions are sent on EVERY message. Guides load on demand.
 *   - Guides are markdown, easy to revise in PRs, reviewable diff-by-diff.
 *   - Co-located with the code they describe, so they stay in sync.
 *
 * How agents discover guides:
 *   - Agent operating_instructions point at the relevant guide by name
 *     ("for tool creation, call get_agent_guide('tool-creation') first")
 *   - Error messages from MCP tools reference the guide when retry guidance
 *     would benefit from the full playbook
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDefinition, ToolResult } from "@carsonos/shared";

// Resolve paths relative to this file, not CWD. Works under tsx, compiled dist, and tests.
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Registry: guide short-name → absolute path to the markdown file.
 * Add a new entry when a new module ships a GUIDE.md.
 */
const GUIDES: Record<string, string> = {
  "tool-creation": join(__dirname, "custom-tools", "GUIDE.md"),
  // Future additions (keep this list honest — one entry per shipped guide):
  // "delegation": join(__dirname, "delegation", "GUIDE.md"),
  // "memory-hygiene": join(__dirname, "memory", "GUIDE.md"),
};

export const AGENT_GUIDE_NAMES = Object.keys(GUIDES);

// ── MCP tool definition ──────────────────────────────────────────────

export const AGENT_GUIDE_TOOLS: ToolDefinition[] = [
  {
    name: "get_agent_guide",
    description:
      `Load a workflow playbook by name. Call this FIRST when the user asks you to do something that matches a known workflow — the guide contains the full architecture and step-by-step instructions, so you don't have to infer from tool descriptions alone. ` +
      `Available guides: ${AGENT_GUIDE_NAMES.map((n) => `'${n}'`).join(", ")}. ` +
      `Returns the markdown contents of the guide. Cheap — read it, follow it, act.`,
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: AGENT_GUIDE_NAMES,
          description:
            "The guide to load. Use 'tool-creation' when asked to build, create, or install a custom tool.",
        },
      },
      required: ["name"],
    },
  },
];

// ── Handler ──────────────────────────────────────────────────────────

export async function handleAgentGuideTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (name !== "get_agent_guide") {
    return { content: `Unknown agent-guide tool: ${name}`, is_error: true };
  }
  const guideName = String(input.name ?? "").trim();
  if (!guideName) {
    return {
      content: `get_agent_guide requires 'name'. Available: ${AGENT_GUIDE_NAMES.map((n) => `'${n}'`).join(", ")}.`,
      is_error: true,
    };
  }
  const path = GUIDES[guideName];
  if (!path) {
    return {
      content: `No guide named '${guideName}'. Available: ${AGENT_GUIDE_NAMES.map((n) => `'${n}'`).join(", ")}.`,
      is_error: true,
    };
  }
  try {
    const content = readFileSync(path, "utf8");
    return { content };
  } catch (err) {
    return {
      content: `Failed to read guide '${guideName}': ${(err as Error).message}`,
      is_error: true,
    };
  }
}
