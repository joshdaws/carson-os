# Changelog

All notable changes to CarsonOS will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.3.2] - 2026-04-19

Closes the orphan-file follow-up tracked against v0.3.1's Custom Tools Admin UI. SKILL.md files that exist on disk but have no matching registry row are now surfaced and importable from the dashboard.

### Added

- **Orphan banner on the Tools page.** When the loader finds SKILL.md files in `~/.carsonos/tools/{household}/` that have no matching `custom_tools` row, an amber banner appears above the filter tabs with a one-click open into the import modal. Common sources: hand-authored SKILL.md files, files synced from another machine without the DB, files restored from backup.
- **Import modal.** Lists every orphan with parsed metadata (name, description, kind), parse errors if the SKILL.md is malformed, and name-conflict warnings if a tool with that name already exists. Importable orphans are pre-selected with checkboxes; click "Import N tools" to insert the rows. Imports are attributed to the household's Chief of Staff (or first active agent as fallback) and registered immediately so the new tools are callable on the next message.
- **Two new admin routes:** `GET /api/tools/custom/orphans?household_id=` returns the parsed orphan list. `POST /api/tools/custom/import-orphans` takes `{household_id, paths: [...]}` and writes the rows + reloads the registry. Per-orphan failures (parse error, name conflict, missing handler.ts for script tools) are reported individually so a partial import doesn't abort the batch.

### Fixed

- **Route order in tools.ts** — `/custom/orphans` and `/custom/import-orphans` declared BEFORE `/custom/:id` so Express doesn't match `orphans` as the `:id` param.

### For contributors

- `walkForSkills` and `FoundSkill` are now exported from the custom-tools barrel.
- The orphan importer reuses the existing `parseSkillMd` helper for validation, so any tightening of SKILL.md parsing applies uniformly to fresh imports and boot-time loading.
- Frontmatter parsing in the modal is server-side (full subset YAML parser); the UI just displays what came back. No drift between what the importer accepts and what the loader accepts.

## [0.3.1] - 2026-04-19

A new dashboard page for the custom tool registry that shipped in v0.2.0. Manage every tool your agents have created or installed without leaving the browser.

### Added

- **Tools page in the dashboard.** New entry in the System nav (Wrench icon) at `/tools`. Shows every custom tool in your household with kind, status, the agent who created it, usage count, and last-used timestamp. Filter tabs for All / Pending / Active / Disabled / Broken with badge counts that pop in amber when there's something to look at.
- **Bundle grouping.** Tools that live in a bundle directory (path like `bundle/tool`) collapse into one expandable row. A 12-tool YNAB integration becomes a single `ynab (7 tools)` row with aggregate stats — total usage, latest last-used, status summary like "all active" or "2 pending". Click the chevron to expand and see member tools indented underneath. Single-member bundles fall through to a normal row, no extra nesting overhead.
- **Slide-out detail panel.** Click any tool to open a panel with parsed metadata (name, description, kind, version, source), a fully rendered SKILL.md (markdown via react-markdown + remark-gfm — same engine the Constitution and StaffDetail pages use), and a "Show raw SKILL.md" toggle for the curious.
- **Action buttons in the panel.** Approve a `pending_approval` script tool (triggers the existing content-hash refresh on the server). Toggle active/disabled. Soft-delete (marks the row disabled and unregisters from the live registry; files stay on disk so the action is recoverable).
- **Source attribution for installed skills.** When a tool came from `install_skill`, the panel surfaces a dedicated card with the source URL as a real `target=_blank` link and a "Check for updates" button. The button is disabled with a tooltip noting it's a future feature — the affordance is wired now so the eventual upstream-hash check only needs the backend route, not new UI.
- **Tool secrets management.** Section at the bottom lists every encrypted secret name (values are never shown — by design) with a delete button. Helper text reminds you that agents create new secrets through conversation using `store_secret`.

### For contributors

