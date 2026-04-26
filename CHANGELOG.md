# Changelog

All notable changes to CarsonOS will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.4.1.0] - 2026-04-25

### Performance

- **Resumed chat turns now send only the new user message to the Agent SDK.** The DB transcript remains the source of truth for dashboard/history, but resumed Claude sessions no longer replay the last 50 messages on every Telegram turn. Fresh sessions still get recent history, now selected as the newest 50 messages rather than the oldest 50.
- **Lean resumed prompts are available as an opt-in experiment.** Set `CARSONOS_LEAN_RESUME=true` to send a compact resume prompt when the constitution/profile/tool context signature is unchanged. Runtime MCP tool registration still refreshes every turn, so tool additions and grant changes are not hidden from the SDK.
- **Telegram text debounce is adaptive and faster for normal messages.** Single short messages now flush after 150ms, while multi-message paste bursts still get the 1.5s buffering window.
- **Telegram typing indicators no longer block model startup.** Chat actions are fired in the background so the engine can start compiling context and calling the Agent SDK immediately.
- **Telegram work queues are scoped by agent + member.** One member's long turn no longer blocks another member talking to the same agent bot. Delegation wake turns serialize through the same agent/member queue as user traffic.
- **Tool access is resolved once per turn.** Built-in tools, enabled skills, and MCP tool definitions share one DB/grant resolution pass instead of repeating agent/grant lookups during prompt and executor setup.
- **Google Calendar/Gmail/Drive handlers are request-scoped.** Parallel conversations can no longer overwrite the shared registry's member-specific Google handlers.
- **Telegram streaming now coalesces stale edits.** The first delta still sends immediately, but later partial responses collapse to the newest snapshot instead of queueing every intermediate `editMessageText` call behind Telegram latency.
- **Lightweight latency tracing.** Telegram, engine, and adapter logs now share a per-turn trace id with timings for debounce, history loading, context/prompt build, tool resolution, Agent SDK duration, first model delta, first Telegram edit, edit count, prompt/message sizes, context/tool signatures, actual SDK init tool/MCP counts, and token usage when the SDK reports it.
- **QMD memory scope searches run in parallel.** `search_memory` still uses the same thorough QMD path, but the default personal + household search no longer waits for those two scopes sequentially.
- **Telegram member/assignment checks use a short in-memory cache.** Normal repeat messages avoid redundant identity/assignment DB reads while keeping the cache TTL to 60 seconds.
- **SQLite is tuned for the chat hot path.** DB startup now sets WAL + `synchronous=NORMAL` + `busy_timeout=5000`, and creates chat/constitution lookup indexes for both fresh and existing databases.

### Notes

- QMD memory search quality is unchanged. CarsonOS continues to use the thorough hybrid `qmd query` path for memory lookups; only independent scopes are parallelized.
- No explicit acknowledge/progress tool was added in this release; streaming remains the primary perceived-latency improvement.

## [0.4.0.0] - 2026-04-23

## **Carson can hire specialists now. You text Carson, Carson proposes a hire, you tap Approve on Telegram, a Developer shows up on staff and starts working. Results come back when they're done.**

This is the delegation release. The core v0.1 idea — a family Chief of Staff that knows everyone — gains the missing half: Carson can now recognize when a job is too big for one conversation turn and hand it to a hired specialist (Developer for tools/projects/core, Researcher, Tutor, Music specialist, whatever the family needs). The specialist runs async in its own workspace, can take as long as it needs, and messages you back on completion. The conversation stays responsive the whole time.

### What lands

- **Propose-hire flow.** Carson calls `propose_hire({role, specialty, reason, proposedName?, customInstructions?, model?, trustLevel?, originalUserRequest?})`. An approval card goes to the principal's Telegram with inline Approve/Reject buttons. On approve, a `staff_agents` row materializes with the specialty template as operating instructions, a `delegation_edges` row wires Carson to the new specialist, and — if `originalUserRequest` was set — Carson auto-delegates the user's original ask so the principal doesn't have to re-prompt.
- **Workspace provisioning.** `project` and `core` specialties get a per-task git worktree under `~/.carsonos/worktrees/{project}/{runId}` on a fresh `carson/{slug}` branch. `tools` specialty gets a scratch sandbox under `~/.carsonos/sandbox/{runId}`. Teardown is idempotent.
- **Two-phase exactly-once notifier.** Prepare writes `notify_payload` + terminal status in one UPDATE. Deliver sends via Telegram, upserts a `delegation_notifications` row, then atomic-flips `notified_at` under a conditional WHERE gate. If the bot is down, reconciler replays on boot + hourly. No duplicates, no drops.
- **MCP delegation tools.** `delegate_task`, `propose_hire`, `cancel_task`, `list_active_tasks`, `register_project` — granted by default to `head_butler` and `personal` agents, gated by `delegation_edges` + `delegationDepth` (max 2).
- **Developer-with-tools bypass.** A hired Dev with `specialty='tools'` gets `canCreateActiveTools=true` and the 8 custom-tool management grants at hire-time — the Dev builds and installs tools directly without per-tool principal approval (the hire card was the approval).
- **UI surfaces.** New `/projects` page for explicit project registration. Tasks page renders hire-proposal cards with Approve/Reject + full customInstructions + trustLevel + originalUserRequest visible. Tools page gains an Add Secret form with AES-256-GCM encrypted storage. Household page splits the flat staff grid into "Personal agents" (the ones you text with) and "Staff" (hired specialists Carson delegates to).

