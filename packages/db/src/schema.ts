import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const nowEpoch = sql`(unixepoch())`;

// ── 1. households ───────────────────────────────────────────────────

export const households = sqliteTable("households", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/New_York"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(nowEpoch),
});

// ── 2. familyMembers ────────────────────────────────────────────────

export const familyMembers = sqliteTable(
  "family_members",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id),
    name: text("name").notNull(),
    role: text("role").notNull(), // parent | student | child
    age: integer("age").notNull(),
    telegramUserId: text("telegram_user_id").unique(),
    profileContent: text("profile_content"), // Per-person profile document (member.md)
    profileUpdatedAt: integer("profile_updated_at", { mode: "timestamp" }),
    memoryDir: text("memory_dir"), // Override: point at existing brain directory instead of default
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [index("family_members_household_idx").on(t.householdId)]
);

// ── 3. staffAgents ──────────────────────────────────────────────────

export const staffAgents = sqliteTable(
  "staff_agents",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id),
    name: text("name").notNull(),
    staffRole: text("staff_role").notNull(), // head_butler | personal | tutor | coach | scheduler | custom
    specialty: text("specialty"),
    roleContent: text("role_content").notNull().default(""), // Job description: responsibilities, capabilities
    soulContent: text("soul_content"), // Personality: voice, tone, values. NULL for internal agents.
    visibility: text("visibility").notNull().default("family"), // family | internal
    telegramBotToken: text("telegram_bot_token"), // Bot token for family-visible agents. NULL for internal.
    model: text("model").notNull().default("claude-sonnet-4-6"),
    status: text("status").notNull().default("active"), // active | paused | idle
    isHeadButler: integer("is_head_butler", { mode: "boolean" }).notNull().default(false),
    autonomyLevel: text("autonomy_level").notNull().default("supervised"), // supervised | trusted | autonomous
    trustLevel: text("trust_level").notNull().default("restricted"), // full | standard | restricted — controls Claude built-in tool access
    operatingInstructions: text("operating_instructions"), // Self-maintained behavioral notes (agent's CLAUDE.md)
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [index("staff_agents_household_idx").on(t.householdId)]
);

// ── 4. staffAssignments ─────────────────────────────────────────────

export const staffAssignments = sqliteTable(
  "staff_assignments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => staffAgents.id),
    memberId: text("member_id")
      .notNull()
      .references(() => familyMembers.id),
    relationship: text("relationship").notNull().default("primary"), // primary | secondary | oversight
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [
    index("staff_assignments_agent_idx").on(t.agentId),
    index("staff_assignments_member_idx").on(t.memberId),
    uniqueIndex("staff_assignments_unique").on(t.agentId, t.memberId),
  ]
);

// ── 5. constitutions ────────────────────────────────────────────────

