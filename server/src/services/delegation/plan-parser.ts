/**
 * Planner v2 — frontmatter parser for the architectural plan format.
 *
 * Planner agents produce markdown with a YAML frontmatter header. The body is
 * read by the Chief of Staff; the frontmatter is the structural contract this
 * module enforces. A malformed plan fails the task with E_PLAN_MALFORMED so
 * the gate stays load-bearing — accept_plan only sees plans that already
 * cleared schema validation.
 *
 * Two terminal states (discriminated on `plan_state`):
 *   - "complete":               full plan, eligible for accept_plan
 *   - "programming_incomplete": pre-design questions; not eligible for accept_plan
 */

import matter from "gray-matter";
import { z } from "zod";

const completeSchema = z.object({
  plan_state: z.literal("complete"),
  target_developer: z.enum(["core", "project", "tools"]),
  foundational_invariant: z.string().min(1),
  state_location: z.string().min(1),
  failure_modes_considered: z.array(z.string()),
  prior_plans_consulted: z.array(z.string()),
  decisions_referenced: z.array(z.string()),
  estimated_complexity: z.enum(["small", "medium", "large"]),
  out_of_scope: z.array(z.string()),
  open_questions: z.array(z.string()),
  parent_plan_task_id: z.string().optional(),
});

const programmingIncompleteSchema = z.object({
  plan_state: z.literal("programming_incomplete"),
  programming_questions: z.array(z.string().min(1)).min(1),
  prior_plans_consulted: z.array(z.string()),
  decisions_referenced: z.array(z.string()),
  parent_plan_task_id: z.string().optional(),
});

export const planFrontmatterSchema = z.discriminatedUnion("plan_state", [
  completeSchema,
  programmingIncompleteSchema,
]);

export type PlanFrontmatter = z.infer<typeof planFrontmatterSchema>;

export type ParsePlanResult =
  | { ok: true; frontmatter: PlanFrontmatter; body: string }
  | { ok: false; error: string };

/**
 * Parse a Planner task's result body into structured frontmatter + body.
 * gray-matter pulls the YAML block; zod validates the discriminated union.
 * Anything that doesn't match — missing fields, wrong types, no frontmatter
 * at all — returns ok:false with a human-readable error.
 */
export function parsePlanResult(taskBody: string): ParsePlanResult {
  let parsed: { data: Record<string, unknown>; content: string };
  try {
    parsed = matter(taskBody);
  } catch (err) {
    return {
      ok: false,
      error: `frontmatter parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!parsed.data || Object.keys(parsed.data).length === 0) {
    return { ok: false, error: "plan is missing required YAML frontmatter" };
  }

  const validation = planFrontmatterSchema.safeParse(parsed.data);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `frontmatter validation failed: ${issues}` };
  }

  return { ok: true, frontmatter: validation.data, body: parsed.content };
}
