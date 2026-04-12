# CarsonOS

**Your family's values, your family's AI.**

CarsonOS is a self-hosted AI staff platform for families. Each family member gets their own AI agent on Telegram — with its own personality, memory, and tools — all governed by a family constitution that reflects your values. Open source, runs locally, works with your Claude subscription.

<!-- TODO: Add hero screenshot or demo GIF here -->

## What You Get

- **Personal agents** — Each family member gets their own AI on Telegram with a distinct personality
- **Memory that sticks** — Agents remember facts, preferences, events, and commitments across conversations
- **Calendar & email** — Check schedules, create events, draft emails (never sends without your OK)
- **A constitution** — Your family's rules and values, enforced across every agent
- **Trust levels** — A parent's agent has full system access; a 6-year-old's is locked down
- **Everything local** — SQLite database, markdown memory files, no cloud dependencies

## Prerequisites

| Dependency | Install | Why |
|------------|---------|-----|
| **Node.js 20+** | [nodejs.org](https://nodejs.org) or `nvm install 20` | Runtime |
| **pnpm** | `npm install -g pnpm` | Package manager (monorepo) |
| **Claude CLI** | `npm install -g @anthropic-ai/claude-code` | Agent runtime (uses your Claude subscription) |
| **QMD** | `npm install -g @anthropic-ai/qmd` | Local markdown search engine for memory |

Optional:
- **gws** — `npm install -g @anthropic-ai/gws` — Google Workspace CLI (Calendar, Gmail, Drive)

## Quick Start

```bash
git clone https://github.com/joshdaws/carson-os.git
cd carson-os

# Auto-check prerequisites, install deps, create data directory
./setup.sh

# Start the dev server
pnpm dev

# Open the onboarding flow
open http://localhost:3300/onboarding
```

Or manually:

```bash
pnpm install
mkdir -p ~/.carsonos
pnpm dev
```

Then open [http://localhost:3300/onboarding](http://localhost:3300/onboarding) and follow the 3-step setup:

1. **Family** — Name your household and add family members (name, age, role)
2. **Agent** — Create your first agent and optionally connect a Telegram bot
3. **Done** — Open Telegram and start chatting

<!-- TODO: Add onboarding screenshot -->

### Development Sandbox

If you're using CarsonOS for your family and also developing on it, use sandbox mode to keep them completely separate:

```bash
# Your family's instance (default — uses ~/.carsonos, port 3300)
pnpm dev

# Development sandbox (uses .sandbox/ in the project, port 3301)
pnpm dev:sandbox
```

The sandbox gets its own database, memory files, and Google auth directory. You can delete `.sandbox/` anytime without affecting your real data.

### Connecting Telegram

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Create a new bot (`/newbot`)
3. Copy the bot token
4. Enter it during onboarding, or add it later in the dashboard under Staff → your agent

### Connecting Google (optional)

Google Calendar, Gmail, and Drive integration uses the `gws` CLI:

```bash
# Create a Google Cloud project and download OAuth credentials
# See: https://console.cloud.google.com
mkdir -p ~/.carsonos/google/your-name
cp credentials.json ~/.carsonos/google/your-name/client_secret.json

# Authenticate
GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.carsonos/google/your-name gws auth login
```

Each family member authenticates separately with their own Google account.

## How It Works

```
Telegram message
  → Identify member (by Telegram user ID)
  → Load agent + member + constitution from DB
  → Compile system prompt (constitution first, always)
  → Resolve tools (memory, calendar, etc.) by trust level
  → Execute via Claude Agent SDK (streaming, multi-turn, MCP tools)
  → Stream response back to Telegram (edit-in-place)
  → Log conversation + tool calls
```

### System Prompt Order

The constitution comes first. Always.

```
# Family Constitution        ← THE FRAME — your values, your rules
# Behavioral Guidelines       ← Soft rules from constitution clauses
# Your Role                   ← What this agent does
# Your Personality             ← How this agent communicates
# Operating Instructions       ← Self-maintained behavioral notes
# About [Member Name]          ← Who they're talking to + profile
# How to Use Memory            ← Memory schema + tool instructions
# Your Capabilities            ← Trust level + enabled skills
```

### First Contact

When an agent talks to a family member for the first time, it suggests a profile interview — a short conversation to learn about the person. No auto-compiling; the agent asks and the member shares what they want.

### Session Resume

Conversations maintain continuity via Claude Agent SDK session resume. Each conversation tracks a session ID so the agent picks up where it left off.

## Memory

Three layers, all stored as local markdown files with YAML frontmatter:

1. **Knowledge Base** — QMD-indexed markdown files. One collection per family member + a shared household collection. Agents search memory on demand via the `search_memory` tool.

2. **Memory Schema** — 13 types (fact, preference, event, decision, commitment, person, project, media, place, routine, relationship, goal, skill) with typed frontmatter fields. Agents use `save_memory` and `update_memory` to manage entries, with dedup (search before save).

3. **Operating Instructions** — Per-agent self-maintained behavioral notes ("Josh prefers bullet points", "Don't schedule during church on Sundays"). Capped at 2000 characters.

```
~/.carsonos/memory/
  household/       <- shared family memory
  josh/            <- Josh's personal memory
  becca/           <- Becca's personal memory
  ...
```

Members can override their memory directory to point at an existing QMD-compatible knowledge base.

## Tools

Agents get tools based on their role and trust level:

| Tool | Description |
|------|-------------|
| `search_memory` | Search personal + household memory |
| `save_memory` | Save new memories (facts, events, etc.) |
| `update_memory` | Update existing memory entries in-place |
| `delete_memory` | Remove outdated memories |
| `update_instructions` | Maintain operating instructions |
| `list_calendar_events` | Check schedules (requires gws) |
| `create_calendar_event` | Create events (requires gws) |
| `gmail_*` | Read, draft, and manage email (requires gws) |
| `drive_*` | Search and list Drive files (requires gws) |

### Trust Levels

| Level | Built-in Tools | For |
|-------|----------------|-----|
| **Full** | Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, Skill | Parents |
| **Standard** | Read, Glob, Grep, WebFetch, WebSearch | Teenagers |
| **Restricted** | None (MCP tools only) | Young kids |

### Model Selection

Agents can use different Claude models:
- **Sonnet 4.6** (default) — Fast and capable
- **Opus 4.6** — Most capable
- **Haiku 4.5** — Fastest, lightest

## Project Structure

```
packages/
  shared/          <- Types: MemoryProvider, ToolDefinition, TrustLevel, etc.
  db/              <- SQLite schema + Drizzle ORM

server/
  src/
    index.ts                    <- Boot sequence
    app.ts                      <- Express routes + Vite dev middleware
    config.ts                   <- Environment config
    routes/                     <- API routes (onboarding, staff, settings, etc.)
    services/
      constitution-engine.ts    <- Core pipeline: prompt compilation + tool wiring
      prompt-compiler.ts        <- System prompt builder (ordered sections)
      subprocess-adapter.ts     <- Claude Agent SDK adapter (streaming, resume)
      tool-registry.ts          <- Tool registration, grants, trust levels
      telegram-streaming.ts     <- Edit-in-place streaming with markdown formatting
      multi-relay-manager.ts    <- One Telegram bot per agent
      memory/                   <- MemoryProvider, QMD provider, schema, tools
      google/                   <- Calendar, Gmail, Drive providers

ui/
  src/
    pages/
      Onboarding.tsx            <- 3-step setup flow
      Dashboard.tsx             <- Household overview
    components/                 <- Shared UI components
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3300` | Server port |
| `DATA_DIR` | `~/.carsonos` | Data directory (DB, memory, Google auth) |
| `CARSONOS_ADAPTER` | `anthropic-sdk` | Adapter: `anthropic-sdk`, `claude-code`, or `codex` |
| `CARSONOS_MEMORY_PROVIDER` | `qmd` | Memory backend |
| `CARSONOS_MEMORY_DIR` | `{DATA_DIR}/memory` | Memory file root |
| `CARSONOS_HARD_EVALUATORS` | `false` | Hard clause evaluators (off for v1.0) |

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design document covering:
- The message pipeline (Telegram → Constitution → Agent SDK → Tools → Response)
- Memory system (MemoryProvider interface, QMD backend, 13 memory types)
- Tool registry (4 tiers: system, builtin, custom, discovered)
- Constitution engine (prompt-based enforcement, two versions)
- Streaming architecture (edit-in-place, markdown-aware formatting)

## Roadmap

See [docs/roadmap.md](docs/roadmap.md) for the full roadmap. Current status:

- [x] **M1** — Memory system + Agent SDK adapter
- [x] **M2** — Google Calendar + Gmail + Drive
- [x] **M3** — Simplified onboarding
- [x] **M4** — Dashboard cleanup
- [x] **M5** — Ship prep (this release)
- [ ] **v1.1** — Task system + memory scoping + activity feed
- [ ] **v1.2** — Sub-agents + delegation
- [ ] **v1.3** — More connectors (YNAB, Todoist)

## License

[MIT](LICENSE)
