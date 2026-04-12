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
pnpm test                    # all tests (79 across 5 files)
pnpm --filter @carsonos/server test  # server tests only
```

Test files live next to source: `services/__tests__/`, `routes/__tests__/`