- New page at `ui/src/pages/Tools.tsx` (~900 lines), wired into `ui/src/App.tsx` and `ui/src/components/Layout.tsx`.
- Bundles are derived from the `path` column's first segment — no schema changes needed.
- Frontmatter parser is intentionally naive (regex over top-level scalar lines, allow-listed metadata keys). When SKILL.md spec stabilizes around a richer schema, swap in a real YAML parser.

## [0.3.0] - 2026-04-18

Voice messages, audio files, and photos now work end-to-end. Send a voice note and Carson transcribes it. Send a photo and Carson actually sees it. Plus a new Settings field for the Groq key and a hardened shutdown so dev iterations don't fight the relay.

### Added

- **Voice & audio transcription:** Voice messages and audio file attachments are transcribed via Groq Whisper (whisper-large-v3-turbo) and answered like text. Dedicated handlers send a "typing" indicator immediately so you know the agent is working.
- **Photo understanding (multimodal):** Photos go inline to the agent's actual model (Sonnet by default) as image content blocks. The agent sees the image directly and replies. Works with the Claude Max subscription via the Agent SDK, no Anthropic API key needed.
- **Local media cache:** Downloaded files land at `~/.carsonos/media/` keyed by Telegram's `file_unique_id` (stable across bots). 1-hour TTL with auto-prune every 30 minutes. Re-asking about an image within an hour skips the redownload.
- **Per-capability size guards:** Images up to 10MB, voice/audio up to 20MB, video up to 50MB, documents up to 20MB. Sizes checked from Telegram's update before any download starts. Friendly fallback message when exceeded.
- **Min audio guard:** Clips under 1KB are skipped (almost always silence/corrupt) instead of failing through to a Whisper error.
- **Document text injection:** Text-readable documents now inject up to 100K characters of content (was 10K) so the agent has more to work with.
- **Settings → Voice & Media section:** New field for `GROQ_API_KEY` in the Settings page. Saving the key updates `process.env` immediately, no restart needed.
- **Env hydration from instance_settings:** New boot-time service reads an explicit allow-list of platform secrets (currently just `GROQ_API_KEY`) from the SQLite `instance_settings` table into `process.env`. Operator env vars still win, the DB value only fills the gap. `ANTHROPIC_API_KEY` is intentionally excluded so the Claude Max subscription is never bypassed.

### Changed

- **Telegram message handlers:** Voice/audio split into dedicated handlers separate from the generic photo/document/sticker/video loop. Real Grammy `Context` is always passed through (the previous spread-the-context pattern was the root cause of the "I had trouble processing that" error).
- **Photo flow simplified:** Removed the Haiku pre-describe round-trip. Photos now go in the same LLM call as the user's message, one round-trip instead of two.
- **Whisper model:** `whisper-large-v3` to `whisper-large-v3-turbo` (faster, same quality).
- **Telegram polling timeout:** 30s to 3s long-poll. Updates still arrive instantly when present; this only changes how fast `runner.stop()` returns during a hot reload.
- **Shutdown handler:** Force-terminates WebSocket clients and HTTP keep-alives before closing the server, with a 4-second hard exit deadline. Hot reloads now release port 3300 cleanly so the new process can rebind without `EADDRINUSE`.
- **Multimodal adapter API:** `AdapterExecuteParams` and `ProcessMessageParams` accept an optional `attachments` array. When present, the Claude Agent SDK is called with `AsyncIterable<SDKUserMessage>` containing image content blocks instead of a string prompt.

### Fixed

- **Voice messages no longer crash on dispatch:** The generic media handler used to spread the Grammy `Context` to inject extracted text. Spreading a class instance loses prototype methods (`reply()`, `replyWithChatAction()`, API getters), so `handleMessage()` threw a `TypeError` that the outer catch reported as "I had trouble processing that." Replaced with an explicit `textOverride` parameter.

### Removed

- Dead code in `multi-relay-manager.ts`: unused `DEDUP_TTL_MS` constant, unused `taskEngine` injection, unused `editFormatted` private method, and a duplicate `InputFile` import inside `sendFormatted`.

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
