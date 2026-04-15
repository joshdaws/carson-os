# Changelog

All notable changes to CarsonOS will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] - 2026-04-15

Custom tool registry: agents can now create, register, and invoke their own tools at runtime.

### Added

- **Custom tools:** Agents create HTTP, prompt, or script tools through conversation. Files live as `SKILL.md` on disk (compatible with Claude Code skills), optionally paired with `handler.ts` for script tools. Stored under `~/.carsonos/tools/{household-id}/`.
- **Eight new agent-facing system tools:** `create_http_tool`, `create_prompt_tool`, `create_script_tool`, `list_custom_tools`, `update_custom_tool`, `disable_custom_tool`, `store_secret`, `install_skill`.
- **Three tool kinds:**
  - **http** — declarative REST wrapper with auth injection (bearer/header/query), domain allowlist, timeout, response cap.
  - **prompt** — markdown instruction template, returned to the agent as tool result content for in-session execution.
  - **script** — full TypeScript handler compiled via esbuild at first invocation, runs with household-scoped `CustomToolContext`.
- **`install_skill` pipeline:** Install skills from GitHub via `owner/repo`, `owner/repo/subpath`, `owner/repo@skill-name`, `skills.sh/owner/repo/...`, full GitHub URLs, or direct HTTPS `.tar.gz` URLs. Matches the `vercel-labs/skills` ecosystem. Fetches via `codeload.github.com` (no git binary required).
- **Secret storage:** AES-256-GCM encryption for per-household API tokens. Key derived from `CARSONOS_SECRET` env var (recommended) or auto-generated keyfile at `~/.carsonos/.secret`. Boot-time health check walks every stored secret and reports partial or total decryption failures.
- **Mid-session tool refresh:** New tools become available in the same conversation they're created in, via `setMcpServers` refresh.
- **`canUseTool` runtime enforcement:** Gates every tool invocation against the agent's grant list. Replaces the declarative tool list that was nullified by the SDK's `bypassPermissions` mode.
- **Activity log redaction:** Tool inputs AND results (not just `store_secret` inputs) are scrubbed against every household secret before landing in `activity_log`. Structured walk of the record avoids the JSON-escape edge case.
- **`redact_recent_user_message` tool:** Let an agent scrub the user's last message after processing sensitive content (e.g. API tokens pasted into chat).
- **`get_agent_guide` tool:** Lazy-loaded markdown playbooks attached as agent-guides co-located with their module. Keeps system prompts lean.
- **Admin routes:** `/api/tools/custom` (CRUD), `/api/tools/custom/:id/approve`, `/api/tools/custom/:id/content`, `/api/tools/custom/orphans`, `/api/tools/secrets`.
- **Tool-grant dashboard:** Custom tools appear alongside built-ins in the staff UI (routes shipped, React UI deferred).

### Changed

- **Turn limit raised** from 15 → 50 (`CARSONOS_MAX_TURNS` env var, 1–200 range). Previously silent stops at 15 turns now surface as a graceful message.
- **Tool name validation loosened** to accept hyphens (`find-skills`, `youtube-transcript`) for skills-ecosystem compatibility. Still rejects uppercase, dots, slashes, whitespace, and traversal.
- **Bundle name validation tightened** to lowercase-only, preventing silent path collisions on case-insensitive filesystems (HFS+/APFS, Windows).
- **Subprocess adapter schema bridge** supports numbers, booleans, arrays, and nested objects in `input_schema` (previously coerced most types to `z.string`).

### Security

- **11 findings from dual Claude + Codex adversarial review, all fixed:**
  - `install_skill` rollback now tracks every side effect (filesystem, DB, registry, grant) and compensates in reverse on any failure.
  - HTTP executor strips auth headers on cross-origin redirects (compares full host:port, not just hostname).
  - Tarball filter counts every entry toward the cap, not just files/directories (blocks a symlink-stuffing CPU denial vector).
  - Script tools compiled to `/tmp` with `mkdir 0700` / `file 0600`. Previously inherited umask exposed inlined literals on shared machines.
  - `update_custom_tool` validates the complete update before any disk write (no more partial-state on validation failure).
  - Create-time uniqueness check moved inside per-tool mutex. DB insert runs first; file write failures roll back the row.
  - `install_skill` rejects reserved system tool names and their hyphen-variant aliases.
  - `renameSync` fallback to `cpSync + rmSync` when staging and destination are on different filesystems (Linux `tmpfs` + `$HOME`).
- **`CARSONOS_SECRET` backup documented** in README, with loss-recovery instructions.

### Developer

- **141 tests total (up from 79):** 53 new tests for SKILL.md parsing, path validation, atomic writes, content hashing, secret encryption, prompt executor, and install source parsing (9 URL formats verified).
- **Dependencies added:** `tar@^7.5.13` (archive extraction), `@types/tar@^7.0.87`, `esbuild@^0.25.11` (script tool compilation).

## [0.1.0] - 2026-04-11

Initial open source release.

### Added

- **Onboarding:** 3-step setup flow (Family, Agent, Done) with Telegram bot token entry
- **Constitution engine:** Prompt-based enforcement with constitution-first system prompt ordering
- **Memory system:** 13 memory types (fact, preference, event, decision, commitment, person, project, media, place, routine, relationship, goal, skill) backed by QMD markdown search
- **Memory tools:** search_memory, save_memory, update_memory, delete_memory, update_instructions with dedup (search before save)
- **Google integration:** Calendar (list, create, get events), Gmail (triage, read, compose, reply, drafts), Drive (search, list) via gws CLI
- **Claude Agent SDK adapter:** Streaming responses, MCP tool execution, session resume, model selection (Sonnet 4.6, Opus 4.6, Haiku 4.5)
- **Trust levels:** Full (Bash + all tools), Standard (read-only), Restricted (memory tools only)
- **Telegram streaming:** Edit-in-place with markdown-aware formatting and debouncing
- **Dashboard:** Household overview, family member cards, agent management, Getting Started checklist
- **Staff management:** Add/edit agents with modal form, model selector, trust level, Telegram bot config, tool grants, operating instructions, personality interviews
- **Profile interviews:** First-contact behavior suggests profile interview instead of auto-compiling
- **Personality interviews:** Build agent personality through guided conversation
- **Constitution interviews:** Build family constitution through guided conversation
- **Settings page:** Adapter config, household name/timezone (loads from DB correctly)
- **Conversations page:** View conversation history with member/staff filters
- **Dev sandbox:** `pnpm dev:sandbox` for isolated development on port 3301
- **Security:** CORS middleware (same-origin only), member slug sanitization (path traversal prevention)
- **setup.sh:** Prerequisite checks, dependency install, data directory creation
- **MIT license**
