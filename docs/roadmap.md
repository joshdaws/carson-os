# CarsonOS Roadmap

Status: Living document
Last updated: 2026-04-19

## Vision

A household staff of digital agents that help a family stay organized and
coordinated. Each family member gets their own agent on Telegram with its
own personality. Everything governed by a family constitution. Open source,
runs locally.

## Current State (v0.x)

Working: dashboard, onboarding (needs polish), agent CRUD, constitution
(auto-generated + enforced via prompt), Telegram multi-bot relay, member
profiles (via first-contact), conversation history, settings, task system
(working but deferred from MVP).

Working (added in MVP): memory system (QMD-backed, 13 types, search/save/update/delete
tools), Google Calendar + Gmail + Drive (via gws), session resume, model selector
(Sonnet/Opus/Haiku), trust levels + skill access, first-contact profile interviews,
memory deduplication (search before save + update_memory).

Working (v0.2.0): custom tool registry — agents create their own HTTP, prompt, and
script tools at runtime. `install_skill` pulls from GitHub (skills.sh ecosystem
compatible). AES-256-GCM secret storage. Mid-session tool refresh. Activity log
redaction. 11 security findings from dual Claude + Codex adversarial review all
fixed before merge. See `CHANGELOG.md` v0.2.0.

Working (v0.3.0): Telegram media handling, end-to-end. Voice messages and audio
attachments transcribe via Groq Whisper. Photos go inline to the agent's actual
model as Anthropic image content blocks (multimodal, one round-trip). Local media
cache at `~/.carsonos/media/` with 1-hour TTL keyed by `file_unique_id`.
Per-capability size guards (image 10MB, voice/audio 20MB, doc 20MB, video 50MB).
New env-hydration service reads an allow-list of platform secrets (currently just
`GROQ_API_KEY`) from `instance_settings` into `process.env` at boot —
`ANTHROPIC_API_KEY` is intentionally excluded so the Claude Max subscription is
never bypassed. Settings UI gains a "Voice & Media" section with live env update
on save (no restart). Shutdown handler hardened: hot reloads release port 3300
cleanly, no more `EADDRINUSE` zombies. See `CHANGELOG.md` v0.3.0.

Working (v0.3.1): Custom Tools admin UI. New dashboard page at `/tools` that
consumes the v0.2.0 admin routes — list every custom tool with bundle grouping
(tools sharing a directory collapse into one expandable row with aggregate
stats), slide-out detail panel with parsed metadata + fully rendered SKILL.md
(markdown via react-markdown), approve / toggle / soft-delete actions, source
attribution and a stub "Check for updates" button for installed skills, secrets
manager (key names only — values are never returned). Two follow-ups remain
in TODOS.md: orphan file importer and the upstream update check that backs the
stubbed button. See `CHANGELOG.md` v0.3.1.

Working (v0.3.2): Orphan SKILL.md importer. SKILL.md files that exist on disk
but have no matching `custom_tools` row are now surfaced via an amber banner
on the Tools page, openable into a modal that lists each orphan with parsed
metadata, parse errors, and name conflicts. One-click batch import attributes
the rows to the household's CoS and reloads the registry. Two new admin
routes: `GET /api/tools/custom/orphans` and `POST /api/tools/custom/import-orphans`.
Closes one of the two v0.3.1 follow-ups. See `CHANGELOG.md` v0.3.2.

## MVP (v1.0) — "Announce on X"

Design doc: ~/.gstack/projects/joshdaws-carson-os/joshdaws-feature/tool-registry-architecture-design-20260409-163500.md

### What v1.0 delivers

A family can install CarsonOS locally, walk through onboarding, set up agents
on Telegram, and have genuinely useful conversations. Agents remember things
across sessions, can check the family calendar, and stay within the
constitution. Parents can see everything in the dashboard.

### System Prompt Order (MVP)

