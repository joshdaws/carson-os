/**
 * Specialty templates for hired specialists + CoS delegation preamble.
 *
 * Developer specialties (tools/project/core) get curated markdown templates
 * covering the workspace contract, branch naming, PR etiquette, etc.
 *
 * Non-Developer specialists (researcher, music, tutor-variant, etc.) don't
 * get curated templates — their operating instructions come from either the
 * proposer's `customInstructions` or a generic preamble composed from
 * role + reason (see `composeGenericSpecialistInstructions`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function load(name: string): string {
  return readFileSync(join(here, `${name}.md`), "utf8");
}

/** Curated templates for Developer specialties. */
export const SPECIALTY_TEMPLATES = {
  tools: load("tools"),
  project: load("project"),
  core: load("core"),
} as const;

export type DeveloperSpecialty = keyof typeof SPECIALTY_TEMPLATES;

export const COS_DELEGATION_PREAMBLE = load("cos-delegation-preamble");

/** Planner v2 — non-Developer specialty with a curated architectural template.
 *  Kept separate from SPECIALTY_TEMPLATES so downstream code that branches on
 *  Developer-vs-other (Dispatcher.executeDeveloperTask, hire defaults) keeps
 *  its existing semantics. */
export const PLANNER_TEMPLATE = load("planner");

export function isDeveloperSpecialty(specialty: string): specialty is DeveloperSpecialty {
  return specialty === "tools" || specialty === "project" || specialty === "core";
}

/** Returns the operating-instructions body for a curated specialty (Developer
 *  kinds + Planner), or null otherwise. Non-curated specialties fall through
 *  to composeGenericSpecialistInstructions(). */
export function templateForSpecialty(specialty: string): string | null {
  if (isDeveloperSpecialty(specialty)) {
    return SPECIALTY_TEMPLATES[specialty];
  }
  if (specialty === "planning") {
    return PLANNER_TEMPLATE;
  }
  return null;
}

/** Compose operating instructions for a non-Developer specialist. Used when
 *  the proposer didn't provide `customInstructions`. Captures role, specialty,
 *  and reason into a coherent prompt — honest about what this agent is for. */
export function composeGenericSpecialistInstructions(args: {
  role: string;
  specialty: string;
  reason: string;
  name: string;
}): string {
  const { role, specialty, reason, name } = args;
  return [
    `# ${name} — ${role} (${specialty})`,
    "",
    "You are a household specialist agent. A family member hired you for a specific",
    "purpose, stated below. Act like a professional in your field — not a general",
    "assistant. Stay in lane: answer from your expertise, decline what's outside it,",
    "and suggest who else on staff might be a better fit when appropriate.",
    "",
    "## What you were hired for",
    "",
    reason,
    "",
    "## How you work",
    "",
    "- You don't write code or open PRs — you're not a Developer. If the family needs",
    "  software built, direct them to propose_hire a Developer or delegate to one",
    "  that's already on staff.",
    "- You run inside a task when the Chief of Staff delegates to you. Respond with",
    "  a clear, self-contained answer or report; the principal won't see your",
    "  scratch work unless you put it in the response.",
    "- Use your granted tools (memory, web search/fetch, project docs) to ground",
    "  your work in real sources rather than guessing. Cite or quote when it helps.",
    "- When you're done, say so plainly. The system picks that up as completion.",
    "",
    "## Pace",
    "",
    "Take the time you need — no wall-clock timeout. The principal can cancel at any",
    "point by saying \"kill <name>'s task.\"",
  ].join("\n");
}
