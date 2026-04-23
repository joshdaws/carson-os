import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

/**
 * Optional callback invoked before schema upgrades run.
 * The server passes a backup function here so the DB package
 * doesn't need to know about the filesystem layout.
 */
export type PreMigrationHook = (reason: string) => void;

export function createDb(dbPath: string, preMigrationHook?: PreMigrationHook) {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");

  ensureTables(sqlite, preMigrationHook);

  return drizzle({ client: sqlite, schema });
}

export type Db = ReturnType<typeof createDb>;

function ensureTables(sqlite: Database.Database, preMigrationHook?: PreMigrationHook) {
  const tableCheck = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='households'")
    .get();

  if (tableCheck) {
    upgradeTables(sqlite, preMigrationHook);
    return;
  }

  const migrationSQL = `
CREATE TABLE households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE family_members (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  age INTEGER NOT NULL,
  telegram_user_id TEXT UNIQUE,
  signal_number TEXT UNIQUE,
  signal_uuid TEXT UNIQUE,
  profile_content TEXT,
  profile_updated_at INTEGER,
  memory_dir TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX family_members_household_idx ON family_members(household_id);

CREATE TABLE staff_agents (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  staff_role TEXT NOT NULL,
  specialty TEXT,
  role_content TEXT NOT NULL DEFAULT '',
  soul_content TEXT,
  visibility TEXT NOT NULL DEFAULT 'family',
  telegram_bot_token TEXT,
  signal_account TEXT,
  signal_daemon_port INTEGER,
  model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  status TEXT NOT NULL DEFAULT 'active',
  is_head_butler INTEGER NOT NULL DEFAULT 0,
  autonomy_level TEXT NOT NULL DEFAULT 'supervised',
  trust_level TEXT NOT NULL DEFAULT 'restricted',
  operating_instructions TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX staff_agents_household_idx ON staff_agents(household_id);

CREATE TABLE staff_assignments (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES staff_agents(id),
  member_id TEXT NOT NULL REFERENCES family_members(id),
  relationship TEXT NOT NULL DEFAULT 'primary',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX staff_assignments_agent_idx ON staff_assignments(agent_id);
CREATE INDEX staff_assignments_member_idx ON staff_assignments(member_id);
CREATE UNIQUE INDEX staff_assignments_unique ON staff_assignments(agent_id, member_id);

CREATE TABLE constitutions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  version INTEGER NOT NULL DEFAULT 1,
  document TEXT NOT NULL DEFAULT '',
  interview_transcript TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE constitution_clauses (
  id TEXT PRIMARY KEY,
  constitution_id TEXT NOT NULL REFERENCES constitutions(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  category TEXT NOT NULL,
  clause_text TEXT NOT NULL,
  enforcement_level TEXT NOT NULL DEFAULT 'soft',
  evaluation_type TEXT NOT NULL DEFAULT 'behavioral',
  evaluation_config TEXT,
  applies_to_roles TEXT,
  applies_to_agents TEXT,
  applies_to_min_age INTEGER,
  applies_to_max_age INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX constitution_clauses_constitution_idx ON constitution_clauses(constitution_id);

-- projects must be created before tasks because tasks.project_id references it.
-- SQLite accepts forward references when PRAGMA foreign_keys is OFF, but this
-- order is the correct invariant and lets a future operator enable FK checking.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  repo_url TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  test_cmd TEXT,
  dev_cmd TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  metadata TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX projects_household_idx ON projects(household_id);
CREATE UNIQUE INDEX projects_household_name_unique ON projects(household_id, name);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  agent_id TEXT NOT NULL REFERENCES staff_agents(id),
  parent_task_id TEXT,
  requested_by TEXT REFERENCES family_members(id),
  assigned_to_members TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  requires_approval INTEGER NOT NULL DEFAULT 1,
  approved_by TEXT,
  governing_clauses TEXT,
  delegation_depth INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  report TEXT,
  project_id TEXT REFERENCES projects(id),
  workspace_kind TEXT,
  workspace_path TEXT,
  workspace_branch TEXT,
  timeout_sec INTEGER,
  approval_expires_at INTEGER,
  notify_payload TEXT,
  notified_at INTEGER,
  notify_agent_id TEXT REFERENCES staff_agents(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);
CREATE INDEX tasks_household_idx ON tasks(household_id);
CREATE INDEX tasks_agent_idx ON tasks(agent_id);
CREATE INDEX tasks_status_idx ON tasks(status);
CREATE INDEX tasks_parent_idx ON tasks(parent_task_id);
CREATE INDEX tasks_project_idx ON tasks(project_id);
CREATE INDEX tasks_pending_notify_idx ON tasks(notified_at);

CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT REFERENCES staff_agents(id),
  event_type TEXT NOT NULL,
  message TEXT,
  payload TEXT,
  clause_ids TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX task_events_task_idx ON task_events(task_id);

CREATE TABLE delegation_edges (
  id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL REFERENCES staff_agents(id),
  to_agent_id TEXT NOT NULL REFERENCES staff_agents(id),
  allowed_task_types TEXT,
  relay_progress INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX delegation_edges_unique ON delegation_edges(from_agent_id, to_agent_id);
CREATE INDEX delegation_edges_from_idx ON delegation_edges(from_agent_id);

CREATE TABLE policy_events (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  agent_id TEXT NOT NULL REFERENCES staff_agents(id),
  conversation_id TEXT,
  task_id TEXT,
  clause_id TEXT,
  event_type TEXT NOT NULL,
  context TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX policy_events_household_ts_idx ON policy_events(household_id, created_at);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  agent_id TEXT NOT NULL REFERENCES staff_agents(id),
  member_id TEXT NOT NULL REFERENCES family_members(id),
  channel TEXT NOT NULL DEFAULT 'telegram',
  started_at TEXT NOT NULL,
  last_message_at TEXT,
  session_context TEXT
);
CREATE INDEX conversations_agent_idx ON conversations(agent_id);
CREATE INDEX conversations_member_idx ON conversations(member_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER,
  metadata TEXT,
  status TEXT NOT NULL DEFAULT 'delivered',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX messages_conversation_ts_idx ON messages(conversation_id, created_at);

CREATE TABLE activity_log (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  agent_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX activity_log_household_ts_idx ON activity_log(household_id, created_at);

CREATE TABLE onboarding_state (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  phase TEXT NOT NULL DEFAULT 'interview',
  interview_messages TEXT,
  extracted_clauses TEXT,
  selected_staff TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE profile_interview_state (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES family_members(id),
  phase TEXT NOT NULL DEFAULT 'intro',
  interview_messages TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE tool_grants (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES staff_agents(id),
  tool_name TEXT NOT NULL,
  granted_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX tool_grants_agent_idx ON tool_grants(agent_id);
CREATE UNIQUE INDEX tool_grants_unique ON tool_grants(agent_id, tool_name);

CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  agent_id TEXT NOT NULL REFERENCES staff_agents(id),
  member_id TEXT REFERENCES family_members(id),
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL,
  schedule_value TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  last_status TEXT,
  last_error TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX scheduled_tasks_household_idx ON scheduled_tasks(household_id);
CREATE INDEX scheduled_tasks_agent_idx ON scheduled_tasks(agent_id);
CREATE INDEX scheduled_tasks_next_run_idx ON scheduled_tasks(next_run_at);

CREATE TABLE instance_settings (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value TEXT
);

CREATE TABLE custom_tools (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  created_by_agent_id TEXT NOT NULL REFERENCES staff_agents(id),
  source TEXT NOT NULL DEFAULT 'agent',
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  approved_content_hash TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  generation INTEGER NOT NULL DEFAULT 1,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX custom_tools_household_idx ON custom_tools(household_id);
CREATE INDEX custom_tools_status_idx ON custom_tools(status);
CREATE UNIQUE INDEX custom_tools_household_name_unique ON custom_tools(household_id, name);

CREATE TABLE tool_secrets (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  key_name TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX tool_secrets_household_idx ON tool_secrets(household_id);
CREATE UNIQUE INDEX tool_secrets_household_key_unique ON tool_secrets(household_id, key_name);

CREATE TABLE delegation_notifications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  sent_at INTEGER,
  delivered_message_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX delegation_notifications_task_kind_unique ON delegation_notifications(task_id, kind);
CREATE INDEX delegation_notifications_task_idx ON delegation_notifications(task_id);
  `;

  const transaction = sqlite.transaction(() => {
    const statements = migrationSQL
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      sqlite.prepare(stmt).run();
    }
  });

  transaction();
  console.log("[db] Tables created (v11 schema — 20 tables, v0.4 delegation)");
}

