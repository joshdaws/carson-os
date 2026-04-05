import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export function createDb(dbPath: string) {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");

  // Auto-create tables on first run
  ensureTables(sqlite);

  return drizzle({ client: sqlite, schema });
}

export type Db = ReturnType<typeof createDb>;

function ensureTables(sqlite: Database.Database) {
  // Check if tables exist
  const tableCheck = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='families'")
    .get();

  if (tableCheck) return; // Tables already exist

  const migrationSQL = `
CREATE TABLE families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE family_members (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  age INTEGER NOT NULL,
  telegram_user_id TEXT UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX family_members_family_idx ON family_members(family_id);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  member_id TEXT NOT NULL REFERENCES family_members(id),
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  soul_content TEXT,
  budget_monthly_cents INTEGER NOT NULL DEFAULT 0,
  spent_monthly_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX agents_family_idx ON agents(family_id);

CREATE TABLE constitutions (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE constitution_rules (
  id TEXT PRIMARY KEY,
  constitution_id TEXT NOT NULL REFERENCES constitutions(id),
  family_id TEXT NOT NULL REFERENCES families(id),
  category TEXT NOT NULL,
  rule_text TEXT NOT NULL,
  enforcement_level TEXT NOT NULL DEFAULT 'soft',
  evaluation_type TEXT NOT NULL DEFAULT 'behavioral',
  evaluation_config TEXT,
  applies_to_roles TEXT,
  applies_to_min_age INTEGER,
  applies_to_max_age INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX constitution_rules_constitution_idx ON constitution_rules(constitution_id);

CREATE TABLE policy_events (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  conversation_id TEXT,
  rule_id TEXT,
  event_type TEXT NOT NULL,
  context TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX policy_events_family_idx ON policy_events(family_id, created_at);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  channel TEXT NOT NULL DEFAULT 'telegram',
  started_at TEXT NOT NULL,
  last_message_at TEXT,
  session_context TEXT
);
CREATE INDEX conversations_agent_idx ON conversations(agent_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER,
  cost_cents INTEGER,
  metadata TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at);

CREATE TABLE budget_ledger (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE activity_log (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  agent_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX activity_log_family_idx ON activity_log(family_id, created_at);

CREATE TABLE onboarding_state (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  step INTEGER NOT NULL DEFAULT 1,
  answers TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE instance_settings (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
  `;

  // Run all table creation in a transaction
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
  console.log("[db] Tables created");
}