export const constitutions = sqliteTable("constitutions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  householdId: text("household_id")
    .notNull()
    .references(() => households.id),
  version: integer("version").notNull().default(1),
  document: text("document").notNull().default(""),
  interviewTranscript: text("interview_transcript", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

// ── 6. constitutionClauses ──────────────────────────────────────────

export const constitutionClauses = sqliteTable(
  "constitution_clauses",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    constitutionId: text("constitution_id")
      .notNull()
      .references(() => constitutions.id),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id),
    category: text("category").notNull(),
    clauseText: text("clause_text").notNull(),
    enforcementLevel: text("enforcement_level").notNull().default("soft"), // hard | soft | advisory
    evaluationType: text("evaluation_type").notNull().default("behavioral"), // keyword_block | age_gate | role_restrict | behavioral
    evaluationConfig: text("evaluation_config", { mode: "json" }),
    appliesToRoles: text("applies_to_roles", { mode: "json" }), // MemberRole[] | null
    appliesToAgents: text("applies_to_agents", { mode: "json" }), // string[] (staff agent IDs) | null
    appliesToMinAge: integer("applies_to_min_age"),
    appliesToMaxAge: integer("applies_to_max_age"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [index("constitution_clauses_constitution_idx").on(t.constitutionId)]
);

// ── 7. tasks ────────────────────────────────────────────────────────

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => staffAgents.id),
    parentTaskId: text("parent_task_id"), // FK to tasks.id. NULL = top-level / standalone.
    requestedBy: text("requested_by").references(() => familyMembers.id),
    assignedToMembers: text("assigned_to_members", { mode: "json" }), // string[] member IDs
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("pending"), // pending | approved | in_progress | completed | failed | cancelled
    requiresApproval: integer("requires_approval", { mode: "boolean" }).notNull().default(true),
    approvedBy: text("approved_by"),
    governingClauses: text("governing_clauses", { mode: "json" }), // string[] clause IDs
    delegationDepth: integer("delegation_depth").notNull().default(0), // tracks delegation nesting
    result: text("result"),
    report: text("report"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(nowEpoch),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (t) => [
    index("tasks_household_idx").on(t.householdId),
    index("tasks_agent_idx").on(t.agentId),
    index("tasks_status_idx").on(t.status),
    index("tasks_parent_idx").on(t.parentTaskId),
  ]
);

// ── 8. taskEvents ───────────────────────────────────────────────────

export const taskEvents = sqliteTable(
  "task_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    agentId: text("agent_id").references(() => staffAgents.id),
    eventType: text("event_type").notNull(), // created | assigned | approved | rejected | started | progress_update | delegated | completed | failed | synthesis_requested
    message: text("message"), // Human-readable description
    payload: text("payload", { mode: "json" }), // event-type-specific data
    clauseIds: text("clause_ids", { mode: "json" }), // governing clause IDs
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [index("task_events_task_idx").on(t.taskId)]
);

// ── 8b. delegationEdges ────────────────────────────────────────────

export const delegationEdges = sqliteTable(
  "delegation_edges",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    fromAgentId: text("from_agent_id")
      .notNull()
      .references(() => staffAgents.id),
    toAgentId: text("to_agent_id")
      .notNull()
      .references(() => staffAgents.id),
    allowedTaskTypes: text("allowed_task_types", { mode: "json" }), // string[] | null = all types
    relayProgress: integer("relay_progress", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [
    uniqueIndex("delegation_edges_unique").on(t.fromAgentId, t.toAgentId),
    index("delegation_edges_from_idx").on(t.fromAgentId),
  ]
);

// ── 9. policyEvents ─────────────────────────────────────────────────

export const policyEvents = sqliteTable(
  "policy_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => staffAgents.id),
    conversationId: text("conversation_id"),
    taskId: text("task_id"),
    clauseId: text("clause_id"),
    eventType: text("event_type").notNull(), // enforced | coached | escalated | allowed
    context: text("context", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [index("policy_events_household_ts_idx").on(t.householdId, t.createdAt)]
);

// ── 10. conversations ───────────────────────────────────────────────

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => staffAgents.id),
    memberId: text("member_id")
      .notNull()
      .references(() => familyMembers.id),
    channel: text("channel").notNull().default("telegram"), // telegram | web
    startedAt: text("started_at").notNull(),
    lastMessageAt: text("last_message_at"),
    sessionContext: text("session_context", { mode: "json" }),
  },
  (t) => [
    index("conversations_agent_idx").on(t.agentId),
    index("conversations_member_idx").on(t.memberId),
  ]
);

// ── 11. messages ────────────────────────────────────────────────────

export const messages = sqliteTable(
  "messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: text("role").notNull(), // user | assistant | system
    content: text("content").notNull(),
    tokenCount: integer("token_count"),
    metadata: text("metadata", { mode: "json" }),
    status: text("status").notNull().default("delivered"), // delivered | pending
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [index("messages_conversation_ts_idx").on(t.conversationId, t.createdAt)]
);

// ── 12. activityLog ─────────────────────────────────────────────────

export const activityLog = sqliteTable(
  "activity_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id),
    agentId: text("agent_id").references(() => staffAgents.id),
    action: text("action").notNull(),
    details: text("details", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [index("activity_log_household_ts_idx").on(t.householdId, t.createdAt)]
);

// ── 13. onboardingState ─────────────────────────────────────────────

export const onboardingState = sqliteTable("onboarding_state", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  householdId: text("household_id")
    .notNull()
    .references(() => households.id),
  phase: text("phase").notNull().default("interview"), // interview | review | staff_setup | telegram_config | complete
  interviewMessages: text("interview_messages", { mode: "json" }),
  extractedClauses: text("extracted_clauses", { mode: "json" }),
  selectedStaff: text("selected_staff", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(nowEpoch),
});

// ── 13b. profileInterviewState ──────────────────────────────────────

export const profileInterviewState = sqliteTable("profile_interview_state", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  memberId: text("member_id")
    .notNull()
    .references(() => familyMembers.id),
  phase: text("phase").notNull().default("intro"), // intro | personality | interests | learning | boundaries | review_complete
  interviewMessages: text("interview_messages", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(nowEpoch),
});

// ── 13c. personalityInterviewState ─────────────────────────────────

export const personalityInterviewState = sqliteTable("personality_interview_state", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  agentId: text("agent_id")
    .notNull()
    .references(() => staffAgents.id),
  phase: text("phase").notNull().default("intro"),
  interviewMessages: text("interview_messages", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(nowEpoch),
});

// ── 14. toolGrants ─────────────────────────────────────────────────

export const toolGrants = sqliteTable(
  "tool_grants",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => staffAgents.id),
    toolName: text("tool_name").notNull(), // e.g. "search_memory", "list_calendar_events"
    grantedBy: text("granted_by"), // member ID who granted it, null = system default
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [
    index("tool_grants_agent_idx").on(t.agentId),
    uniqueIndex("tool_grants_unique").on(t.agentId, t.toolName),
  ]
);