/** Additive upgrade path: applies new columns + tables to an existing DB. Current target: v11. */
function upgradeTables(sqlite: Database.Database, preMigrationHook?: PreMigrationHook) {
  const cols = (table: string) => {
    const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  };

  const tableExists = (name: string) =>
    !!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

  // Check if any upgrades are needed before running the transaction
  // (so we only backup when there's actually a migration to run)
  const staffCols = cols("staff_agents");
  const taskCols = cols("tasks");
  const teCols = cols("task_events");
  const memberCols = cols("family_members");
  const needsUpgrade =
    !staffCols.has("role_content") || !staffCols.has("visibility") ||
    !staffCols.has("telegram_bot_token") || !staffCols.has("updated_at") ||
    !staffCols.has("operating_instructions") || !staffCols.has("trust_level") ||
    !taskCols.has("parent_task_id") || !taskCols.has("delegation_depth") ||
    (teCols.has("actor") && !teCols.has("agent_id")) ||
    !tableExists("delegation_edges") || !tableExists("profile_interview_state") ||
    !tableExists("tool_grants") || !tableExists("personality_interview_state") ||
    !tableExists("scheduled_tasks") ||
    !staffCols.has("signal_account") || !staffCols.has("signal_daemon_port") ||
    !memberCols.has("profile_content") || !memberCols.has("profile_updated_at") ||
    !memberCols.has("memory_dir") || !memberCols.has("signal_number") ||
    !memberCols.has("signal_uuid") ||
    // v0.4 delegation
    !taskCols.has("project_id") || !taskCols.has("notify_payload") ||
    !taskCols.has("notify_agent_id") ||
    !tableExists("projects") || !tableExists("delegation_notifications");

  if (needsUpgrade && preMigrationHook) {
    preMigrationHook("schema-upgrade");
  }

  const transaction = sqlite.transaction(() => {
    let upgraded = false;

    // staff_agents: add new columns
    const staffCols = cols("staff_agents");
    if (!staffCols.has("role_content")) {
      // Migrate: copy soul_content to role_content (it was a combined blob), then clear soul_content
      sqlite.prepare("ALTER TABLE staff_agents ADD COLUMN role_content TEXT NOT NULL DEFAULT ''").run();
      sqlite.prepare("UPDATE staff_agents SET role_content = COALESCE(soul_content, ''), soul_content = NULL").run();
      upgraded = true;
    }
    if (!staffCols.has("visibility")) {
      sqlite.prepare("ALTER TABLE staff_agents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'family'").run();
      upgraded = true;
    }
    if (!staffCols.has("telegram_bot_token")) {
      sqlite.prepare("ALTER TABLE staff_agents ADD COLUMN telegram_bot_token TEXT").run();
      upgraded = true;
    }
    if (!staffCols.has("updated_at")) {
      const now = Math.floor(Date.now() / 1000);
      sqlite.prepare(`ALTER TABLE staff_agents ADD COLUMN updated_at INTEGER NOT NULL DEFAULT ${now}`).run();
      upgraded = true;
    }

    // tasks: add parent_task_id and delegation_depth
    const taskCols = cols("tasks");
    if (!taskCols.has("parent_task_id")) {
      sqlite.prepare("ALTER TABLE tasks ADD COLUMN parent_task_id TEXT").run();
      sqlite.prepare("CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks(parent_task_id)").run();
      upgraded = true;
    }
    if (!taskCols.has("delegation_depth")) {
      sqlite.prepare("ALTER TABLE tasks ADD COLUMN delegation_depth INTEGER NOT NULL DEFAULT 0").run();
      upgraded = true;
    }

    // Replace task_events if old schema (has 'actor' column, missing 'agent_id')
    const teCols = cols("task_events");
    if (teCols.has("actor") && !teCols.has("agent_id")) {
      sqlite.prepare("DROP TABLE task_events").run();
      sqlite.prepare(`CREATE TABLE task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        agent_id TEXT REFERENCES staff_agents(id),
        event_type TEXT NOT NULL,
        message TEXT,
        payload TEXT,
        clause_ids TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`).run();
      sqlite.prepare("CREATE INDEX task_events_task_idx ON task_events(task_id)").run();
      upgraded = true;
    }

    // Create delegation_edges table
    if (!tableExists("delegation_edges")) {
      sqlite.prepare(`CREATE TABLE delegation_edges (
        id TEXT PRIMARY KEY,
        from_agent_id TEXT NOT NULL REFERENCES staff_agents(id),
        to_agent_id TEXT NOT NULL REFERENCES staff_agents(id),
        allowed_task_types TEXT,
        relay_progress INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`).run();
      sqlite.prepare("CREATE UNIQUE INDEX delegation_edges_unique ON delegation_edges(from_agent_id, to_agent_id)").run();
      sqlite.prepare("CREATE INDEX delegation_edges_from_idx ON delegation_edges(from_agent_id)").run();
      upgraded = true;
    }

    // family_members: add profile columns
    const memberCols = cols("family_members");
    if (!memberCols.has("profile_content")) {
      sqlite.prepare("ALTER TABLE family_members ADD COLUMN profile_content TEXT").run();
      upgraded = true;
    }
    if (!memberCols.has("profile_updated_at")) {
      sqlite.prepare("ALTER TABLE family_members ADD COLUMN profile_updated_at INTEGER").run();
      upgraded = true;
    }

    // Create profile_interview_state table
    if (!tableExists("profile_interview_state")) {
      sqlite.prepare(`CREATE TABLE profile_interview_state (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL REFERENCES family_members(id),
        phase TEXT NOT NULL DEFAULT 'intro',
        interview_messages TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`).run();
      upgraded = true;
    }

    // family_members: add memoryDir for per-member memory directory override
    if (!memberCols.has("memory_dir")) {
      sqlite.prepare("ALTER TABLE family_members ADD COLUMN memory_dir TEXT").run();
      upgraded = true;
    }

    // staff_agents: add operatingInstructions for self-maintained behavioral notes
    if (!staffCols.has("operating_instructions")) {
      sqlite.prepare("ALTER TABLE staff_agents ADD COLUMN operating_instructions TEXT").run();
      upgraded = true;
    }

    // staff_agents: add trustLevel for Claude built-in tool access
    if (!staffCols.has("trust_level")) {
      sqlite.prepare("ALTER TABLE staff_agents ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'restricted'").run();
      // Head butler gets full trust by default
      sqlite.prepare("UPDATE staff_agents SET trust_level = 'full' WHERE is_head_butler = 1").run();
      upgraded = true;
    }

    // Create tool_grants table
    if (!tableExists("tool_grants")) {
      sqlite.prepare(`CREATE TABLE tool_grants (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES staff_agents(id),
        tool_name TEXT NOT NULL,
        granted_by TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`).run();
      sqlite.prepare("CREATE INDEX tool_grants_agent_idx ON tool_grants(agent_id)").run();
      sqlite.prepare("CREATE UNIQUE INDEX tool_grants_unique ON tool_grants(agent_id, tool_name)").run();
      upgraded = true;
    }

    // Create personality_interview_state table
    if (!tableExists("personality_interview_state")) {
      sqlite.prepare(`CREATE TABLE personality_interview_state (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES staff_agents(id),
        phase TEXT NOT NULL DEFAULT 'intro',
        interview_messages TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`).run();
      upgraded = true;
    }

    // Create scheduled_tasks table
    if (!tableExists("scheduled_tasks")) {
      sqlite.prepare(`CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL REFERENCES households(id),
        agent_id TEXT NOT NULL REFERENCES staff_agents(id),
        member_id TEXT REFERENCES family_members(id),
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'America/New_York',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        next_run_at INTEGER,
        last_status TEXT,
        last_error TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`).run();
      sqlite.prepare("CREATE INDEX scheduled_tasks_household_idx ON scheduled_tasks(household_id)").run();
      sqlite.prepare("CREATE INDEX scheduled_tasks_agent_idx ON scheduled_tasks(agent_id)").run();
      sqlite.prepare("CREATE INDEX scheduled_tasks_next_run_idx ON scheduled_tasks(next_run_at)").run();
      upgraded = true;
    }

    // Create custom_tools + tool_secrets tables (v10 — custom tool registry)
    if (!tableExists("custom_tools")) {
      sqlite.prepare(`CREATE TABLE custom_tools (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL REFERENCES households(id),
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        created_by_agent_id TEXT NOT NULL REFERENCES staff_agents(id),
        source TEXT NOT NULL DEFAULT 'agent',
        source_url TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        approved_content_hash TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1,
        generation INTEGER NOT NULL DEFAULT 1,
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`).run();
      sqlite.prepare("CREATE INDEX custom_tools_household_idx ON custom_tools(household_id)").run();
      sqlite.prepare("CREATE INDEX custom_tools_status_idx ON custom_tools(status)").run();
      sqlite.prepare("CREATE UNIQUE INDEX custom_tools_household_name_unique ON custom_tools(household_id, name)").run();
      upgraded = true;
    }

    if (!tableExists("tool_secrets")) {
      sqlite.prepare(`CREATE TABLE tool_secrets (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL REFERENCES households(id),
        key_name TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`).run();
      sqlite.prepare("CREATE INDEX tool_secrets_household_idx ON tool_secrets(household_id)").run();
      sqlite.prepare("CREATE UNIQUE INDEX tool_secrets_household_key_unique ON tool_secrets(household_id, key_name)").run();
      upgraded = true;
    }

    // staff_agents: add Signal transport columns
    if (!staffCols.has("signal_account")) {
      sqlite.prepare("ALTER TABLE staff_agents ADD COLUMN signal_account TEXT").run();
      upgraded = true;
    }
    if (!staffCols.has("signal_daemon_port")) {
      sqlite.prepare("ALTER TABLE staff_agents ADD COLUMN signal_daemon_port INTEGER").run();
      upgraded = true;
    }

    // family_members: add Signal number
    if (!memberCols.has("signal_number")) {
      sqlite.prepare("ALTER TABLE family_members ADD COLUMN signal_number TEXT").run();
      upgraded = true;
    }

    // family_members: add Signal UUID (ACI) — used when sender's phone
    // privacy prevents sourceNumber from appearing in the envelope
    if (!memberCols.has("signal_uuid")) {
      sqlite.prepare("ALTER TABLE family_members ADD COLUMN signal_uuid TEXT").run();
      upgraded = true;
    }

    // v0.4 delegation: projects table
    if (!tableExists("projects")) {
      sqlite.prepare(`CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL REFERENCES households(id),
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        repo_url TEXT,
        default_branch TEXT NOT NULL DEFAULT 'main',
        test_cmd TEXT,
        dev_cmd TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        metadata TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`).run();
      sqlite.prepare("CREATE INDEX projects_household_idx ON projects(household_id)").run();
      sqlite.prepare("CREATE UNIQUE INDEX projects_household_name_unique ON projects(household_id, name)").run();
      upgraded = true;
    }

    // v0.4 delegation: new columns on tasks for workspace + two-phase notifier
    const taskColsV04 = cols("tasks");
    if (!taskColsV04.has("project_id")) {
      sqlite.prepare("ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id)").run();
      sqlite.prepare("CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id)").run();
      upgraded = true;
    }
    if (!taskColsV04.has("workspace_kind")) {
      sqlite.prepare("ALTER TABLE tasks ADD COLUMN workspace_kind TEXT").run();
      upgraded = true;
    }
    if (!taskColsV04.has("workspace_path")) {
      sqlite.prepare("ALTER TABLE tasks ADD COLUMN workspace_path TEXT").run();
      upgraded = true;
    }
    if (!taskColsV04.has("workspace_branch")) {
      sqlite.prepare("ALTER TABLE tasks ADD COLUMN workspace_branch TEXT").run();
      upgraded = true;
    }
    if (!taskColsV04.has("timeout_sec")) {
      sqlite.prepare("ALTER TABLE tasks ADD COLUMN timeout_sec INTEGER").run();
      upgraded = true;
    }
    if (!taskColsV04.has("approval_expires_at")) {
      sqlite.prepare("ALTER TABLE tasks ADD COLUMN approval_expires_at INTEGER").run();
      upgraded = true;
    }
    if (!taskColsV04.has("notify_payload")) {
      sqlite.prepare("ALTER TABLE tasks ADD COLUMN notify_payload TEXT").run();
      upgraded = true;
    }
    if (!taskColsV04.has("notified_at")) {
      sqlite.prepare("ALTER TABLE tasks ADD COLUMN notified_at INTEGER").run();
      sqlite.prepare("CREATE INDEX IF NOT EXISTS tasks_pending_notify_idx ON tasks(notified_at)").run();
      upgraded = true;
    }
    if (!taskColsV04.has("notify_agent_id")) {
      // Backfill: existing delegated tasks (parent_task_id IS NOT NULL) route completion
      // to agent_id by default. Fresh tasks from v0.4 onward set this explicitly when
      // CoS delegates on behalf of a kid. See design doc Premise 6 + kid-routing flow.
      sqlite.prepare("ALTER TABLE tasks ADD COLUMN notify_agent_id TEXT REFERENCES staff_agents(id)").run();
      upgraded = true;
    }

    // v0.4 delegation: notification audit + dedup
    if (!tableExists("delegation_notifications")) {
      sqlite.prepare(`CREATE TABLE delegation_notifications (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        sent_at INTEGER,
        delivered_message_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`).run();
      sqlite.prepare("CREATE UNIQUE INDEX delegation_notifications_task_kind_unique ON delegation_notifications(task_id, kind)").run();
      sqlite.prepare("CREATE INDEX delegation_notifications_task_idx ON delegation_notifications(task_id)").run();
      upgraded = true;
    }

    if (upgraded) {
      console.log("[db] Schema upgraded (v11 — v0.4 delegation: projects, tasks workspace/notifier, delegation_notifications)");
    }
  });

  transaction();
}
