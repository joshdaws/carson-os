import { describe, it, expect } from "vitest";

import {
  evaluateKeywordBlock,
  evaluateAgeGate,
  evaluateBudgetCap,
  evaluateRoleRestrict,
  compileSoftRules,
  scanResponse,
} from "../evaluators.js";

// ── evaluateKeywordBlock ────────────────────────────────────────────

describe("evaluateKeywordBlock", () => {
  const ruleId = "kw-rule-1";

  it("1. blocks when message contains a blocked keyword", () => {
    const result = evaluateKeywordBlock("you are a damn fool", ruleId, {
      blockedTerms: ["damn", "hell"],
    });

    expect(result.allowed).toBe(false);
    expect(result.ruleId).toBe(ruleId);
    expect(result.reason).toContain("damn");
    expect(result.matchedContent).toBe("damn");
  });

  it("2. allows when message is clean", () => {
    const result = evaluateKeywordBlock("what a wonderful day", ruleId, {
      blockedTerms: ["damn", "hell"],
    });

    expect(result.allowed).toBe(true);
    expect(result.ruleId).toBe(ruleId);
  });

  it("3. allows when patterns array is empty", () => {
    const result = evaluateKeywordBlock("anything goes here", ruleId, {
      blockedTerms: [],
    });

    expect(result.allowed).toBe(true);
  });

  it("4. matches unicode keywords correctly", () => {
    const result = evaluateKeywordBlock(
      "that is so schei\u00dfe dude",
      ruleId,
      { blockedTerms: ["schei\u00dfe"] },
    );

    expect(result.allowed).toBe(false);
    expect(result.matchedContent).toBe("schei\u00dfe");
  });

  it("5. respects case sensitivity flag", () => {
    // Case insensitive (default) -- should match
    const insensitive = evaluateKeywordBlock("DAMN it", ruleId, {
      blockedTerms: ["damn"],
      caseSensitive: false,
    });
    expect(insensitive.allowed).toBe(false);

    // Case sensitive -- should NOT match (different case)
    const sensitive = evaluateKeywordBlock("DAMN it", ruleId, {
      blockedTerms: ["damn"],
      caseSensitive: true,
    });
    expect(sensitive.allowed).toBe(true);

    // Case sensitive -- exact match
    const exactMatch = evaluateKeywordBlock("damn it", ruleId, {
      blockedTerms: ["damn"],
      caseSensitive: true,
    });
    expect(exactMatch.allowed).toBe(false);
  });

  it("6. word boundary prevents partial matches (assassination vs ass)", () => {
    // With word boundary (default) -- "ass" should NOT match "assassination"
    const withBoundary = evaluateKeywordBlock(
      "the assassination attempt was thwarted",
      ruleId,
      { blockedTerms: ["ass"] },
    );
    expect(withBoundary.allowed).toBe(true);

    // Without word boundary -- "ass" SHOULD match inside "assassination"
    const withoutBoundary = evaluateKeywordBlock(
      "the assassination attempt was thwarted",
      ruleId,
      { blockedTerms: ["ass"], wordBoundary: false },
    );
    expect(withoutBoundary.allowed).toBe(false);

    // With word boundary, standalone word -- should still match
    const standalone = evaluateKeywordBlock("what an ass", ruleId, {
      blockedTerms: ["ass"],
    });
    expect(standalone.allowed).toBe(false);
  });
});

// ── evaluateAgeGate ─────────────────────────────────────────────────