// ── 15. scheduledTasks ─────────────────────────────────────────────

export const scheduledTasks = sqliteTable(
  "scheduled_tasks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => staffAgents.id),
    memberId: text("member_id")
      .references(() => familyMembers.id), // null = household-level task
    name: text("name").notNull(), // "Daily briefing", "Weekly meal plan"
    prompt: text("prompt").notNull(), // what the agent should do
    scheduleType: text("schedule_type").notNull(), // "cron" | "interval" | "once"
    scheduleValue: text("schedule_value").notNull(), // cron: "0 6 * * *", interval: "24h", once: ISO timestamp
    timezone: text("timezone").notNull().default("America/New_York"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastRunAt: integer("last_run_at", { mode: "timestamp" }),
    nextRunAt: integer("next_run_at", { mode: "timestamp" }),
    lastStatus: text("last_status"), // "success" | "error" | null
    lastError: text("last_error"),
    runCount: integer("run_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [
    index("scheduled_tasks_household_idx").on(t.householdId),
    index("scheduled_tasks_agent_idx").on(t.agentId),
    index("scheduled_tasks_next_run_idx").on(t.nextRunAt),
  ]
);

// ── 16. instanceSettings ────────────────────────────────────────────

export const instanceSettings = sqliteTable("instance_settings", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value", { mode: "json" }),
});

// ── 17. customTools ─────────────────────────────────────────────────

/**
 * Custom tools created by agents or installed from skills.sh.
 *
 * The SKILL.md file on disk is the source of truth for what the tool is
 * (name, description, input_schema, config). This table stores operational
 * state only: status, usage stats, authorship, content hash for tamper
 * detection. See ~/.carsonos/tools/{household_id}/{path}/SKILL.md.
 */
export const customTools = sqliteTable(
  "custom_tools",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id),
    name: text("name").notNull(), // matches SKILL.md frontmatter.name
    kind: text("kind").notNull(), // 'http' | 'prompt' | 'script'
    path: text("path").notNull(), // relative path under ~/.carsonos/tools/{hh}/
    createdByAgentId: text("created_by_agent_id")
      .notNull()
      .references(() => staffAgents.id),
    source: text("source").notNull().default("agent"), // 'agent' | 'installed-skill' | 'imported'
    sourceUrl: text("source_url"), // for installed skills
    status: text("status").notNull().default("active"), // 'active' | 'disabled' | 'pending_approval' | 'promoted' | 'broken'
    approvedContentHash: text("approved_content_hash"), // SHA-256 of files at last approval
    schemaVersion: integer("schema_version").notNull().default(1), // bumped on update; used for session invalidation
    generation: integer("generation").notNull().default(1), // bumped on update; used for script module cache-busting
    usageCount: integer("usage_count").notNull().default(0),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    lastError: text("last_error"), // populated for 'broken' status
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [
    index("custom_tools_household_idx").on(t.householdId),
    index("custom_tools_status_idx").on(t.status),
    uniqueIndex("custom_tools_household_name_unique").on(t.householdId, t.name),
  ]
);

// ── 18. toolSecrets ─────────────────────────────────────────────────

/**
 * Encrypted secrets referenced by custom tools. Values are encrypted at rest
 * with AES-256-GCM. Key derived from CARSONOS_SECRET env var (preferred) or
 * a generated keyfile at ~/.carsonos/.secret.
 *
 * Referenced by HTTP tools via auth.secretKey and by script tools via
 * ctx.getSecret(key_name). Never returned from list APIs. Never logged.
 */
export const toolSecrets = sqliteTable(
  "tool_secrets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id),
    keyName: text("key_name").notNull(), // e.g., 'ynab_api_token'
    encryptedValue: text("encrypted_value").notNull(), // base64(iv + authtag + ciphertext)
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [
    index("tool_secrets_household_idx").on(t.householdId),
    uniqueIndex("tool_secrets_household_key_unique").on(t.householdId, t.keyName),
  ]
);