```
# Family Constitution        ← Agent-formatted (concise, structured). THE FRAME.
# Behavioral Guidelines       ← Soft rules from constitution clauses
# Your Role                  ← Job description
# Your Personality            ← Soul / communication style
# Operating Instructions      ← Self-maintained behavioral notes (2000 char cap)
# About [Member Name]         ← Intro line + profile (or first-contact instructions)
# How to Use Memory           ← Memory schema + tool instructions
# Your Capabilities           ← Trust level + enabled skills
```

Ambient memory injection was removed — agents search memory on demand via the
`search_memory` tool, keeping the system prompt lean.

Two versions of the constitution:
- Human-readable (full prose, for dashboard display and editing)
- Agent-formatted (concise structured version, injected into prompts)

Hard clause evaluators (keyword_block, age_gate, role_restrict) are feature-flagged
OFF for v1.0. Constitution enforcement is prompt-based only at MVP.

### Milestones

#### M1: Memory System + Adapter tool_use

The memory architecture has three layers:

**1. Memory Schema (household-level, parent-configured, ships with default)**

Defines what memory types exist and their frontmatter structure. Injected
into agent prompts as instructions for how to work with knowledge.

Default types:
- `fact` — Concrete information ("Elsie's soccer practice is Tuesdays at 5pm")
- `preference` — Likes, dislikes, ways of working ("Grant prefers short explanations")
- `event` — Things that happened ("We went to Disney World this week")
- `decision` — Choices made ("We decided to homeschool starting fall 2026")
- `commitment` — Promises and obligations, with open/completed status
- `person` — Contact information and relationship notes
- `project` — Ongoing efforts with status tracking

Each type has its own frontmatter fields. Commitments have `status: open|completed`.
Projects have `status: active|paused|completed`. Etc.

**2. Knowledge Base (household + per-member, agent-maintained via tools)**

QMD-indexed flat markdown files with YAML frontmatter. One QMD collection per
scope, all managed by the existing QMD daemon. Exposed as Anthropic SDK tools:
`search_memory`, `save_memory`, `delete_memory`.

Default file layout:
```
{dataDir}/memory/
  household/       → qmd collection "household" (shared family memory)
  josh/            → qmd collection "josh"
  becca/           → qmd collection "becca"
  grant/           → qmd collection "grant"
  claire/          → qmd collection "claire"
  hudson/          → qmd collection "hudson"
```

Collections auto-created at boot from the family members table via
`qmd collection add <path> --name <name>`.

Members can override their memory directory to point at an existing brain.
For example, Josh can point his at `~/projects/brain` to use his existing
784-entry knowledge base as-is. No migration or import needed — the files
are already QMD-compatible markdown with YAML frontmatter.

Recent entries loaded into system prompt as ambient context via
`qmd search` (vector search by default, same as Mr. Carson).

The knowledge base backend is a pluggable `MemoryProvider` interface (4 methods:
search, save, delete, list). Default: QMD provider (markdown files + QMD
collections). QMD is a required dependency. Swappable for Perplexity, Mem0,
or any system that implements the interface.

**3. Operating Instructions (per-agent, self-maintained)**

A document the agent maintains itself — its procedural memory for how to
behave. Like a personal CLAUDE.md that grows from interactions.

- "Josh prefers bullet points over paragraphs"
- "Never suggest pork recipes for this family"
- "When Elsie says she's frustrated, ask what part is confusing"

Size-capped. Periodically compressed (agent consolidates redundant entries).
Injected into the agent's system prompt alongside soul and constitution.

