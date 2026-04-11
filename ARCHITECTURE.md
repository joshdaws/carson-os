# CarsonOS Architecture

This document explains how CarsonOS works and why it's built the way it is. It's written for developers, AI agents exploring the codebase, and anyone who wants to build something similar.

## The Core Idea

A family installs CarsonOS on their local machine. Each family member gets a personal AI agent they talk to on Telegram. The agents have memory, tools, and personality — but they all operate within a family constitution that reflects the parents' values.

The head agent (Chief of Staff) manages the household. Other agents are personal assistants for individual family members. The system is self-hosted, private, and works with a Claude subscription — no API key needed.

## Design Principles

1. **Constitution first.** Every agent prompt starts with the family constitution. Values come before capabilities.

2. **Memory is files.** Markdown with YAML frontmatter, stored on disk, indexed by QMD. Not a database. Not a vector store you can't inspect. Files you can read, edit, and version control.

3. **Tools, not prompts.** Agents do things through MCP tools, not through prompt engineering. "Search memory" is a tool call, not a prompt trick. This makes capabilities composable, grantable, and auditable.

4. **Trust, not permission dialogs.** Instead of asking "can I do this?" on every action, agents have a trust level that determines their baseline capabilities. Full trust = full access. Restricted = conversation only.

5. **Works with your subscription.** The Claude Agent SDK uses your Claude subscription, not an API key. Same billing, no separate costs, no token management.

## The Pipeline

When a family member sends a message on Telegram, here's what happens:

```
User message (Telegram)
  │
  ├─ 1. Identify member (by Telegram user ID)
  ├─ 2. Load agent + member info from DB
  ├─ 3. Load constitution clauses (cached 5min)
  ├─ 4. Evaluate hard clauses (feature-flagged OFF for v1.0)
  ├─ 5. Compile system prompt (constitution first, then role/personality/memory instructions)
  ├─ 6. Resolve agent's tools (registry + grants + trust level)
  ├─ 7. Resume session if continuing a conversation (Agent SDK session resume)
  ├─ 8. Execute via Agent SDK (MCP tools, streaming, max 15 turns)
  │     ├─ Agent searches memory on demand via search_memory tool
  │     ├─ Agent may call tools: save_memory, update_memory, list_calendar_events, etc.
  │     ├─ Tool calls handled by MCP server inside the SDK
  │     └─ Text deltas stream back via onTextDelta callback
  ├─ 9. Stream formatted response to Telegram (edit-in-place)
  ├─ 10. Post-execution: scan response for policy violations
  ├─ 11. Record conversation + log tool calls
  └─ 12. Handle delegation (if agent deferred to another agent)
```

## The Adapter Layer

CarsonOS has a pluggable adapter system. The default is the Claude Agent SDK adapter.

### Claude Agent SDK Adapter (default)

Uses `query()` from `@anthropic-ai/claude-agent-sdk`. This spawns a Claude process, passes the system prompt, and lets the SDK handle the tool loop.

**Why not the Anthropic API?** Because it requires an API key. The Agent SDK uses the Claude subscription, which every Claude user already has.

**Why not the Claude CLI in `-p` mode?** Because `-p` is single-turn with no tool support. The Agent SDK supports multi-turn conversations with MCP tools.

**Session Resume:** Conversations maintain continuity via the Agent SDK's `resume` parameter. Each conversation stores a `sessionId` (on `conversation.sessionContext`), and subsequent messages resume the existing session rather than starting fresh. This gives agents memory of the conversation without replaying the full history.

**Model Selection:** Agents can use different Claude models — Sonnet 4.6 (default), Opus 4.6, or Haiku 4.5. The model is mapped to the Agent SDK's model parameter (`"sonnet"`, `"opus"`, `"haiku"`).

**How tools work:** We define tools as MCP tools using `tool()` and `createSdkMcpServer()` from the SDK. Each tool has a name, description, Zod schema, and async handler. The SDK presents them to Claude and handles the tool_use loop internally. Our code never touches the Anthropic API's tool_use protocol directly.

