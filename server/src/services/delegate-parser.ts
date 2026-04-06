/**
 * Delegate Block Parser for CarsonOS
 *
 * When a personal agent responds to a user message, it may embed <delegate>
 * blocks indicating work that should be handed off to internal specialist
 * agents (tutor, scheduler, etc.). This module extracts those blocks,
 * validates them, and returns a clean user-facing message with all delegate
 * markup stripped.
 */

/** Maximum number of delegate blocks allowed in a single response. */
const BREADTH_LIMIT = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DelegateBlock {
  /** Agent name/role from the `agent` attribute. */
  agent: string;
  /** Task type from the `type` attribute. */
  type: string;
  /** Trimmed inner content of the delegate block. */
  content: string;
}

export interface ParseResult {
  /** Successfully parsed delegate blocks (up to BREADTH_LIMIT). */
  blocks: DelegateBlock[];
  /** The response with all <delegate> blocks stripped -- what the user sees. */
  userMessage: string;
  /** Any parsing issues encountered. */
  warnings: string[];
}

export interface ValidationResult {
  /** Whether the block passed validation. */
  valid: boolean;
  /** Reason the block was rejected, if invalid. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Replace the contents of fenced code blocks (``` ... ```) with empty strings
 * so that <delegate> tags inside examples or documentation are never matched.
 * Returns the sanitised string.
 */
function stripCodeFences(text: string): string {
  // Match opening ``` (with optional language tag) through closing ```.
  // The dotall flag (s) lets `.` match newlines.
  return text.replace(/```[\s\S]*?```/g, (match) => {
    // Preserve the same number of newlines so line-position math stays valid
    // (not strictly required for our use, but defensive).
    return match.replace(/[^\n]/g, "");
  });
}

/**
 * Regex for a well-formed <delegate> block.
 *
 * Captures:
 *   1 - The full opening-tag attribute string (e.g. `agent="tutor" type="create_study_plan"`)
 *   2 - The inner content before </delegate>
 *
 * Using [\s\S]*? (non-greedy) so each block closes at the nearest </delegate>.
 */
const DELEGATE_BLOCK_RE =
  /<delegate\s+([\s\S]*?)>([\s\S]*?)<\/delegate>/gi;

/**
 * Regex for an opening <delegate ...> tag that is never closed.
 * Used to detect malformed blocks after all well-formed ones are consumed.
 */
const UNCLOSED_DELEGATE_RE = /<delegate\s+[^>]*>(?![\s\S]*?<\/delegate>)/gi;

/**
 * Extract a named attribute value from an attribute string.
 * Handles both double-quoted and single-quoted values.
 */
function extractAttribute(
  attrs: string,
  name: string,
): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const m = attrs.match(re);
  if (!m) return undefined;
  return m[1] ?? m[2];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse all `<delegate>` blocks from an agent's response.
 *
 * Rules:
 * - Blocks inside markdown code fences are ignored.
 * - Blocks missing the `agent` attribute are skipped (warning emitted).
 * - Unclosed `<delegate>` tags are skipped (warning emitted).
 * - At most {@link BREADTH_LIMIT} blocks are returned; extras are dropped
 *   with a warning.
 * - The `userMessage` field contains the response text with every
 *   `<delegate>` block (well-formed or not) stripped out. If the response
 *   consisted entirely of delegate blocks, `userMessage` is an empty string.
 *
 * @param response - The raw text output from the agent.
 * @returns Parsed blocks, the cleaned user message, and any warnings.
 */
export function parseDelegateBlocks(response: string): ParseResult {
  const blocks: DelegateBlock[] = [];
  const warnings: string[] = [];

  // 1. Build a version of the response with code fences blanked out so we
  //    only match <delegate> tags that are NOT inside code examples.
  const withoutFences = stripCodeFences(response);

  // 2. Find all well-formed <delegate>...</delegate> blocks in the
  //    fence-stripped text.
  let match: RegExpExecArray | null;

  // Reset lastIndex (global regex).
  DELEGATE_BLOCK_RE.lastIndex = 0;

  while ((match = DELEGATE_BLOCK_RE.exec(withoutFences)) !== null) {
    const attrString = match[1];
    const innerContent = match[2];

    const agent = extractAttribute(attrString, "agent");
    const type = extractAttribute(attrString, "type");

    if (!agent) {
      warnings.push(
        `Skipped <delegate> block: missing required "agent" attribute.`,
      );
      continue;
    }

    if (blocks.length >= BREADTH_LIMIT) {
      warnings.push(
        `Delegate block limit reached (${BREADTH_LIMIT}). Ignoring additional block for agent "${agent}".`,
      );
      continue;
    }

    blocks.push({
      agent,
      type: type ?? "",
      content: innerContent.trim(),
    });
  }

  // 3. Detect unclosed <delegate> tags (malformed).
  UNCLOSED_DELEGATE_RE.lastIndex = 0;
  let unclosedMatch: RegExpExecArray | null;
  while (
    (unclosedMatch = UNCLOSED_DELEGATE_RE.exec(withoutFences)) !== null
  ) {
    warnings.push(
      `Skipped malformed <delegate> block: no closing </delegate> tag found.`,
    );
  }

  // 4. Build the user-facing message by stripping ALL delegate markup from
  //    the ORIGINAL response (not the fence-stripped copy -- we want to
  //    preserve code fence contents).

  // Strip well-formed blocks first.
  let userMessage = response.replace(
    /<delegate\s+[\s\S]*?<\/delegate>/gi,
    "",
  );

  // Strip any remaining unclosed <delegate ...> tags (everything from the
  // opening tag to the end of the string, since there is no closing tag).
  // We only remove the opening tag itself, not the rest of the response.
  userMessage = userMessage.replace(/<delegate\s+[^>]*>/gi, "");

  // Clean up: collapse runs of 3+ newlines to 2, then trim.
  userMessage = userMessage.replace(/\n{3,}/g, "\n\n").trim();

  return { blocks, userMessage, warnings };
}

/**
 * Validate a parsed delegate block against a list of allowed agent names.
 *
 * @param block         - The delegate block to validate.
 * @param allowedAgents - Agent names that are permitted (matched case-insensitively).
 * @returns Whether the block is valid, with a reason string when invalid.
 */
export function validateDelegateBlock(
  block: DelegateBlock,
  allowedAgents: string[],
): ValidationResult {
  const normalised = block.agent.toLowerCase();
  const allowed = allowedAgents.map((a) => a.toLowerCase());

  if (!allowed.includes(normalised)) {
    return {
      valid: false,
      reason: `Agent "${block.agent}" is not in the allowed list: [${allowedAgents.join(", ")}].`,
    };
  }

  return { valid: true };
}