describe("evaluateAgeGate", () => {
  const ruleId = "age-rule-1";

  it("7. blocks under-age member when message matches topic keyword", () => {
    const result = evaluateAgeGate(
      "tell me about dating advice",
      10,
      ruleId,
      { minAge: 13, topicKeywords: ["dating", "romance"] },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("min age 13");
    expect(result.reason).toContain("member is 10");
    expect(result.reason).toContain("dating");
  });

  it("8. allows over-age member regardless of topic", () => {
    const result = evaluateAgeGate(
      "tell me about dating advice",
      16,
      ruleId,
      { minAge: 13, topicKeywords: ["dating", "romance"] },
    );

    expect(result.allowed).toBe(true);
  });

  it("9. allows at exact boundary age (inclusive)", () => {
    const result = evaluateAgeGate(
      "tell me about dating advice",
      13,
      ruleId,
      { minAge: 13, topicKeywords: ["dating"] },
    );

    expect(result.allowed).toBe(true);
  });

  it("10. blocks on age alone when no topic keywords are specified", () => {
    const result = evaluateAgeGate("literally anything", 10, ruleId, {
      minAge: 13,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Age-restricted");
  });

  it("allows under-age member when message does not match topic keywords", () => {
    const result = evaluateAgeGate("help me with math homework", 10, ruleId, {
      minAge: 13,
      topicKeywords: ["dating", "romance"],
    });

    expect(result.allowed).toBe(true);
  });
});

// ── evaluateBudgetCap ───────────────────────────────────────────────

describe("evaluateBudgetCap", () => {
  const ruleId = "budget-rule-1";

  it("11. allows when under budget", () => {
    const result = evaluateBudgetCap(500, 1000, ruleId);
    expect(result.allowed).toBe(true);
  });

  it("12. blocks when at budget (spent == cap)", () => {
    const result = evaluateBudgetCap(1000, 1000, ruleId);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Budget exceeded");
  });

  it("13. always blocks when budget is zero", () => {
    const result = evaluateBudgetCap(0, 0, ruleId);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("No budget assigned");
  });

  it("blocks when over budget", () => {
    const result = evaluateBudgetCap(1500, 1000, ruleId);
    expect(result.allowed).toBe(false);
  });
});

// ── evaluateRoleRestrict ────────────────────────────────────────────

describe("evaluateRoleRestrict", () => {
  const ruleId = "role-rule-1";

  it("14. allows when role is in the allowed list", () => {
    const result = evaluateRoleRestrict("parent", ruleId, {
      allowedRoles: ["parent", "student"],
    });

    expect(result.allowed).toBe(true);
  });

  it("15. blocks when role is not in the allowed list", () => {
    const result = evaluateRoleRestrict("child", ruleId, {
      allowedRoles: ["parent"],
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("child");
    expect(result.reason).toContain("parent");
  });
});

// ── compileSoftRules ────────────────────────────────────────────────

describe("compileSoftRules", () => {
  const rules = [
    {
      ruleText: "Be encouraging and patient",
      category: "interaction-mode",
      appliesToRoles: null,
      appliesToMinAge: null,
      appliesToMaxAge: null,
    },
    {
      ruleText: "Use simple language",
      category: "interaction-mode",
      appliesToRoles: ["child" as const],
      appliesToMinAge: null,
      appliesToMaxAge: 10,
    },
    {
      ruleText: "Allow discussion of college topics",
      category: "content-governance",
      appliesToRoles: ["student" as const],
      appliesToMinAge: 13,
      appliesToMaxAge: null,
    },
    {
      ruleText: "Full admin access",
      category: "access",
      appliesToRoles: ["parent" as const],
      appliesToMinAge: null,
      appliesToMaxAge: null,
    },
  ];

  it("includes rules with null appliesToRoles (applies to everyone)", () => {
    const result = compileSoftRules(rules, "child", 8);

    expect(result).toContain("Be encouraging and patient");
  });

  it("includes role-matched rules", () => {
    const result = compileSoftRules(rules, "child", 8);

    expect(result).toContain("Use simple language");
    expect(result).not.toContain("Full admin access");
    expect(result).not.toContain("college topics");
  });

  it("filters by age range", () => {
    // Student age 14 should get the college topics rule
    const result = compileSoftRules(rules, "student", 14);

    expect(result).toContain("college topics");
    expect(result).toContain("Be encouraging");

    // Student age 12 should NOT get college topics (minAge 13)
    const young = compileSoftRules(rules, "student", 12);

    expect(young).not.toContain("college topics");
  });

  it("groups rules by category", () => {
    const result = compileSoftRules(rules, "child", 8);

    // Should have category headers
    expect(result).toContain("## interaction-mode");
  });

  it("returns empty string when no rules match", () => {
    const result = compileSoftRules(
      [
        {
          ruleText: "Parents only",
          category: "access",
          appliesToRoles: ["parent"],
          appliesToMinAge: null,
          appliesToMaxAge: null,
        },
      ],
      "child",
      8,
    );

    expect(result).toBe("");
  });
});

// ── scanResponse ────────────────────────────────────────────────────

describe("scanResponse", () => {
  it("returns null for a clean response", () => {
    const result = scanResponse("Here is a helpful answer about math.", [
      {
        ruleId: "scan-1",
        evaluationType: "keyword_block",
        evaluationConfig: { blockedTerms: ["damn", "hell"] },
      },
    ]);

    expect(result).toBeNull();
  });

  it("catches keyword violations in the response", () => {
    const result = scanResponse("What the hell kind of question is that?", [
      {
        ruleId: "scan-1",
        evaluationType: "keyword_block",
        evaluationConfig: { blockedTerms: ["damn", "hell"] },
      },
    ]);

    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(false);
    expect(result!.matchedContent).toBe("hell");
  });

  it("ignores non-keyword_block rules", () => {
    const result = scanResponse("anything goes", [
      {
        ruleId: "age-1",
        evaluationType: "age_gate",
        evaluationConfig: { minAge: 13 },
      },
      {
        ruleId: "role-1",
        evaluationType: "role_restrict",
        evaluationConfig: { allowedRoles: ["parent"] },
      },
    ]);

    expect(result).toBeNull();
  });

  it("handles rules with missing or null config gracefully", () => {
    const result = scanResponse("test message", [
      {
        ruleId: "bad-config",
        evaluationType: "keyword_block",
        evaluationConfig: null,
      },
    ]);

    expect(result).toBeNull();
  });
});
