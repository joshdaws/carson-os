# Contributing to CarsonOS

Thanks for your interest in contributing. CarsonOS is an early-stage project and we welcome pull requests.

## Getting Started

```bash
git clone https://github.com/joshdaws/carson-os.git
cd carson-os
./setup.sh        # checks prerequisites, installs deps
pnpm dev:sandbox  # starts on port 3301 with isolated data
```

The sandbox uses `.sandbox/` for its database and memory files, so you can develop without affecting a real CarsonOS installation at `~/.carsonos`.

## Prerequisites

- Node.js 20+
- pnpm
- Claude CLI (`npm install -g @anthropic-ai/claude-code`)
- QMD (`npm install -g @anthropic-ai/qmd`)
- gws (optional, for Google integration)

## Project Structure

```
packages/
  shared/     <- Types shared across server and UI
  db/         <- SQLite schema (Drizzle ORM)
server/       <- Express backend + Claude Agent SDK adapter
ui/           <- React frontend (Vite)
```

## Development Workflow

1. Create a feature branch: `git checkout -b feat/your-feature`
2. Make your changes
3. Run type checking: `pnpm typecheck`
4. Test in the browser: `pnpm dev:sandbox` and open http://localhost:3301
5. Commit with a descriptive message: `git commit -m "feat: add thing"`
6. Push and open a PR against `main`

## Commit Messages

Use conventional commits:

- `feat:` new features
- `fix:` bug fixes
- `chore:` maintenance, config, deps
- `docs:` documentation changes
- `refactor:` code changes that don't add features or fix bugs

## What to Work On

Check the [roadmap](docs/roadmap.md) for planned work. Issues labeled `good first issue` are a good starting point.

Areas that need help:

- **Tests** -- the project has minimal test coverage
- **API authentication** -- currently no auth on API routes (localhost-only for now)
- **Web chat** -- chat with agents from the dashboard (currently Telegram only)
- **Additional messaging platforms** -- Signal, WhatsApp, Slack

## Code Style

- TypeScript throughout (server and UI)
- No semicolons in the UI (Vite default), semicolons in the server
- Prefer `const` over `let`, avoid `var`
- Keep functions small and focused
- No unnecessary abstractions for one-time operations

## Reporting Bugs

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (OS, Node version, browser)

## Questions?

Open a discussion or issue on GitHub.
