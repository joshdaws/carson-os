# CarsonOS

Family AI agent platform. Each family member gets a personal AI on Telegram with memory, tools, and personality, governed by a family constitution.

## Critical Rules

- **NEVER delete, reset, or recreate `~/.carsonos/carsonos.db`**. This is the family's live data (conversations, agents, constitution, profile mirror). Use `pnpm dev:sandbox` for destructive QA testing.
- **NEVER delete files in `~/.carsonos/memory/`**. These are the family's memories.
- **NEVER delete files in `~/.carsonos/members/` or `~/.carsonos/agents/`**. These hold the canonical identity files — member profiles (`USER.md`) and agent personalities (`PERSONALITY.md`) — which are the source of truth; the DB columns are only a sync mirror.
- Before any schema migration, backup the database (the boot sequence does this automatically).

## Development

```bash
pnpm dev           # family's live instance — port 3300, ~/.carsonos data
pnpm dev:sandbox   # throwaway QA — port 3301, .sandbox/ data
pnpm typecheck     # type check all packages
pnpm test          # run all tests
```

## Stack

- **Server:** TypeScript, Express 5, harness layer (Claude Agent SDK / Codex CLI), SQLite (Drizzle ORM), QMD (memory search)
- **UI:** React, Vite, TanStack Query, Tailwind-adjacent inline styles
- **Monorepo:** pnpm workspaces — `packages/shared`, `packages/db`, `server`, `ui`

## Architecture

- System prompt order: Constitution first, then role, personality, operating instructions, member profile, memory schema, capabilities
- Memory: 13 types, QMD-backed markdown files, agents search on demand via `search_memory` tool
- Tools: MCP tools. For Claude agents, in-SDK MCP; for Codex agents, a loopback streamable-HTTP MCP server at `/internal/codex-mcp` (same tools, full parity). System tools always on, builtin tools toggleable, trust levels control Claude built-in access
- Harness layer (`server/src/services/harness/`): the engine routes each turn by `agent.model` through a registry to a `Harness` — `claude` (wraps the Agent SDK adapter) or `codex` (shells out to the `codex` CLI under a ChatGPT subscription, no `OPENAI_API_KEY`). Per-harness session storage in `conversations.session_context` keeps both runtimes' resume tokens so model switches are lossless. See ARCHITECTURE.md "The Harness Layer" and `docs/adr/0002`
- Agents: harness with session resume, streaming to Telegram via edit-in-place. Per-agent model + reasoning-effort picker in the staff detail UI

## Testing

```bash
pnpm test                            # all tests (567 across 35 files)
pnpm --filter @carsonos/server test  # server tests only (vitest, 517 tests)
pnpm --filter @carsonos/ui test      # ui tests only (vitest + happy-dom + RTL, 50 tests)
```

Test files live next to source. Server: `services/__tests__/`, `routes/__tests__/`. UI: `components/__tests__/`, `components/ui/__tests__/`. UI vitest config is `ui/vitest.config.ts`; setup file at `ui/src/test/setup.ts` polyfills `ResizeObserver` + `matchMedia` for radix primitives. New UI tests must render through `IconButtonTooltipProvider` when they touch IconButton (App.tsx wires it at the route root).

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

## Agent skills

### Issue tracker

GitHub Issues on `joshdaws/carson-os` via the `gh` CLI. External issues are gated through the triage state machine — agents only act on `ready-for-agent`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, label string equals role name: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Deploy Configuration (configured by /setup-deploy)

CarsonOS is a **single-machine local service** — not a cloud platform. It runs on Josh's Mac as a launchd user agent (`com.carsonos.server`), serving the family's Telegram bots and a localhost UI. There is exactly one production environment. There is no staging.

- **Platform:** launchd (macOS user agent)
- **Plist:** `~/Library/LaunchAgents/com.carsonos.server.plist`
- **Production URL:** `http://127.0.0.1:3300`
- **Project type:** backend (Express + tsx) + UI (React/Vite, served from `ui/dist/` in production)
- **Deploy target:** Josh's Mac only — `/land-and-deploy` from any other machine merges the PR but cannot run the service update step
- **Deploy workflow:** none in CI. Deploy is a local shell script.

### Deploy commands

- **Pre-merge:** none — `/ship` handles VERSION bump, CHANGELOG, and tests
- **Deploy trigger (post-merge):** `./scripts/update-service.sh` — pulls main, installs deps, builds UI + server, restarts launchd service
- **Deploy status:** `launchctl print gui/$(id -u)/com.carsonos.server | grep -E 'state|pid'`
- **Restart only (no pull/build):** `./scripts/restart-service.sh`
- **Health check:** `curl -sf http://127.0.0.1:3300/api/health` — expects 200 with JSON `{status: "ok", version, adapter.healthy: true, memory.reindex.errorCount: 0}`

### Merge method

Squash. PR titles use `vX.Y.Z <type>: <summary>` prefix per `/ship`'s workspace-aware ship rule.

### Custom deploy hooks

- **Pre-merge:** none — `/ship` already runs typecheck + 567 tests + adversarial review
- **Deploy trigger:** `./scripts/update-service.sh` (manual on the family Mac, or auto by `/land-and-deploy` when running on that machine)
- **Deploy status:** `launchctl list | grep com.carsonos.server` shows PID + last exit code; `last terminating signal` field flags SIGKILL/SIGTERM
- **Health check:** `http://127.0.0.1:3300/api/health` (single endpoint, fast, idempotent)

### Operational notes

- The launchd plist has unconditional `KeepAlive: true` (set in v0.5.7) — graceful SIGTERM exits respawn automatically. Existing installs need `./scripts/install-service.sh` once if their plist still has the old conditional KeepAlive.
- Restarts interrupt in-flight Telegram conversations briefly. Schedule deploys when family activity is low if it matters.
- The local working tree IS the deployed code — `pnpm start` runs `tsx src/index.ts` directly. There is no separate build artifact for the server (UI is bundled to `ui/dist/`).
- **Never delete `~/.carsonos/carsonos.db` or `~/.carsonos/memory/`** — see "Critical Rules" above. The boot sequence backs up the DB to `~/.carsonos/backups/` automatically.
