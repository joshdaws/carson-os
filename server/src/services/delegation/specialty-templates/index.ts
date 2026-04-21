/**
 * Specialty templates for Developer hires + CoS delegation preamble.
 *
 * Loaded once at module init from the sibling .md files. Persisted into
 * `staff_agents.operating_instructions` at hire time so each Developer sees
 * its specialty's contract in its system prompt. The cos-delegation-preamble
 * is appended to the CoS (head butler) agent's existing operating instructions.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function load(name: string): string {
  return readFileSync(join(here, `${name}.md`), "utf8");
}

export const SPECIALTY_TEMPLATES = {
  tools: load("tools"),
  project: load("project"),
  core: load("core"),
} as const;

export type DeveloperSpecialty = keyof typeof SPECIALTY_TEMPLATES;

export const COS_DELEGATION_PREAMBLE = load("cos-delegation-preamble");

/** Returns the operating-instructions body for a newly hired Developer. */
export function templateForSpecialty(specialty: DeveloperSpecialty): string {
  return SPECIALTY_TEMPLATES[specialty];
}
