import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export function createDb(dbPath: string) {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");

  ensureTables(sqlite);

  return drizzle({ client: sqlite, schema });
}

export type Db = ReturnType<typeof createDb>;

function ensureTables(sqlite: Database.Database) {
  const tableCheck = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='households'")
    .get();

  if (tableCheck) {
    upgradeTables(sqlite);
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
  model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  status TEXT NOT NULL DEFAULT 'active',
  is_head_butler INTEGER NOT NULL DEFAULT 0,
  autonomy_level TEXT NOT NULL DEFAULT 'supervised',
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
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);
CREATE INDEX tasks_household_idx ON tasks(household_id);
CREATE INDEX tasks_agent_idx ON tasks(agent_id);
CREATE INDEX tasks_status_idx ON tasks(status);
CREATE INDEX tasks_parent_idx ON tasks(parent_task_id);

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

CREATE TABLE instance_settings (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value TEXT
);
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
  console.log("[db] Tables created (v4 schema — 15 tables, delegation support)");
}

/** Upgrade existing v3 DB to v4 schema */
function upgradeTables(sqlite: Database.Database) {
  const cols = (table: string) => {
    const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  };

  const tableExists = (name: string) =>
    !!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

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

    if (upgraded) {
      console.log("[db] Schema upgraded to v7 (tool grants)");
    }
  });

  transaction();
}
