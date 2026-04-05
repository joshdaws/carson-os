// ── Enums as union types ────────────────────────────────────────────

export type MemberRole = "parent" | "student" | "child";

export type AgentStatus = "active" | "paused" | "idle";

export type EnforcementLevel = "hard" | "soft" | "advisory";

export type EvaluationType =
  | "keyword_block"
  | "age_gate"
  | "budget_cap"
  | "role_restrict"
  | "behavioral";

export type RuleCategory =
  | "content-governance"
  | "interaction-mode"
  | "privacy"
  | "budget"
  | "access"
  | "escalation";

export type PolicyEventType =
  | "enforced"
  | "coached"
  | "escalated"
  | "allowed"
  | "budget_exceeded";

export type MessageRole = "user" | "assistant" | "system";

export type Channel = "telegram" | "web";

export type BudgetEventType = "charge" | "reset" | "adjustment";

// ── Evaluation config shapes ────────────────────────────────────────

export interface KeywordBlockConfig {
  blockedTerms: string[];
  caseSensitive?: boolean;
}

export interface AgeGateConfig {
  minAge: number;
  maxAge?: number;
}

export interface BudgetCapConfig {
  monthlyCents: number;
  warningThresholdPct?: number;
}

export interface RoleRestrictConfig {
  allowedRoles: MemberRole[];
}

// ── Evaluation result ───────────────────────────────────────────────

export interface EvaluationResult {
  allowed: boolean;
  ruleId?: string;
  reason?: string;
}