```typescript
const searchMemory = tool(
  "search_memory",
  "Search your memory for relevant information.",
  { query: z.string(), scope: z.enum(["personal", "household", "both"]).optional() },
  async ({ query, scope }) => {
    const results = await memoryProvider.search(query, collection);
    return { content: [{ type: "text", text: formatResults(results) }] };
  },
);

const mcpServer = createSdkMcpServer({
  name: "carsonos-memory",
  tools: [searchMemory, saveMemory, deleteMemory, ...],
});

const conversation = query({
  prompt: userMessage,
  options: {
    systemPrompt,
    mcpServers: { "carsonos-memory": mcpServer },
    allowedTools: ["mcp__carsonos-memory__search_memory", ...],
    tools: trustLevelBuiltins, // ["Bash", "Read", ...] or []
  },
});
```

### Streaming

Text deltas flow from the Agent SDK through an `onTextDelta` callback. The Telegram streaming engine:

1. Sends the first delta immediately (no delay)
2. Buffers subsequent deltas on a 300ms timer
3. Each edit converts accumulated text to Telegram HTML
4. Tracks open markdown constructs (code fences, bold) and auto-closes them
5. Falls back to plain text if HTML parsing fails
6. On completion, the message is already formatted — no flash

This is inspired by Hermes (raw delta buffering + edit-in-place) and OpenClaw (markdown-aware block chunking).

## Memory System

### Three Layers

**1. Memory Schema** — Defines what types of memories exist and their frontmatter structure. Thirteen types, inspired by research into Mem0, MemPalace, Letta, Capacities, and PKM systems:

- **Core:** fact, preference, event, decision, commitment
- **Entity:** person, project, media, place, relationship
- **Behavioral:** routine, goal, skill

Each type has typed frontmatter fields (topics, date, status, mediaType, frequency, proficiency, etc.). The schema is a config — adding new types requires no code changes.

**2. Knowledge Base** — Markdown files indexed by QMD. One QMD collection per family member, plus a shared household collection. Files have YAML frontmatter with type, title, topics, etc. Agents search memory on demand via the `search_memory` tool rather than having memory pre-loaded into the system prompt.

```yaml
---
id: 2026-04-10-grant-ap-history-exam
type: commitment
title: Grant's AP History exam
status: open
dueDate: 2026-04-25
topics: [school, AP History, Cold War]
source: Grant
---

# Grant's AP History exam

Grant has his AP History exam on April 25. Covers chapters 20-24 on the Cold War.
```

**3. Operating Instructions** — A document each agent maintains itself. Like a personal CLAUDE.md that grows from interactions. "Josh prefers bullet points." "Don't schedule during church on Sundays." Size-capped at 2000 characters.

### Search

QMD provides three search modes:
- `search` — BM25 keyword search (fast)
- `vsearch` — Vector similarity (semantic)
- `query` — Hybrid with LLM expansion + reranking (best quality, used by default)

CarsonOS uses `query` for the `search_memory` tool. Results include docid, score, title, snippet, and collection name.

### Memory Deduplication

Before saving a new memory, agents search for existing entries on the same topic. If a match is found, they use `update_memory` to update the existing entry in-place rather than creating a duplicate. The five memory tools are: `search_memory`, `save_memory`, `update_memory`, `delete_memory`, and `update_instructions`.

### MemoryProvider Interface

```typescript
interface MemoryProvider {
  search(query: string, collection: string, limit?: number): Promise<MemorySearchResult>;
  save(collection: string, entry: { type, title, content, frontmatter }): Promise<{ id, filePath }>;
  delete(collection: string, id: string): Promise<void>;
  list(collection: string, limit?: number): Promise<MemoryEntry[]>;
}
```

The default is `QmdMemoryProvider`. The interface is swappable for other backends (Mem0, Perplexity, etc.) via env var.

## Tool Registry

### Four Tiers

- **System** — Always on, not toggleable. `search_memory`, `save_memory`, `update_instructions`. Every agent gets these.
- **Builtin** — Ships with CarsonOS, toggleable per-agent. Calendar, Gmail, Drive tools.
- **Custom** — Agent-created or imported. Scripts the head agent writes, skills imported from skills.sh.
- **Discovered** — Found in `~/.claude/skills/`. Off by default. Labeled in UI as global Claude skills.