### Security review (22 findings, all fixed before merge)

Adversarial review caught:

- **Hire approval kind gate.** `handleHireApproval/Rejection` now refuses to materialize a staff agent unless `task.description.kind === 'hire_proposal'`. Prevents any pending task from being promoted into phantom staff via `/approve-hire`.
- **Authorization on Telegram callback.** Inline Approve/Reject buttons verify `ctx.from.id` resolves to a `familyMembers` row with `role='parent'`. Kids, guests, and forwarded-message recipients get denied.
- **Same-origin gate on `/api`.** State-changing routes (POST/PUT/PATCH/DELETE) require `Origin` or `Referer` matching the dashboard origin. Blocks local-process curls — including Dev agents with Bash — from hitting mutation endpoints without spoofing headers.
- **Path traversal defense.** `POST /api/projects` validates `name` against a slug regex and `path` against absolute-no-traversal. `workspace.provisionWorktree` defensively `resolve()`s the final path and rejects any escape from the worktrees root.
- **Hire card transparency.** `composeHireCardText` surfaces the effective `model` + `trustLevel` + the first 400 chars of `customInstructions` verbatim, so the principal sees what will actually boot instead of a hardcoded specialty template description.
- **Exactly-once invariant.** After approve/reject, `notifyPayload` is cleared and `notifiedAt` flipped so the replay scan can't resurrect dead hire cards on every boot. After sweep-expires, `notifiedAt` is reset to null so the cancellation message actually delivers.
- **Cross-member isolation.** `list_active_tasks` now filters by `requestedBy=ctx.memberId`. A kid's personal agent can't see parent task previews.
- **Data integrity.** `DELETE /projects/:id` returns 409 if referencing tasks exist. Fresh-install table order puts `projects` before `tasks` so FK references resolve in declaration order. `redact_recent_user_message` no longer double-encodes `messages.metadata` against the JSON column.

### Fixed

- **Delete hired agents works.** `DELETE /api/staff/:id` cascades all FK references in a sync transaction (better-sqlite3 enforces `foreign_keys=ON`). Blocks with 409 if the agent has active tasks or live custom tools. Cleans messages → conversations → task_events → delegation_notifications → tasks, plus tool_grants, scheduled_tasks, delegation_edges, assignments, personality_interview_state, and the `grants_seeded:<id>` boot marker.
- **`update-service.sh` and `install-service.sh` run `pnpm build`.** Closes #17. The launchd/systemd plist runs with `NODE_ENV=production`; without `ui/dist/` on disk, the server 404s every GET `/` until someone builds manually.
- **Telegram bot retry on transient network errors.** `ETIMEDOUT`, `ECONNRESET`, `EAI_AGAIN`, `ENETUNREACH`, `ECONNREFUSED`, "socket hang up", and "fetch failed" now trigger 5s/15s/45s backoff retries instead of a zombie-bot state. Auth errors fail fast.
- **Phase-2 notifier replay runs after `multiRelay.startAll()`.** Splits `recoverStuckTasks` into Phase-1 (DB writes, early boot) and `replayPendingNotifications` (delivery, after the bot is wired).
- **Conversation freshness.** `getOrCreateConversation` rotates after 2h of silence based on `lastMessageAt`, not UTC-today. History injection adds `[time note: Nh Mm since the previous message]` markers when gaps exceed 30 minutes. System prompt declares the current time with triple-stated timezone to prevent paraphrase hallucinations.

### Mid-release refinements (2026-04-24)

Four stacked commits fixing architectural gaps surfaced during v0.4 E2E testing.
All Codex-reviewed; 236 tests pass (up from 218).

