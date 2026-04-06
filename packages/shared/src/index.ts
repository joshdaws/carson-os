// ── Enums as union types ────────────────────────────────────────────

export type MemberRole = "parent" | "student" | "child";

export type StaffRole = "head_butler" | "personal" | "tutor" | "coach" | "scheduler" | "custom";

export type AgentStatus = "active" | "paused" | "idle";

export type AutonomyLevel = "supervised" | "trusted" | "autonomous";

export type EnforcementLevel = "hard" | "soft" | "advisory";

export type EvaluationType =
  | "keyword_block"
  | "age_gate"
  | "role_restrict"
  | "behavioral";

export type ClauseCategory =
  | "content-governance"
  | "interaction-mode"
  | "privacy"
  | "access"
  | "escalation";

export type PolicyEventType =
  | "enforced"
  | "coached"
  | "escalated"
  | "allowed";

export type TaskStatus =
  | "pending"
  | "approved"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentVisibility = "family" | "internal";

export type TaskEventType =
  | "created"
  | "assigned"
  | "approved"
  | "rejected"
  | "started"
  | "progress_update"
  | "delegated"
  | "completed"
  | "failed"
  | "synthesis_requested";

export type MessageRole = "user" | "assistant" | "system";

export type Channel = "telegram" | "web";

export type OnboardingPhase = "interview" | "review" | "staff_setup" | "telegram_config" | "complete";

export type AssignmentRelationship = "primary" | "secondary" | "oversight";

// ── Evaluation config shapes ────────────────────────────────────────

export interface KeywordBlockConfig {
  blockedTerms: string[];
  caseSensitive?: boolean;
}

export interface AgeGateConfig {
  minAge: number;
  maxAge?: number;
  topicKeywords?: string[];
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

// ── Subprocess adapter types ────────────────────────────────────────

export type AdapterType = "claude-code" | "codex" | "anthropic-sdk";

export type AdapterMode = "chat" | "task";

export interface AdapterExecuteParams {
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
}

export interface AdapterExecuteResult {
  content: string;
  metadata?: Record<string, unknown>;
}
