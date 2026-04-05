import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Helper: current epoch-seconds default
const nowEpoch = sql`(unixepoch())`;

// ── 1. families ─────────────────────────────────────────────────────

export const families = sqliteTable("families", {
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
    familyId: text("family_id")
      .notNull()
      .references(() => families.id),
    name: text("name").notNull(),
    role: text("role").notNull(), // parent | student | child
    age: integer("age").notNull(),
    telegramUserId: text("telegram_user_id").unique(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [index("family_members_family_idx").on(t.familyId)]
);

// ── 3. agents ───────────────────────────────────────────────────────

export const agents = sqliteTable(
  "agents",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id),
    memberId: text("member_id")
      .notNull()
      .references(() => familyMembers.id),
    model: text("model").notNull(),
    status: text("status").notNull().default("idle"), // active | paused | idle
    soulContent: text("soul_content"),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [index("agents_family_idx").on(t.familyId)]
);

// ── 4. constitutions ────────────────────────────────────────────────

export const constitutions = sqliteTable("constitutions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  familyId: text("family_id")
    .notNull()
    .references(() => families.id),
  version: integer("version").notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

// ── 5. constitutionRules ────────────────────────────────────────────

export const constitutionRules = sqliteTable(
  "constitution_rules",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    constitutionId: text("constitution_id")
      .notNull()
      .references(() => constitutions.id),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id),
    category: text("category").notNull(), // RuleCategory
    ruleText: text("rule_text").notNull(),
    enforcementLevel: text("enforcement_level").notNull(), // hard | soft | advisory
    evaluationType: text("evaluation_type").notNull(), // keyword_block | age_gate | budget_cap | role_restrict | behavioral
    evaluationConfig: text("evaluation_config", { mode: "json" }),
    appliesToRoles: text("applies_to_roles", { mode: "json" }), // MemberRole[] | null
    appliesToMinAge: integer("applies_to_min_age"),
    appliesToMaxAge: integer("applies_to_max_age"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [index("constitution_rules_constitution_idx").on(t.constitutionId)]
);

// ── 6. conversations ────────────────────────────────────────────────

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    channel: text("channel").notNull(), // telegram | web
    startedAt: text("started_at").notNull(), // ISO datetime
    lastMessageAt: text("last_message_at"),
    sessionContext: text("session_context", { mode: "json" }),
  },
  (t) => [index("conversations_agent_idx").on(t.agentId)]
);

// ── 7. messages ─────────────────────────────────────────────────────

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
    costCents: integer("cost_cents"),
    metadata: text("metadata", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [index("messages_conversation_ts_idx").on(t.conversationId, t.createdAt)]
);

// ── 8. policyEvents ─────────────────────────────────────────────────

export const policyEvents = sqliteTable(
  "policy_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    conversationId: text("conversation_id").references(() => conversations.id),
    ruleId: text("rule_id").references(() => constitutionRules.id),
    eventType: text("event_type").notNull(), // PolicyEventType
    context: text("context", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [index("policy_events_family_ts_idx").on(t.familyId, t.createdAt)]
);

// ── 9. budgetLedger ─────────────────────────────────────────────────

export const budgetLedger = sqliteTable("budget_ledger", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  familyId: text("family_id")
    .notNull()
    .references(() => families.id),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id),
  amountCents: integer("amount_cents").notNull(),
  balanceAfterCents: integer("balance_after_cents").notNull(),
  eventType: text("event_type").notNull(), // charge | reset | adjustment
  description: text("description"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
});

// ── 10. activityLog ─────────────────────────────────────────────────

export const activityLog = sqliteTable(
  "activity_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id),
    agentId: text("agent_id").references(() => agents.id),
    action: text("action").notNull(),
    details: text("details", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  },
  (t) => [index("activity_log_family_ts_idx").on(t.familyId, t.createdAt)]
);

// ── 11. onboardingState ─────────────────────────────────────────────

export const onboardingState = sqliteTable("onboarding_state", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  familyId: text("family_id")
    .notNull()
    .references(() => families.id),
  step: integer("step").notNull(),
  answers: text("answers", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(nowEpoch),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(nowEpoch),
});

// ── 12. instanceSettings ────────────────────────────────────────────

export const instanceSettings = sqliteTable("instance_settings", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value", { mode: "json" }),
});