- **Cancel actually stops compute.** Was flipping a DB flag but the Agent SDK worker kept running ~5 min, then its final `completed` event clobbered the `cancelled` status. Now: `AbortController` threaded through to `query()` so abort kills the CLI subprocess; `notifier.prepare` refuses to overwrite a cancelled row (cancel-sticky WHERE guard); dispatcher checks prepare's `{updated}` return so log/broadcast/deliver side effects skip on refused writes; `handleCancelTask` uses compare-and-swap so two concurrent cancels fire exactly one broadcast.
- **N:M delegation grants.** Split "hired" from "has access." A specialist like Dev is hired once via `propose_hire`; any personal agent can be granted delegation access via new `grant_delegation` / `revoke_delegation` MCP tools (CoS-only) or via checkboxes on the staff detail page. Topology is strict tree — no personal→personal, no self-grants, no re-delegation. Legacy `/staff/:id/delegations` endpoints now route through the same service-level validation.
- **Proactive wake + `read_task_result`.** Kills the templated "✅ Tool build finished" card. On task completion the delegator's agent runs a turn on its existing SDK session with a plain-prose task-completion brief and replies in voice. Follow-ups pull the full specialist output via a new `read_task_result({runId})` tool (delegator-OR-requester auth, household-scoped). Serialization shares the per-agent queue with user traffic so a wake can't race an in-flight user turn on the same session. On any wake non-delivery, dispatcher falls back to the templated notifier; on wake success, `markDeliveredByWake` flips `notified_at` so the restart reconciler doesn't replay the templated card.
- **UI polish.** `/tasks` now resolves `agent_id` + `requested_by` to real names via batched household-scoped joins (was "Unknown agent" + raw UUID). Hire announcement text is threaded into the CoS conversation scoped to `channel=telegram` so the resumed SDK session sees the new staff member in history on the next turn (closes the "X isn't on staff yet" stale-cache bug). Web-UI hire approval now edits the Telegram approval card to "✅ Approved" and strips the buttons via new `editMessage` helper on `multi-relay` + `delivered_message_id` lookup — was leaving live buttons in the chat for users to race-tap.

### Known deferrals

Documented in `TODOS.md` as v0.5 work:

- **Scope `ctx.db` in custom-tool handlers** — a compromised Dev with `specialty='tools'` can read other households' `tool_secrets` via the unscoped Drizzle client. Single-family today = low practical risk.
- **`apply-update` preserves script-tool approval invariant** — upstream can currently push new `handler.ts` code and have it go active on a single click without re-approval.
- **Workspace crash-safety** — server crash between `git worktree add` and the DB UPDATE orphans branches that permanently block retry by title.
- **Signal transport delegation UX** — Signal-only users currently have no inline-button equivalent; approval flow needs the web-UI deep-link path or keyword-reply parsing.
- **Detached Claude adapter** — durability upgrade so Dev tasks survive server restarts. v0.4 is demo-grade; 20min of Dev work lost on reboot.

### Itemized changes

#### Added

- **v0.4 delegation schema** — `projects`, `delegation_notifications` tables; `tasks` columns `delegation_depth`, `project_id`, `workspace_kind`, `workspace_path`, `workspace_branch`, `timeout_sec`, `approval_expires_at`, `notify_payload`, `notified_at`, `notify_agent_id`.
- **`DelegationService`** (~1100 lines) with `handleDelegateTaskCall`, `handleHireProposal`, `handleHireApproval/Rejection`, `handleCancelTask`, `handleProjectCompleted`.
- **`WorkspaceProvider`** with `provision` (worktree + tool_sandbox), `teardown`, `branchExists`, defense-in-depth path-traversal guards, `slugify` for branch names.
- **`DelegationNotifier`** with `prepare`, `deliver`, `findPendingDelivery`, `threadIntoConversation`, atomic `flip`.
- **`dispatcher.executeDeveloperTask`** + `executeSpecialistTask` + `sweepExpiredApprovals` + `replayPendingNotifications` + `handleCancelBroadcast`.
- **`specialty-templates/`** — curated operating instructions for `tools.md`, `project.md`, `core.md`, plus `cos-delegation-preamble.md` and `composeGenericSpecialistInstructions` for arbitrary specialists.
- **Telegram `callback_query:data` handler** wired to hire approval with parent-role gate.
- **UI: `/projects`** new page + route. **`/tools/secrets`** POST endpoint with AES-256-GCM via `encryptSecret`. **`/tasks`** hire-proposal detail panel with Approve/Reject. **Household** Personal vs Staff split.
- **`seedMissingDefaults`** boot-time reconciler so agents created before a tool's default-grant gets retroactive access.
- **`POST /api/tasks/:id/approve-hire` and `/reject-hire`** — web-UI fallback when Telegram is down / user isn't set up on Telegram.

#### Changed

