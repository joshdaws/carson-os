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
 *
 * Three narrow tolerances on input shape — see the inline NOTE inside
 * parsePlanResult for the enumerated shapes and the cap policy. These
 * tolerances widen "what counts as parseable input" — they do not weaken
 * schema validation. Missing required fields still fail.
 */
export function parsePlanResult(taskBody: string): ParsePlanResult {
  // ── Input tolerance preprocessing ──────────────────────────────────
  // NOTE: this block tolerates THREE specific shapes of malformed Planner
  // output observed during v0.4 smoke testing:
  //   1. Leading narration before the frontmatter (tool-use deltas
  //      concatenated by the SDK adapter).
  //   2. A yaml code fence whose opener immediately precedes the '---'
  //      delimiter.
  //   3. Narration → '---' (markdown horizontal rule) → blank → '```yaml'
  //      → '---' → keys, where the first '---' is an HR and the inner
  //      '---' is the real frontmatter start.
  //
  // No additional shapes will be added here. If a fourth shape appears,
  // the correct fix is the structured tool-call refactor — see TODO Gap 5
  // in ~/.claude/projects/-Users-collinmadsen-carson-os/memory/todo_approval_flow_gaps.md.
  // The parser tolerance code below is scheduled for removal, not
  // extension. Adding a fourth tolerance reopens the slippery slope this
  // policy was written to close.
  const lines = taskBody.split("\n");
  let fmStart = lines.findIndex((l) => l === "---");
  if (fmStart === -1) {
    return { ok: false, error: "plan is missing required YAML frontmatter" };
  }

  // Pattern 2: fence opener immediately precedes the first '---'.
  let hadFenceOpener =
    fmStart > 0 && /^```ya?ml\s*$/i.test(lines[fmStart - 1]);

  // Pattern 3: the first '---' is followed (past blanks) by a yaml fence
  // opener and a second '---'. Treat the inner '---' as the real start;
  // the outer one was a markdown horizontal rule.
  if (!hadFenceOpener) {
    const lookahead: { idx: number; line: string }[] = [];
    for (let i = fmStart + 1; i < lines.length && lookahead.length < 2; i++) {
      if (lines[i].trim() === "") continue;
      lookahead.push({ idx: i, line: lines[i] });
    }
    if (
      lookahead.length >= 2 &&
      /^```ya?ml\s*$/i.test(lookahead[0].line) &&
      lookahead[1].line === "---"
    ) {
      fmStart = lookahead[1].idx;
      hadFenceOpener = true;
    }
  }

  const reconstructed = lines.slice(fmStart).join("\n");

  let parsed: { data: Record<string, unknown>; content: string };
  try {
    parsed = matter(reconstructed);
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

  let body = parsed.content;
  if (hadFenceOpener) {
    // Strip the corresponding closing triple-backtick line if present.
    // Anything after the closer stays in the body (the LLM occasionally
    // appends final notes outside the fence).
    const bodyLines = body.split("\n");
    const closerIdx = bodyLines.findIndex((l) => /^```\s*$/.test(l));
    if (closerIdx !== -1) {
      bodyLines.splice(closerIdx, 1);
      body = bodyLines.join("\n");
    }
  }

  return { ok: true, frontmatter: validation.data, body };
}
