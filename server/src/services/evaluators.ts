/**
 * Constitution evaluators -- pure functions, zero external dependencies.
 *
 * Each evaluator takes data and returns an EvaluationResult.
 * No DB access, no network calls, no side effects.
 */

import type {
  EvaluationResult as BaseEvaluationResult,
  KeywordBlockConfig,
  AgeGateConfig,
  RoleRestrictConfig,
  MemberRole,
  RuleCategory,
  EvaluationType,
} from "@carsonos/shared";

// ── Extended result type (adds matchedContent for keyword hits) ─────

export interface EvaluationResult extends BaseEvaluationResult {
  matchedContent?: string;
}

// ── Hard rule evaluators ────────────────────────────────────────────

/**
 * Evaluate a message against a list of blocked keyword patterns.
 *
 * - `config.caseSensitive` defaults to false
 * - Word boundary matching is used by default to prevent partial matches
 *   (e.g., "ass" won't match "assassination")
 * - The `wordBoundary` option can be controlled via a second config field;
 *   we default to true since the shared KeywordBlockConfig doesn't include it.
 */
export function evaluateKeywordBlock(
  message: string,
  ruleId: string,
  config: KeywordBlockConfig & { wordBoundary?: boolean },
): EvaluationResult {
  const { blockedTerms, caseSensitive = false, wordBoundary = true } = config;

  if (!blockedTerms || blockedTerms.length === 0) {
    return { allowed: true, ruleId };
  }

  const flags = caseSensitive ? "g" : "gi";

  for (const term of blockedTerms) {
    // Escape regex metacharacters in the term itself
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = wordBoundary ? `\\b${escaped}\\b` : escaped;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch {
      // If the pattern is somehow invalid after escaping, skip it
      continue;
    }

    const match = regex.exec(message);
    if (match) {
      return {
        allowed: false,
        ruleId,
        reason: `Blocked keyword: ${term}`,
        matchedContent: match[0],
      };
    }
  }

  return { allowed: true, ruleId };
}

/**
 * Age-gated content check.
 *
 * Blocks if the member is under minAge. When topicKeywords are provided,
 * the block only triggers if the message also contains one of those keywords.
 * If no topicKeywords are specified, it's a pure age check.
 *
 * The boundary is inclusive: a member whose age == minAge is ALLOWED.
 */
export function evaluateAgeGate(
  message: string,
  memberAge: number,
  ruleId: string,
  config: AgeGateConfig & { topicKeywords?: string[] },
): EvaluationResult {
  const { minAge, topicKeywords } = config;

  // At or above the minimum age -- always allowed
  if (memberAge >= minAge) {
    return { allowed: true, ruleId };
  }

  // Under age. If topic keywords exist, only block when message matches one.
  if (topicKeywords && topicKeywords.length > 0) {
    const lowerMessage = message.toLowerCase();
    const matchedKeyword = topicKeywords.find((kw) =>
      lowerMessage.includes(kw.toLowerCase()),
    );

    if (!matchedKeyword) {
      return { allowed: true, ruleId };
    }

    return {
      allowed: false,
      ruleId,
      reason: `Age-restricted content (min age ${minAge}, member is ${memberAge}). Topic: ${matchedKeyword}`,
    };
  }

  // No topic keywords -- pure age check
  return {
    allowed: false,
    ruleId,
    reason: `Age-restricted (min age ${minAge}, member is ${memberAge})`,
  };
}

/**
 * Budget cap check.
 *
 * - Zero budget means no budget assigned -- always block.
 * - Spent >= budget means over cap -- block.
 * - Otherwise allow.
 */
export function evaluateBudgetCap(
  spentCents: number,
  budgetCents: number,
  ruleId: string,
): EvaluationResult {
  if (budgetCents <= 0) {
    return {
      allowed: false,
      ruleId,
      reason: "No budget assigned",
    };
  }

  if (spentCents >= budgetCents) {
    return {
      allowed: false,
      ruleId,
      reason: `Budget exceeded (spent ${spentCents}c of ${budgetCents}c)`,
    };
  }

  return { allowed: true, ruleId };
}

/**
 * Role-based access control.
 *
 * If the member's role is in the allowed list, allow. Otherwise block.
 */
export function evaluateRoleRestrict(
  memberRole: MemberRole,
  ruleId: string,
  config: RoleRestrictConfig,
): EvaluationResult {
  const { allowedRoles } = config;

  if (allowedRoles.includes(memberRole)) {
    return { allowed: true, ruleId };
  }

  return {
    allowed: false,
    ruleId,
    reason: `Role "${memberRole}" not in allowed roles: ${allowedRoles.join(", ")}`,
  };
}

// ── Soft rule prompt compiler ───────────────────────────────────────

interface SoftRule {
  ruleText: string;
  category: string;
  appliesToRoles: MemberRole[] | null;
  appliesToMinAge: number | null;
  appliesToMaxAge: number | null;
}

/**
 * Compile applicable soft rules into a prompt string for the LLM.
 *
 * Filters rules by role and age, then groups by category.
 * Rules with null appliesToRoles apply to everyone.
 * Age boundaries are inclusive on both ends.
 */
export function compileSoftRules(
  allRules: SoftRule[],
  memberRole: MemberRole,
  memberAge: number,
): string {
  const applicable = allRules.filter((rule) => {
    // Role check: null means applies to everyone
    if (rule.appliesToRoles !== null && !rule.appliesToRoles.includes(memberRole)) {
      return false;
    }

    // Age range check (inclusive)
    if (rule.appliesToMinAge !== null && memberAge < rule.appliesToMinAge) {
      return false;
    }
    if (rule.appliesToMaxAge !== null && memberAge > rule.appliesToMaxAge) {
      return false;
    }

    return true;
  });

  if (applicable.length === 0) {
    return "";
  }

  // Group by category
  const grouped = new Map<string, string[]>();
  for (const rule of applicable) {
    const existing = grouped.get(rule.category) ?? [];
    existing.push(rule.ruleText);
    grouped.set(rule.category, existing);
  }

  // Build the prompt
  const sections: string[] = [];
  for (const [category, rules] of grouped) {
    sections.push(`## ${category}`);
    for (const text of rules) {
      sections.push(`- ${text}`);
    }
    sections.push("");
  }

  return sections.join("\n").trim();
}

// ── Post-execution response scanner ────────────────────────────────

interface ScanRule {
  ruleId: string;
  evaluationType: EvaluationType;
  evaluationConfig: unknown;
}

/**
 * Scan an LLM response for keyword violations.
 *
 * Reuses keyword_block patterns from hard rules. Returns the first match
 * found, or null if the response is clean.
 */
export function scanResponse(
  response: string,
  hardRules: ScanRule[],
): EvaluationResult | null {
  const keywordRules = hardRules.filter(
    (r) => r.evaluationType === "keyword_block",
  );

  for (const rule of keywordRules) {
    const config = rule.evaluationConfig as KeywordBlockConfig & {
      wordBoundary?: boolean;
    };
    if (!config || !config.blockedTerms) continue;

    const result = evaluateKeywordBlock(response, rule.ruleId, config);
    if (!result.allowed) {
      return result;
    }
  }

  return null;
}
