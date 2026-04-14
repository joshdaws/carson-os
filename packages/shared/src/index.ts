// ── Enums as union types ────────────────────────────────────────────

export type MemberRole = "parent" | "kid";

export type StaffRole = "head_butler" | "personal" | "tutor" | "coach" | "scheduler" | "custom";

export type AgentStatus = "active" | "paused" | "idle";

export type AutonomyLevel = "supervised" | "trusted" | "autonomous";

/**
 * Trust levels determine what Claude Code built-in tools an agent gets.
 *   - full:       All built-ins (Bash, Read, Write, Edit, Web, etc.) — head agent, parent agents
 *   - standard:   Read-only built-ins (Read, Glob, Grep, WebFetch, WebSearch) — teen/spouse agents
 *   - restricted: No built-ins — only CarsonOS MCP tools — young kid agents
 */
export type TrustLevel = "full" | "standard" | "restricted";

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

export type Channel = "telegram" | "web" | "scheduled";

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

export type PersonalityInterviewPhase =
  | "intro"
  | "voice"
  | "humor"
  | "boundaries"
  | "style"
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

// ── Memory types ───────────────────────────────────────────────────

export type MemoryType =
  | "fact"
  | "preference"
  | "event"
  | "decision"
  | "commitment"
  | "person"
  | "project"
  | "media"
  | "place"
  | "routine"
  | "relationship"
  | "goal"
  | "skill";

export interface MemorySchemaField {
  name: string;
  type: "string" | "string[]" | "date" | "enum";
  required?: boolean;
  enumValues?: string[];
  description?: string;
}

export interface MemorySchemaType {
  type: MemoryType;
  description: string;
  fields: MemorySchemaField[];
}

export interface MemorySchema {
  types: MemorySchemaType[];
}

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
  filePath: string;
  collection: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MemorySearchResult {
  entries: Array<{
    id: string;
    title: string;
    snippet: string;
    score: number;
    file: string;
    collection: string;
  }>;
}

export interface MemoryProvider {
  search(query: string, collection: string, limit?: number): Promise<MemorySearchResult>;
  save(collection: string, entry: {
    type: MemoryType;
    title: string;
    content: string;
    frontmatter?: Record<string, unknown>;
  }): Promise<{ id: string; filePath: string }>;
  update(collection: string, id: string, entry: {
    title?: string;
    content?: string;
    frontmatter?: Record<string, unknown>;
  }): Promise<{ id: string; filePath: string }>;
  delete(collection: string, id: string): Promise<void>;
  list(collection: string, limit?: number): Promise<MemoryEntry[]>;
}

// ── Tool types ─────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  is_error?: boolean;
}

export type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<ToolResult>;

// ── Subprocess adapter types ────────────────────────────────────────

export type AdapterType = "claude-code" | "codex" | "anthropic-sdk";

export type AdapterMode = "chat" | "task";

export interface AdapterExecuteParams {
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
  model?: string;
  tools?: ToolDefinition[];
  toolExecutor?: ToolExecutor;
  /** Claude Code built-in tools to enable (e.g., ["Bash", "Read", "Write"]) */
  builtinTools?: string[];
  /** Claude Code skill names to enable (e.g., ["content-writer", "web-scraper"]) */
  enabledSkills?: string[];
  /** Streaming callback — fired for each text delta as it arrives from the LLM */
  onTextDelta?: (text: string) => void;
  /** Resume an existing Agent SDK session instead of starting fresh */
  resumeSessionId?: string;
  /**
   * Called by the adapter after a tool-list-modifying tool call succeeds
   * (create_custom_tool, update_custom_tool, disable_custom_tool, etc.)
   * so the adapter can re-inject the updated tool list into the active
   * Agent SDK session via setMcpServers. Lets agents immediately use tools
   * they just built, rather than waiting for the next conversation.
   */
  refreshTools?: () => Promise<{ tools: ToolDefinition[]; toolExecutor: ToolExecutor }>;
}

export interface AdapterExecuteResult {
  content: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; result: ToolResult }>;
  /** Agent SDK session ID — store this to resume the session on the next message */
  sessionId?: string;
  metadata?: Record<string, unknown>;
}
