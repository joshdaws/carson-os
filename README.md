# CarsonOS

**Your family's values, your family's AI.**

CarsonOS is a self-hosted digital staff platform for families. Each family member gets their own AI agent on Telegram with its own personality, memory, and tools. Everything is governed by a family constitution that reflects your values. Open source, runs locally, works with your Claude subscription.

## What It Does

Install CarsonOS on your machine, walk through a 3-step setup (name your family, create your agent, connect Telegram), and you have a personal AI assistant that:

- **Remembers things** across conversations (powered by QMD, a local markdown knowledge base)
- **Checks your calendar** and can create events (Google Calendar via gws)
- **Reads and drafts emails** for you (Gmail, draft-first — never sends without approval)
- **Searches your Google Drive** for documents
- **Stays within your family's rules** via a constitution you define
- **Learns how to help you** through operating instructions it maintains itself

Each family member can have their own agent with their own personality, tools, and trust level. A 6-year-old's agent is locked down (no Bash, no email). A parent's agent has full access.

## Architecture

```
┌─────────────────────────────────────────────┐
│                  Telegram                    │
│         (one bot per agent)                  │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│            Multi-Relay Manager               │
│  Streaming (edit-in-place) + debouncing      │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│           Constitution Engine                │
│  System prompt compilation + policy          │
│  enforcement (prompt-based for v1.0)         │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│          Claude Agent SDK Adapter            │
│  MCP tools + streaming + trust levels        │
│  Uses your Claude subscription (no API key)  │
└──────────────────┬──────────────────────────┘
                   │
        ┌──────────┼──────────┐
        ▼          ▼          ▼
   ┌─────────┐ ┌────────┐ ┌────────┐
   │ Memory  │ │Calendar│ │ Gmail  │
   │  (QMD)  │ │ (gws)  │ │ (gws)  │
   └─────────┘ └────────┘ └────────┘
```

**Key design decisions:**
- Agents use the Claude Agent SDK, not the Anthropic API — works with your Claude subscription
- Tools are MCP servers managed by the SDK — the tool loop is handled internally
- Memory is markdown files with YAML frontmatter, indexed by QMD for hybrid search
- Google services use the `gws` CLI — one auth per family member, per-member config dirs
- Streaming uses edit-in-place on Telegram with markdown-aware formatting

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design document.

## Prerequisites

- **Node.js 20+** (recommended: use nvm)
- **Claude CLI** — `npm install -g @anthropic-ai/claude-code` (requires Claude subscription)
- **QMD** — `npm install -g @tobilu/qmd` (local markdown search engine)
- **gws** (optional) — `npm install -g @anthropic-ai/gws` (Google Workspace CLI)
- **pnpm** — `npm install -g pnpm`

## Quick Start

```bash
# Clone and install
git clone https://github.com/joshdaws/carson-os.git
cd carson-os
pnpm install

# Start the server
pnpm dev

# Open http://localhost:3300/onboarding in your browser
# Follow the 3-step setup: Family → Agent → Done
```

### Connecting Telegram

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Create a new bot (`/newbot`)
3. Copy the bot token
4. Enter it during onboarding (or add it later in the dashboard)

### Connecting Google (Calendar, Gmail, Drive)

```bash
# Copy your Google Cloud credentials (or create new ones at console.cloud.google.com)
mkdir -p ~/.carsonos/google/your-name
cp credentials.json ~/.carsonos/google/your-name/client_secret.json

# Authenticate
GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.carsonos/google/your-name gws auth login
```

Each family member authenticates separately with their own Google account.

## System Prompt Order

The constitution comes first. Always.

```
# Family Constitution        ← THE FRAME — your values, your rules
# Behavioral Guidelines       ← Soft rules from constitution clauses
# Your Role                   ← What this agent does
# Your Personality             ← How this agent communicates
# Operating Instructions       ← Self-maintained behavioral notes
# About [Member Name]          ← Who they're talking to + profile
# What You Know                ← Ambient memory (recent/relevant entries)
# How to Use Memory            ← Memory schema + tool instructions
```

## Tools

CarsonOS has a tool registry with four tiers:

| Tier | Description | Default | Examples |
|------|-------------|---------|----------|
| **System** | Every agent gets these, always | On | search_memory, save_memory, update_instructions |
| **Builtin** | Ships with CarsonOS, toggleable per-agent | Role defaults | calendar, gmail, drive |
| **Custom** | Agent-created or imported | Off | scripts, skills |
| **Discovered** | Found in ~/.claude/skills/ | Off | content-writer, web-scraper |

### Trust Levels

Trust levels control what Claude Code built-in tools an agent can use:

