# CarsonOS

Family AI agent platform. Each family member gets a personal AI on Telegram with memory, tools, and personality, governed by a family constitution.

## Critical Rules

- **NEVER delete, reset, or recreate `~/.carsonos/carsonos.db`**. This is the family's live data (conversations, agents, constitution, profiles). Use `pnpm dev:sandbox` for destructive QA testing.
- **NEVER delete files in `~/.carsonos/memory/`**. These are the family's memories.
- Before any schema migration, backup the database (the boot sequence does this automatically).

## Development

```bash
pnpm dev           # family's live instance — port 3300, ~/.carsonos data
pnpm dev:sandbox   # throwaway QA — port 3301, .sandbox/ data
pnpm typecheck     # type check all packages
pnpm test          # run all tests
```

## Stack

- **Server:** TypeScript, Express 5, Claude Agent SDK, SQLite (Drizzle ORM), QMD (memory search)
- **UI:** React, Vite, TanStack Query, Tailwind-adjacent inline styles
- **Monorepo:** pnpm workspaces — `packages/shared`, `packages/db`, `server`, `ui`

## Architecture

- System prompt order: Constitution first, then role, personality, operating instructions, member profile, memory schema, capabilities
- Memory: 13 types, QMD-backed markdown files, agents search on demand via `search_memory` tool
- Tools: MCP tools via Claude Agent SDK. System tools always on, builtin tools toggleable, trust levels control Claude built-in access
- Agents: Claude Agent SDK with session resume, streaming to Telegram via edit-in-place

## Testing

```bash
pnpm test                    # all tests (153 across 8 files)
pnpm --filter @carsonos/server test  # server tests only
```

Test files live next to source: `services/__tests__/`, `routes/__tests__/`

## Work routing

Three-way rule for deciding how to do something:

- **Deterministic** (same input → same output, no judgment) → plain code / service call / cron. No LLM.
- **Judgment-requiring** (synthesis, writing, deciding between options) → the calling agent does it inline via its existing `query()`. Don't spawn anyone.
- **Agent-to-agent handoff** (long-running, different persona, different model, different tools) → `delegate_task` to a hired specialist (Developer / Tutor / Scheduler).

If in doubt, prefer the smaller option. Agents are for judgment; they are not general-purpose runtime.

## Telegram Media

- Voice/audio transcribed via Groq Whisper (`whisper-large-v3-turbo`). Set `GROQ_API_KEY` in env or via Settings UI.
- Photos go inline to the agent's model as Anthropic image content blocks (multimodal). Uses Claude Max subscription via Agent SDK — no `ANTHROPIC_API_KEY` needed.
- Downloaded media cached at `~/.carsonos/media/` keyed by Telegram `file_unique_id`, 1-hour TTL.
- Per-capability size guards: image 10MB, voice/audio 20MB, doc 20MB, video 50MB. Min audio 1KB.