### Per-Agent Grants

The `tool_grants` table stores explicit grants: which agent gets which tools. If no explicit grants exist, role-based defaults apply. System tools are always included regardless.

### Trust Levels

Trust levels control Claude Code built-in tools (Bash, Read, Write, etc.), not CarsonOS MCP tools.

- **Full** — All built-ins including Bash, Write, Edit, and Skill. For the head agent and parent agents. The `Skill` built-in gives full-trust agents access to all installed Claude Code skills.
- **Standard** — Read-only built-ins (Read, Glob, Grep, WebFetch, WebSearch). For teenagers.
- **Restricted** — No built-ins. For young kids. Only CarsonOS MCP tools.

### Google Integration

Google services use the `gws` CLI with per-member config directories:

```
~/.carsonos/google/
  josh/     ← Josh's Google OAuth tokens
  becca/    ← Becca's Google OAuth tokens
```

One Google Cloud project, multiple OAuth tokens. Each family member authenticates once. The `GoogleCalendarProvider` wraps `gws` commands, setting `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` per member before each call.

Tools: `list_calendar_events`, `create_calendar_event`, `get_calendar_event`, `gmail_triage`, `gmail_read`, `gmail_compose`, `gmail_reply`, `gmail_update_draft`, `gmail_send_draft`, `drive_search`, `drive_list`.

Gmail uses a draft-first workflow: compose/reply create drafts, the user reviews in Gmail, then either sends from Gmail or tells the agent "send it."

## Constitution Engine

The constitution is the frame. It goes first in every system prompt.

For v1.0, enforcement is prompt-based only. Hard clause evaluators (keyword_block, age_gate, role_restrict) exist in code but are feature-flagged OFF. The constitution works by being the first thing the agent reads — it shapes all responses.

Two versions of the constitution:
- **Human-readable** — Full prose for dashboard display and editing
- **Agent-formatted** — Concise structured version injected into prompts

## Database

SQLite via Drizzle ORM. Single file at `~/.carsonos/carsonos.db`. Tables:

- `households` — Family name, timezone
- `family_members` — Name, age, role, telegram user ID, profile, memory dir override
- `staff_agents` — Name, role, personality, trust level, operating instructions, bot token
- `staff_assignments` — Which agents serve which members
- `constitutions` — Document text, version, active flag
- `constitution_clauses` — Individual rules with enforcement level and evaluation config
- `tool_grants` — Per-agent tool grants
- `conversations` / `messages` — Chat history
- `activity_log` — Tool call records for dashboard visibility
- `tasks` / `task_events` — Task system (future)

## First-Contact Behavior

When an agent encounters a family member for the first time (no prior conversation history), the prompt compiler injects a "Getting to Know [Name]" section instead of the usual "About [Name]" profile section. The agent suggests a profile interview — a short, natural conversation to learn about the person — rather than auto-compiling a profile from available data. This gives the member control over what the agent knows about them.

The profile interview collects information that becomes the member's profile, injected into the agent's system prompt for future conversations.

## What's Not Built Yet

- **Post-onboarding checklist** in the dashboard (constitution builder, personality setup, profile interviews)
- **Sub-agents** — Specialist agents (tutor, developer) that the Chief of Staff delegates to
- **Task system** — Long-running tasks with approval flows and progress tracking
- **Tool generation** — Head agent creating new tools (scripts) that other agents can use
- **Skills import** — Installing skills from skills.sh and registering them as tools
- **Tool-call notifications** — Italicized status text in stream during tool execution ("*Searching calendar...*")
- **Web UI chat** — Chat with agents from the dashboard (currently Telegram only)
- **Signal / WhatsApp / Slack** — Other messaging platforms

## Inspiration

CarsonOS is built on patterns from three projects:

- **mr-carson** — The prototype. Proved the concept of a family AI agent with memory, tools, and Telegram. CarsonOS extracts and systematizes mr-carson's patterns.
- **Hermes Agent** — Streaming architecture (producer-consumer delta buffering), concurrent tool execution, gateway platform abstraction.
- **OpenClaw** — Markdown-aware block chunking, agent event bus, multi-transport streaming (WebSocket/SSE/HTTP).