Deliverables:
- [x] SDK adapter tool_use loop (max 15 turns via Agent SDK)
- [x] MemoryProvider interface in @carsonos/shared
- [x] QmdMemoryProvider (default: markdown files + QMD collections, no FTS5)
- [x] Memory schema type + default schema (13 types with frontmatter)
- [x] search_memory, save_memory, update_memory, delete_memory tools
- [x] Operating instructions: per-agent self-maintained doc + update_instructions tool
- [x] Prompt compiler reorder: constitution first, combined member section
- [x] Feature-flag hard clause evaluators (off for v1.0)
- [x] Memory search on demand via search_memory tool (ambient injection removed)
- [x] Memory collections auto-created at boot from family members table
- [x] Per-member memoryDir override (point at existing brain directory)
- [x] Memory provider config via env vars (kind, rootDir)
- [x] Memory provider swappable via module path for third-party backends
- [x] Tool-call activity logging (before smoke test)
- [x] Pre-populate test household: members, agents with roles/souls/profiles
- [x] Memory deduplication: search before save + update_memory tool
- [x] Session resume via Agent SDK resume parameter
- [x] Model selector: Sonnet 4.6, Opus 4.6, Haiku 4.5

#### M2: Google Calendar + Gmail + Drive (1-2 days) ✅

- [x] Google OAuth2 flow (user creates own Google Cloud project, gws CLI)
- [x] list_calendar_events, create_calendar_event, get_calendar_event tools
- [x] Gmail tools: triage, read, compose, reply, update_draft, send_draft
- [x] Drive tools: search, list
- [x] Calendar tools wired into SDK adapter alongside memory tools
- [x] Agent can answer "what do we have this week?" with real data
- [x] Agent can create events from Telegram conversation

#### M3: Onboarding Polish (1 day) ✅

- [x] Smooth 3-phase flow: Family → Agent → Done
- [x] No broken states or janky transitions
- [x] Telegram bot token entry integrated into agent setup
- [x] First-contact behavior: agent suggests profile interview instead of auto-compiling
- [x] "Butler" scrubbed from all user-facing text → "Chief of Staff"

#### M4: Dashboard Cleanup (0.5 day) ✅

- [x] Hide tasks, delegation, specialist pages behind feature flag
- [x] Overview shows: family members, agents, recent conversations
- [x] Settings page has Google Calendar OAuth section
- [x] Knowledge & Memory section (view memories, future: wiki browser)
- [x] No dead links or broken navigation

#### M5: Ship Prep (0.5 day) ✅

- [x] README with install instructions, prerequisites, quick start, project structure
- [x] setup.sh script for first-run (prerequisite checks + install + data dir)
- [x] MIT license
- [x] ARCHITECTURE.md updated for session changes
- [ ] Demo GIF/video (post-launch)
- [ ] X announcement post (post-launch)

### Total: ~5-6 days

## Post-MVP Roadmap

### v1.1 — Memory Scope & Tasks

- Memory scope follows assignment graph:
  - Chief of Staff (serves whole family) → searches all member collections + household
  - Personal agents → search only their assigned member's collection + household
  - "What kids share stays private from other kids. Parents can see everything."
- Bring back the task system (already built, just hidden)
- Activity feed showing tool calls, memory saves, calendar actions
- Parent approval flow for sensitive actions via Telegram

### v1.2 — Specialist Agents & Delegation

- Specialist agents (tutor, coach, scheduler) as internal agents
- Personal agent delegates to specialists via task system
- Tool scope per agent role (specialists get different tools)
- Tool registry (from docs/tool-registry-architecture.md Phase 1)

### v1.3 — More Connectors

- Additional tools: YNAB (budget), Gmail, Todoist
- Each as an optional connector with OAuth config in Settings
- Connector = pluggable tool set behind the same MemoryProvider-style interface

### v2.0 — Tool Registry & Governance

- Full tool registry from docs/tool-registry-architecture.md
- Scope resolution, delegation policy, trust levels
- CarsonOversight integration for tool-level approval
- Scope snapshots on approved tasks

### v2.x — Extensions & Code Mode

- Extension packaging (install/enable/disable tools)
- Generated extensions (head agent creates tools)
- Imported extensions (skills.sh, community sources)
- Code Mode execution runtime (sandboxed TypeScript)

### Future

- Knowledge base wiki browser in dashboard
- Memory schema editor in dashboard
- Karpathy-style lint/health checks on knowledge base
- Cross-household anonymized insights (opt-in)
- Mobile app (or PWA)
- Voice integration (beyond Telegram)
