# 0001 — The live family instance must not file-watch its own source

CarsonOS is a self-modifying runtime: agents delegate work that produces PRs against the host's own source. A naive file-watch auto-reload (e.g. `tsx watch` watching the repo) is incompatible with this — every Developer file write inside the watched tree triggers a host restart, which kills the in-flight specialist's session, which marks the delegated run as failed mid-modification.

We accept that file-watch is a developer convenience for the throwaway sandbox dev-loop (`pnpm dev:sandbox`) but a hazard for the live instance running on the family's machine. The live instance reloads via an explicit drain-and-restart triggered by a deliberate "apply pending merges" step, not by a file-system watcher. `pnpm dev:nowatch` and the installed service script (`scripts/install-service.sh`) are the supported live-instance entry points.

## Consequences

- Sandbox-mode worktrees and tool sandboxes (placed under `<repo>/.sandbox/...` when `DATA_DIR=$PWD/.sandbox`) must be in the `tsx watch` ignore list. Live-mode worktrees at `~/.carsonos/...` are already outside the watched cwd tree but are also ignored defensively.
- Any future "auto-reload on change" feature for the live instance must integrate with the run lifecycle (drain in-flight delegated runs first, then restart) rather than reacting to file events.
- Hot-reload is a `pnpm dev:sandbox` feature only. Don't re-suggest it for the live instance without reopening this ADR.