| Level | Built-in Tools | Use Case |
|-------|----------------|----------|
| **Full** | Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch | Parent's agent |
| **Standard** | Read, Glob, Grep, WebFetch, WebSearch | Teenager's agent |
| **Restricted** | None — MCP tools only | Young kid's agent |

## Memory Architecture

Three layers of memory, all stored as local markdown files:

1. **Memory Schema** — Defines 13 memory types with YAML frontmatter fields:

   | Type | Description | Example |
   |------|-------------|---------|
   | `fact` | Concrete information | "Elsie's soccer practice is Tuesdays at 5pm" |
   | `preference` | Likes, dislikes, ways of working | "Grant prefers short explanations" |
   | `event` | Things that happened | "We went to Disney World this week" |
   | `decision` | Choices made | "We decided to homeschool starting fall 2026" |
   | `commitment` | Promises and obligations | "Josh promised to coach the spring league" |
   | `person` | Contact info and relationship notes | "Dr. Kim, pediatrician, office on 5th" |
   | `project` | Ongoing efforts with status | "Kitchen renovation, started March, contractor is Mike" |
   | `media` | Books, movies, shows, articles, podcasts | "Watched Jaws again, Quint's monologue is about survivor's guilt" |
   | `place` | Locations, restaurants, schools | "The cabin in Tahoe, great for summer trips" |
   | `routine` | Recurring habits and schedules | "Grant has basketball Tue/Thu after school" |
   | `relationship` | Connections between people | "Tyler coaches Grant's team, our closest family friends" |
   | `goal` | Aspirations and targets | "Get Claire into the school play by October" |
   | `skill` | Things people know or are learning | "Grant is learning to code, started with Python" |

2. **Knowledge Base** — QMD-indexed markdown files. One collection per member + a shared household collection. Searchable via hybrid search (BM25 + vector + LLM reranking)
3. **Operating Instructions** — Per-agent self-maintained behavioral notes. The agent updates these itself as it learns how to help you

```
~/.carsonos/memory/
  household/       ← shared family memory
  josh/            ← Josh's personal memory (or point at existing brain)
  becca/           ← Becca's personal memory
  grant/           ← Grant's personal memory
```

Members can override their memory directory to point at an existing QMD-compatible knowledge base.

## Project Structure

```
packages/
  shared/          ← Types: MemoryProvider, ToolDefinition, TrustLevel, etc.
  db/              ← SQLite schema + Drizzle ORM (households, agents, tools, etc.)

server/
  src/
    config.ts              ← Environment config (memory, features, adapter)
    index.ts               ← Boot sequence
    app.ts                 ← Express routes + Vite dev middleware
    routes/                ← API routes (onboarding, staff, health, etc.)
    services/
      subprocess-adapter.ts     ← Claude Agent SDK adapter (MCP tools, streaming)
      constitution-engine.ts    ← Core pipeline: prompt compilation + tool wiring
      prompt-compiler.ts        ← System prompt builder (7 sections, ordered)
      tool-registry.ts          ← Tool registration, grants, trust levels
      telegram-streaming.ts     ← Edit-in-place streaming with markdown formatting
      multi-relay-manager.ts    ← One Telegram bot per agent
      memory/                   ← MemoryProvider, QMD provider, memory schema
      google/                   ← Calendar, Gmail, Drive tool handlers

ui/
  src/
    pages/Onboarding.tsx   ← 3-step setup flow
    pages/Dashboard.tsx    ← Household overview + agent hierarchy
    components/            ← Shared UI components
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3300 | Server port |
| `DATA_DIR` | ~/.carsonos | Data directory (DB, memory, Google auth) |
| `CARSONOS_ADAPTER` | anthropic-sdk | Adapter: `anthropic-sdk` (Agent SDK) or `claude-code` |
| `CARSONOS_MEMORY_DIR` | {DATA_DIR}/memory | Memory file root |
| `CARSONOS_HARD_EVALUATORS` | false | Enable hard clause evaluators (off for v1.0) |

## Roadmap

- [x] **M1** — Memory system + Agent SDK adapter
- [x] **M2** — Google Calendar + Gmail + Drive
- [x] **M3** — Simplified onboarding + Chief of Staff language
- [ ] **M4** — Dashboard cleanup + post-onboarding checklist
- [ ] **M5** — Ship prep (setup.sh, demo, license)
- [ ] **v1.1** — Task system + activity feed
- [ ] **v1.2** — Sub-agents + delegation (tutor, developer, scheduler)
- [ ] **v1.3** — More connectors (YNAB, Todoist, etc.)
- [ ] **v2.0** — Full tool registry + governance
- [ ] **v2.x** — Generated tools + skills.sh import + Code Mode

## License

MIT
