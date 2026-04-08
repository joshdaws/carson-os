// ── Enums as union types ────────────────────────────────────────────

export type MemberRole = "parent" | "kid";

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

// ── Interview phase (granular) ────────────────────────────────────

export type InterviewPhase =
  | "family_basics"
  | "values"
  | "education"
  | "boundaries"
  | "interaction_style"
  | "privacy"
  | "schedule"
  | "escalation"
  | "mission"
  | "review_complete";

// ── Rich content types for onboarding chat ────────────────────────

export type RichContentType =
  | "member_confirmation"
  | "step_counter"
  | "mission_reveal"
  | "constitution_loading";

export interface MemberConfirmationContent {
  type: "member_confirmation";
  members: Array<{ name: string; age: number; role: MemberRole }>;
  confirmed: boolean;
}

export interface StepCounterContent {
  type: "step_counter";
  questionNumber: number;
  totalQuestions: number;
}

export interface MissionRevealContent {
  type: "mission_reveal";
  missionStatement: string;
}

export interface ConstitutionLoadingContent {
  type: "constitution_loading";
  stage: 1 | 2 | 3;
  message: string;
}

export type RichContent =
  | MemberConfirmationContent
  | StepCounterContent
  | MissionRevealContent
  | ConstitutionLoadingContent;

export type ProfileInterviewPhase =
  | "intro"
  | "personality"
  | "interests"
  | "learning"
  | "boundaries"
  | "review_complete";

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