- **`tasks.requestedBy` threads through delegation depth** — child tasks inherit `requestedBy` from the calling turn's member id so completion routes correctly.
- **`notifyAgentId`** routes completion to a specific agent (usually the kid's personal agent) instead of the dispatcher's caller agent.
- **Delegation tools tier=`builtin`** with `DEFAULT_GRANTS` mapping by role.
- **Home-button `Dashboard` renamed to `Household` in the sidebar, Tasks gets badge count from pending/approved/in-progress.**
- **Conversation idle timeout 2h** with `[time note: Nh]` markers in history.

#### Removed

- **`delegate-parser.ts` XML-block parsing.** MCP `delegate_task` is the only delegation entry point in v0.4.
- Dead private methods `getOrCreateConversationId` (signal-relay) and `getConversationId` (multi-relay) — legacy v0.3 paths.
- Dead filter tautology in `GET /api/tasks/projects`.

#### For contributors

- **218 tests passing** (up from 153 in v0.3.x). New suites: `DelegationService` (9 tests), `DelegationNotifier` (8 tests), `WorkspaceProvider` (12 tests), `summary-card` (6 tests), `delegate-parser` (5 tests, legacy).
- **Design pattern:** atomic conditional UPDATE gates (`WHERE status = 'pending'`) keep approve/reject races safe. The `notified_at` flip-invariant does the same for exactly-once delivery.
- **Prior learnings logged:** Drizzle double-encode against JSON columns, CarsonOS API localhost-bypass, hire-card must surface overrides, kind-gate before race-gate.

## [0.3.4] - 2026-04-19

Closes the second of the two v0.3.1 follow-ups: the disabled "Check for updates" button on installed skills now actually works.

### Added

- **Upstream update check.** Click "Check for updates" in an installed skill's detail panel and CarsonOS re-fetches the source URL through the same pipeline `install_skill` uses, finds the matching tool by name, and compares the upstream content hash against the locally stored `approvedContentHash`. Returns either "Up to date", "Update available" with an Apply button, or "The upstream source no longer contains a tool named X" if it was renamed/removed upstream.
- **Apply update.** When an update is available, click Apply and the new files atomically replace the local copy. Existing dir is moved to a `.bak` sibling, the upstream gets promoted into the canonical path, then the backup is removed. If anything fails, the backup is restored so a half-applied update never strands you. The DB row's `approvedContentHash`, `generation`, and `schemaVersion` all bump on success and the registry is reloaded so the new version is callable on the next message.
- **Two new admin routes:** `GET /api/tools/custom/:id/check-update` and `POST /api/tools/custom/:id/apply-update`. Both clean up their staging tarball on every exit (success or failure).

### Fixed

- **`install_skill` accepts `https://skills.sh/...` URLs.** The parser only recognized bare `skills.sh/owner/repo`. Users copy URLs from the browser address bar with the protocol prefix; that now parses cleanly. One-line regex change.
- **The minimal YAML parser handles continuation array items at the same indent.** Real-world example: `allowed-tools:` followed by `  - Read`, `  - Write`, etc. The pop-stack logic was using `<=` and over-popped the array frame after the first item, throwing "Unexpected '-' at line N" on every multi-element array. Common enough that humanizer's upstream SKILL.md (v2.1.1) hit it, which is why the update check kept reporting "upstream missing" before this fix.
- **`prepareInstall` is resilient to one bad SKILL.md.** Previously, a single skill with YAML the parser couldn't handle would fail the whole install or update-check batch. Now bad skills are logged with a `[install] Skipping skill...` warning and the rest of the bundle proceeds.

### For contributors

- Exposed `prepareInstall`, `promoteTool`, `cleanupStaging`, `ResolvedSkillEntry`, `InstallResult`, and `InstallError` from the custom-tools barrel for reuse by the new update routes.
- The atomic-swap pattern in apply-update (rename existing → promote → rmSync backup, with restore on failure) is the right shape for any future "replace files in place" workflow.

## [0.3.3] - 2026-04-19

### Fixed

- **Skills installed via `install_skill` are now tagged correctly.** The handler used to write `source: "skill_install"` to the registry row and never set `source_url`. The schema documents the legal value as `"installed-skill"` and the Tools UI checks for that exact string + a non-empty `sourceUrl` before showing the Installed Skill card and the "Check for updates" button. Net effect: every skill installed via the proper flow looked indistinguishable from an agent-created tool. Now installs land as `source: "installed-skill"` with the full source URL persisted.

### For contributors

- Existing rows written before this fix retain their old source value. To backfill, run `UPDATE custom_tools SET source='installed-skill', source_url='<url>' WHERE name='<tool>';` against `~/.carsonos/carsonos.db`. The fix only catches new installs.

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
