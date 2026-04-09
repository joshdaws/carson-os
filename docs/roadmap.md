# CarsonOS Roadmap

Status: Living document
Last updated: 2026-04-09

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

Not working: tools, memory, knowledge base.

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
# Your Role                  ← Job description (~200-400 tokens)
# Your Personality            ← Soul (~200-400 tokens)
# Operating Instructions      ← Self-maintained behavioral notes (~500 tokens cap)
# About [Member Name]         ← Combined: intro line + profile (~300-500 tokens)
# What You Know               ← Recent memories, ambient context (~500-800 tokens)
# How to Use Memory           ← From memory schema (~200 tokens)
```

Token budget guideline: ~2,500-3,500 tokens total system prompt. Not enforced,
just guidance for content length.

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
- [ ] SDK adapter tool_use loop (max 10 iterations, per-iteration timeout)
- [ ] MemoryProvider interface in @carsonos/shared
- [ ] QmdMemoryProvider (default: markdown files + QMD collections, no FTS5)
- [ ] Memory schema type + default schema (7 types with frontmatter)
- [ ] search_memory, save_memory, delete_memory tools
- [ ] Operating instructions: per-agent self-maintained doc + update tool
- [ ] Prompt compiler reorder: constitution first, combined member section
- [ ] Feature-flag hard clause evaluators (off for v1.0)
- [ ] Ambient memory injection into system prompt
- [ ] Memory collections auto-created at boot from family members table
- [ ] Per-member memoryDir override (point at existing brain directory)
- [ ] Memory provider config via env vars (kind, rootDir)
- [ ] Memory provider swappable via module path for third-party backends
- [ ] Tool-call activity logging (before smoke test)
- [ ] Pre-populate test household: members, agents with roles/souls/profiles

#### M2: Google Calendar (1-2 days)

- [ ] Google OAuth2 flow (user creates own Google Cloud project, localhost redirect)
- [ ] list_calendar_events, create_calendar_event, get_calendar_event tools
- [ ] Calendar tools wired into SDK adapter alongside memory tools
- [ ] Agent can answer "what do we have this week?" with real data
- [ ] Agent can create events from Telegram conversation

#### M3: Onboarding Polish (1 day)

- [ ] Smooth 3-phase flow: Family -> Staff -> Connect (per commit b274d4e)
- [ ] No broken states or janky transitions
- [ ] Auto-create one personal agent per family member
- [ ] Telegram bot token entry integrated into agent setup

#### M4: Dashboard Cleanup (0.5 day)

- [ ] Hide tasks, delegation, specialist pages behind feature flag
- [ ] Overview shows: family members, agents, recent conversations
- [ ] Settings page has Google Calendar OAuth section
- [ ] Knowledge & Memory section (view memories, future: wiki browser)
- [ ] No dead links or broken navigation

#### M5: Ship Prep (0.5 day)

- [ ] README with install instructions, prerequisites, screenshots
- [ ] setup.sh script for first-run
- [ ] Demo GIF/video
- [ ] X announcement post
- [ ] MIT license

### Total: ~5-6 days

## Post-MVP Roadmap

### v1.1 — Tasks & Activity

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
