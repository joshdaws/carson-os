# Changelog

All notable changes to CarsonOS will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.5.5] - 2026-05-03

### Added

- **Instrument Serif now ships in product chrome.** The webfont was loaded in `index.html` since the project shipped, but every page heading hardcoded `style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}` inline — system Georgia fell through and DESIGN.md's "the butler earns a serif" identity only ever reached the onboarding flow. v0.5.5 adds a Tailwind `font-serif` utility (`'Instrument Serif', Georgia, 'Times New Roman', serif`) and routes all 26 product-chrome heading sites through it. Sidebar brand, every page heading, every modal title, MissionRevealCard, Onboarding all now render the loaded webfont. Closes the impeccable critique 2026-05-03 P0.
- **Empty-instance Dashboard butler hero.** A fresh install no longer lands on three "0 of these, 0 of those" zone-cards. Members + staff are both empty → render a single composed hero with a time-aware Instrument Serif greeting ("Good morning." / "Good afternoon." / "Good evening."), one paragraph in the butler voice, one prominent navy "Set up your household" CTA. Once a household exists the existing zone layout returns. Closes the impeccable critique P1.
- **URL-backed search and filters for Tasks and Conversations** (UI audit #48). Both pages now use react-router's `useSearchParams`. Tasks gains `?status` `?agentId` `?memberId` `?q` (free-text search across title, description, result, report, agent name, requester) and `?task=...` (selected detail). Conversations gains `?memberId` `?agentId` `?q` (search across member / agent / lastMessage) and `?c=...` (selected thread). Both pages got search inputs with explicit aria-labels. Tasks added a Clear button when filters are active. Bookmark / share / reload all preserve exactly what the user was looking at. Pre-v0.5.5 the filters lived in local component state, so a filtered view couldn't be linked.

### Changed

- **FormField primitive now supports compound children** via a new `controlId` prop. The v0.5.3 FormField used `cloneElement` to inject `id` / `name` / `autoComplete` / `aria-*` onto its child — works for plain inputs, breaks for radix `<Select>` (the Select root doesn't accept those props). Setting `controlId` skips the cloneElement step; the caller threads `id={controlId}` onto the actual focusable child (e.g. `<SelectTrigger>`) themselves. Required for the v0.5.5 Settings / Household / Schedules form migrations, all of which have role / model / trust-level / timezone Selects. Documented contract for error states: when `controlId` mode is used, callers must thread `aria-invalid` and `aria-describedby` manually if the field can have errors.
- **Settings / Projects / Household / Schedules forms migrated to FormField** (UI audit #51). Pre-v0.5.5 these used `<label>` siblings without `htmlFor`, missing `name` and `autoComplete`, with error/required state signaled through copy alone. Now every label links via `htmlFor`, browser autofill works correctly, errors render in `role="alert"` regions. Modal forms (AddStaffModal, NewScheduledTaskModal, EditMemberForm) wire `useDirtyGuard` so closing-while-dirty prompts before discarding — Cancel button, X icon, outside-click, and Escape key all route through `guardClose`.
- **Dashboard cards left-aligned + sub-12px text floor lifted** (impeccable critique P2). FamilyMemberCard / PersonalAgentCard / InternalAgentCard converted from `text-center` to `text-left` — centered card grids are a recognizable AI tell. Body text below 12px (`text-[9px]` and `text-[10px]`) lifted to `text-xs` (12px) per the slop framework's readability floor. Short uppercase tracking labels still use the smaller sizes per the rule's exception.

### Fixed

- **Dashboard empty-state collision with sidebar Household nav.** The fallback page title `householdName || "Household"` rendered "Household" identically to the sidebar Household nav item, making it impossible to tell which page you were on (cognitive load failure). Fallback is now "Welcome to CarsonOS"; the page title is omitted entirely while the empty hero is showing.
- **Empty Dashboard hero gate hardened against loading races and internal-only staff.** Fires only when both `householdData` and `staffData` have actually loaded AND members/staff are both empty. Prevents the hero from flashing during slow API responses, and from misfiring when the user has internal-only staff configured but no household members yet.
- **Conversations selected-thread metadata now resolves from the unfiltered list.** Pre-fix, typing a search that excluded the open `?c=abc` thread collapsed the message-pane header to "?", "Unknown agent" — and on mobile, where the list pane is hidden, the user would get trapped. Reading from `allConversations` keeps the open thread coherent regardless of what the visible filter narrows to.
- **Modal Escape key now closes via `guardClose`.** AddStaffModal and NewScheduledTaskModal are raw `<div>` modals (not radix Dialog), so they don't get Escape handling for free. Pressing Escape now goes through the same dirty-guard path as Cancel + X + outside-click.
- **Household memory-folder FormField restructure.** The field was wrapping a `<div>` containing the `<Input>` + Check/X validation icons, so `cloneElement` injected `id` + `aria-invalid` on the wrapper div instead of the input. Label-click didn't focus, "Directory not found" wasn't described by the actual control. Now FormField wraps the `<Input>` directly; validation icons sit beside it.
- **Tasks search now actually searches the task body.** The comment promised "title + body" but the predicate only checked title / agentName / requestedByName. Searches against `description` / `result` / `report` silently returned nothing. Fixed: predicate now matches all six fields.
- **MCP server names stable across conversation turns** (post-release hotfix, 2026-05-04). `subprocess-adapter.ts` was generating server names of the form `carsonos-memory-{Date.now()}-{counter}` with the counter declared inside `execute()`, so every conversation turn produced a new unpredictable name. The Claude Agent SDK exposes MCP tools as `mcp__{server-name}__{tool-name}`; when the LLM resumed a session, the tool identifiers it remembered from the prior turn were already dead — memory tools (`search_memory`, `read_memory`, `update_memory`, etc.) silently failed to dispatch. The bug pre-dates v0.4 (introduced in `cfbf3f2` "custom tool registry") and went ~30 commits without anyone noticing because the SDK swallows the failure quietly. Carson on the live family instance identified the bug from her own broken memory calls and proposed the fix herself; the change went on disk and the service was restarted, with post-restart logs confirming the new behavior (`buildMcpServer server=carsonos-memory-1`). The fix moves the counter to module scope and drops `Date.now()` from the name template — names are now `carsonos-memory-1`, `-2`, ... predictable and monotonic per process lifetime. 5 regression tests (`adapter-mcp-server-name.test.ts`) pin the new contract so a future refactor can't silently re-introduce `Date.now()` or rescope the counter. Adversarial /review of the hotfix surfaced a separate, pre-existing cross-tenant `mcpToolCache.handlerRef` mutation (concurrent `execute()` calls can clobber each other's executor — tracked in #63). Operational note: tonight's downtime was caused by `OnDemand=true` in the launchd plist not respawning after Carson asked for a restart; flip-to-`KeepAlive` is on the v0.5.6 list.

### Why this matters

v0.5.5 lands the brand identity in the dashboard for the first time. DESIGN.md described "warm competence, walking into a hotel lobby where someone already knows your name" — a butler aesthetic anchored in Instrument Serif. Pre-v0.5.5 that voice existed only in onboarding; the moment the user reached the dashboard, system Georgia took over. v0.5.5's Tailwind utility + 26-site swap makes the serif show up everywhere a heading appears. Combined with the empty-Dashboard hero (a "Good evening." greeting instead of three configuration cards), a parent landing in CarsonOS at 9pm now sees what DESIGN.md described.

The form audit closes UI audit #51's per-page migration. Browser autofill works correctly across the whole app. Modal close paths consistently prompt before discarding unsaved edits. Selects no longer break FormField's id-injection contract.

The URL-backed search closes UI audit #48. Tasks and Conversations grew past the threshold (51 / 80 items on the live family instance) where a filtered view needs to be linkable.

## [0.5.4] - 2026-05-03

### Added

- **UI test runner.** The `ui/` package now has its own vitest + `@testing-library/react` + `happy-dom` setup (vitest 3.x, matching the server). 39 regression tests across the four v0.5.3 shared primitives — `confirm-dialog.test.tsx`, `icon-button.test.tsx`, `form-field.test.tsx`, `page-shell.test.tsx` — pin every bug the pre-merge review caught so they cannot silently come back. `pnpm test` now runs **505 tests across 29 files**, all green.

### Fixed

- **`ConfirmDialog` armed-state reset on every reopen.** Pre-fix the 250ms enter-key guard ran only on the first open; a second open let an in-flight Enter sneak past for one frame. Now `armed` resets to `false` whenever the dialog closes.
- **`ConfirmDialog` blocks ESC + outside-click while pending.** The async-aware contract said the dialog stays open during the mutation, but ESC and click-outside still routed through `onOpenChange(false)`. Wrapped to drop close attempts while `pending=true`.
- **`mutateAsync` on three async-aware callsites.** `Projects.tsx` (delete + disable) and `Schedules.tsx` (delete) were passing `mutate()` (returns void) where `mutateAsync()` was needed — the dialog closed immediately instead of waiting for the mutation to land. The user could see the dialog vanish on a 409 with no error feedback.
- **`FormField` preserves the child input's existing id.** `cloneElement` was clobbering any `id` already on the wrapped input, breaking external `<label htmlFor>`, `aria-describedby` references, and tests. Falls back to the auto-generated id only when neither override nor child has one.
- **Mobile menu IconButton AA contrast on navy.** Variant `ghost` rendered `text-carson-text-muted` (~2.78:1) over the open sidebar. Switched to `variant="primary"` so the button reads at 11.6:1 in both closed (over cream) and open (over navy) states.
- **`PageShell` breakpoint matches the hamburger.** `pt-14 lg:pt-0` left a 56px blank gap at 768–1023px (tablet) because the hamburger hides at `md`. Fixed to `md:pt-0`.
- **Tools mobile bundle inset overflow.** Inset child cards combined `w-full + ml-3` and got clipped by `PageShell overflow-x-hidden`. Moved the indent to the parent (`pl-3`) so the children stay flush.
- **`Household` Edit Member Remove now confirms.** The flow was firing `deleteMutation` immediately on click, while every other destructive action in v0.5.3 routes through `ConfirmDialog`. Brought it inline with the same pattern as `StaffCard`.
- **3 leftover `#5a5a5a` literals in `Tools.tsx`** migrated to `text-carson-text-muted` for token consistency.

### Changed

- **Documentation refreshed for v0.5.3 + v0.5.4.** `CLAUDE.md` test count updated to 505 / 29 files. `DESIGN.md` CSS Custom Properties section rewritten to mirror `globals.css` (semantic text tokens with contrast ratios noted inline) plus two 2026-05-02 decisions-log rows for the multi-role text token split (#46) and the four shared primitives (#43, #45, #49, #50). `TODOS.md` v0.5.4 entries renumbered to v0.5.5 to make room for the post-audit critique findings.

### Why this matters

v0.5.4 is the post-merge polish for v0.5.3-ui-audit. The audit primitives ship behind a real test suite (39 cases, every one tied to a specific finding from the pre-merge review). The dashboard's behavior under stress — async mutations, mobile breakpoint transitions, edge-case inputs — is now pinned in code, not just in screenshots. The four review-fix categories above (ConfirmDialog correctness, FormField id preservation, mobile menu contrast, Tools overflow) close the loop on the pre-merge multi-reviewer pass. The next release (v0.5.5) tackles UI/UX direction work surfaced by `/impeccable critique` — Instrument Serif in product chrome, butler-greeting empty state, page-heading mode confusion, and the deferred FormField page migration + Tasks/Conversations search.

## [0.5.3] - 2026-05-02

### Added

- **Mobile-aware page shell.** Every routed page now wraps in a `PageShell` component that reserves 56px of top inset on mobile so the fixed hamburger button doesn't overlap the page title, applies responsive horizontal padding, and locks the horizontal axis so a stray fixed-width child can't introduce page-level horizontal scroll. `PageShell.Header` stacks vertically on mobile and goes side-by-side on tablet+ so title/action rows don't fight for the same line at 390px wide. (Issues #43, #50.)
- **`IconButton` primitive.** Icon-only controls (member edit, schedule pause/edit/delete, password reveal eye, mobile hamburger, modal close X buttons, the secret delete trash) now use a shared `IconButton` component with a 44x44 hit area (per WCAG 2.5.5), a required `aria-label` enforced at compile time, a focus-visible ring, and a radix Tooltip. Pre-v0.5.3 these were 28-36px buttons with no accessible names. (Issue #45.)
- **`ConfirmDialog` for destructive actions.** Replaces the previous mix of `window.confirm()`, ad-hoc inline two-step confirmations, and immediate-fire icon buttons with a single radix-Dialog-based confirmation flow. Verb-named confirm buttons (Delete / Disable / Revoke instead of OK), 250ms enter-key arming so a quick double-click can't pop and immediately confirm, async-aware so the dialog stays open with a pending state until the underlying mutation resolves. Wired through Projects (delete + disable), Schedules (delete), Household (staff delete), and Tools (tool delete + secret delete). (Issue #49.)
- **Custom Tools mobile card layout.** Below the `md` breakpoint, the Tools page renders as stacked cards with a 2-column metadata grid (kind, created-by, usage, last-used) instead of the desktop table. Bundles preserve their expand/collapse semantics. Tablet+ keeps the existing table. (Issue #44.)

### Changed

- **Semantic text tokens replace hard-coded muted hex.** `globals.css` now defines WCAG-AA-verified `--carson-text-primary` / `-body` / `-muted` / `-meta` / `-on-navy` / `-on-navy-muted` tokens, exposed as Tailwind classes (`text-carson-text-muted` etc). Pre-v0.5.3 the codebase used inline `style={{ color: "#8a8070" }}` etc. with values that failed contrast on cream/white/navy at small text sizes. Sidebar section labels alone went from 2.38:1 (fail) to 5.0:1 (pass AA). All page-level muted/meta hex now routes through the tokens. (Issue #46.)

### Why this matters

v0.5.3 is the audit-fix release. It closes 6 of the 8 UI-audit issues opened against the dashboard (#43, #44, #45, #46, #49, #50). Mobile users no longer get clipped headings or hidden controls at 390px. Screen-reader and keyboard users get accessible names on every icon-only control. Destructive actions consistently route through a single confirmation flow instead of three different patterns. Text contrast hits AA across the app. The two remaining issues (#48 search/URL filters and #51 form-field accessibility) are deferred to v0.5.4 — the foundation primitives are already in place; only the per-page migrations remain.

## [0.5.2] - 2026-05-02

### Security

- **`/api/settings` no longer returns saved secret values in responses.** `GET /api/settings`, `PUT /api/settings/:key`, and `PUT /api/settings` were echoing the stored values of `ANTHROPIC_API_KEY` and `GROQ_API_KEY` back to the dashboard — anyone who could reach loopback (a local Bash agent, a misconfigured tunnel) could read the family's API keys by hitting the endpoint. Responses now redact saved secret values to empty strings and surface a separate `savedSecretKeys` array so the UI can show "Saved" / "Replace saved key" without hydrating the secret into the DOM. The Settings UI's password fields stay empty for already-saved secrets and only allow reveal-eye on user-typed replacement values. Closes issue #47.

### Added

- **Signal-only family members can approve hire proposals.** Before, the proposal card never landed for Signal users (no inline buttons), and the reconciler retried forever with no user-facing surface. Now the agent's Signal message includes two HMAC-signed deep-links — Approve and Reject. Tap either one, hit a confirmation page, click Confirm. Same materialization path as Telegram inline buttons or the Web UI: a Developer or specialist materializes, the original user request auto-delegates if one was passed, and the agent's next conversation history reflects the hire (so the next turn doesn't say "X isn't on staff yet"). For phones outside the LAN, set `CARSONOS_PUBLIC_BASE_URL` to a tunnel URL (Tailscale, cloudflared) and the deep-links work from anywhere.
- **`/api/health` actually verifies Anthropic reachability now.** The v0.5.1 fix made the probe stop lying about the CLI; this release replaces the unconditional `return true` with a real HEAD probe to api.anthropic.com (5s timeout, 30s cache, both success and failure cached so a flap doesn't hammer the network). 5xx responses count as unhealthy — when Anthropic's edge is up but broken, `/api/health` reports the truth instead of misleading on-call.
- **QMD reindex backs off after consecutive failures.** Three subprocess failures in a row pause `qmd update` invocations for five minutes; the first success resets state. Without this, every save/update/delete fired a fresh subprocess even when the binary had been failing in a loop. `getReindexHealth()` now also surfaces `consecutiveFailures` and `backoffUntil` so `/api/health` shows the pause state without grepping logs.

### Fixed

- **Cancelling a specialist task actually stops the SDK query now.** Previously, hitting cancel on a Specialist (Lex, Nora, any non-Developer) flipped the DB status row to `cancelled` but left the underlying agent query running until it finished — burning tokens and then dropping the result. The Developer path got this fix in v0.4; specialists got the matching abort-controller wiring this release.
- **System-update self-awareness hardening.** The CoS-proposes-update flow shipped in v0.5.1 had four loose ends: dynamic imports re-resolving on every scheduler tick, a tick/apply race that could write a stale changelog excerpt to the pending row, the post-restart announcement hardcoded to Telegram (web members got nothing), and a clock-skew window that could pin the cache forever after an NTP correction backwards. All four closed.
- **Web-channel announcements no longer show a system-trigger as a user message.** When the post-restart announcement targets a web member, the engine persists the trigger as a `role="user"` row before generating the response. The web UI would have shown the operator a "user" bubble they didn't type. The web announce path now scrubs the trigger row after delivery.
- **Bulk `PUT /api/settings` hydrates platform secrets immediately.** The single-key path already patched `process.env` on save so voice transcription would pick up a new `GROQ_API_KEY` without a restart; the bulk path was missing that step. Now both paths behave identically.

### Changed

- **Dispatcher's two execute paths collapsed into one.** `executeDeveloperTask` and `executeSpecialistTask` shared most of their bodies (started log, tool resolution, adapter execute, cancel re-read, summary card, finalize, drain) but each ran its own copy. New `WorkspaceStrategy` descriptor + a single `runStrategy` method run the shared pipeline once. Future cancel/wake/notifier refinements touch one method instead of two. Behavior is preserved end-to-end (test count went up because each previously-PR'd item brought its own coverage).

### Why this matters

v0.5.2 closes the loop on a feature the v0.5 family runtime had been advertising but quietly half-supporting: Signal as a first-class transport. Before this release, Signal users could chat but couldn't approve hire proposals — meaning a Signal-only member couldn't get a tutor, a coach, or a Developer at all without switching to Telegram. Now they can. Plus the operator-facing signals (`/api/health`, QMD reindex backoff) tell the truth instead of lying or staying silent, the dispatcher refactor sets up cancel/wake/budget refinements to land in a single place going forward, and the Settings API stops handing your API keys back to anyone who hits loopback.

## [0.5.1] - 2026-05-01

### Added

- **CarsonOS now tells you when there's an update available.** Once a day, the system checks GitHub for a newer version. When one is available, the Chief of Staff agent gets a heads-up baked into their system prompt — they'll mention it casually next time you chat ("by the way, there's a v0.5.2 update with X, Y, Z — want me to apply it?"). Only parents can trigger the actual update; kids asking for one get a polite "ask a parent" refusal.
- **CoS can apply system updates from chat.** New `apply_system_update` tool runs `./scripts/update-service.sh` (git pull main, install deps, restart the service) when a parent confirms in chat. The tool returns immediately with "restart in progress" so the agent can tell the user what's happening before the host goes down. After the restart, CoS reads the captured "what changed" excerpt and tells the family in their own voice — closing the loop on both ends.
- **`gmail_read` handles HTML-only emails properly.** Marketing newsletters, transactional emails, and other HTML-only messages now come back as readable text instead of empty. Links are inlined as `text [https://url]` so agents can quote the unsubscribe URL or summarize the prose. Replaces the homegrown HTML stripper with `html-to-text` configured for plain-vs-HTML precedence and embedded-HTML detection.
- **`/api/health` surfaces QMD reindex health.** New `memory.reindex` block reports `errorCount` and `lastError` so on-call doesn't have to grep stderr.log to know whether memory indexing is healthy.

### Fixed

- **`/api/health` no longer reports `adapter.healthy: false` when the SDK works fine.** The probe was shelling out to `which claude` to verify CLI presence, but the Claude Agent SDK doesn't actually need the CLI at runtime. Under launchd the service PATH excludes `~/.local/bin` where the CLI installer lands, so the probe was returning false-negatives even when bots were responding correctly.
- **QMD reindex error logs now include the actual SQLite stack trace.** Previously logged just "Command failed: qmd update" with no context about which collection or path tripped the constraint. Now appends qmd's stderr (capped at 2KB, control bytes stripped, JSON-safe) so future occurrences are debuggable without re-running the script by hand.

### Why this matters

v0.5.1 is the release where CarsonOS becomes aware of its own updates. From here on, each new version self-announces — you don't have to remember to run `update-service.sh`, the Chief of Staff will mention it the next time you talk to them. The trust gate keeps it parent-only; the post-restart in-voice announcement closes the loop so you actually hear "the update applied, here's what changed" instead of just noticing the bots came back online. Plus the on-call signals (`/api/health`, QMD reindex logs) tell you the truth now instead of lying or staying silent.

## [0.5.0] - 2026-05-01

### Added — Memory v0.5

- **Enrichment worker** — Background process that watches conversation turns and extracts typed atoms (facts, preferences, events, etc.) into memory entries. Runs alongside the scheduler tick. Yields to active user-facing chat so it never competes with foreground latency. Disabled via `CARSONOS_DISABLE_ENRICHMENT_WORKER=1`.
- **Compilation agent** — Nightly regeneration of compiled-view files (3am local by default) plus a 60s per-entity debounce for live updates. Compiled views are the readable summary an agent loads first; raw atoms are the long-tail underneath. Disabled via `CARSONOS_DISABLE_COMPILATION_AGENT=1`.
- **Identity files** — `USER.md` per family member and `PERSONALITY.md` per agent capture stable identity separately from drifting facts. Read first in the system-prompt order so personality and core member context are anchors, not search hits.
- **Wikilinks + backlinks** — `[[slug]]` references in memory entries are parsed and stored in a new `memory_links` table with inferred link types (parent, spouse, mentions, likes, etc.). Backlinks let an agent answer "what do we know about Becca" without re-searching prose.
- **Semantic dedup** — Existing entity slugs are passed to the worker LLM at extraction time so it folds duplicates instead of creating near-misses (`josh-daws` vs `josh`). Compilation runs a fuzzy-match fallback over the canonical set as a second layer of defense.
- **Memory CRUD tools** — Memory tools collapsed from save/update into explicit CRUD: `create_memory`, `update_memory`, `replace_memory`, `delete_memory`, plus `correct_memory` for atom-level corrections when the enrichment worker gets something wrong.
- **v0.4 → v0.5 migration** — Idempotent at-boot migrator translates the v0.4 schema to v0.5. Skips members/agents whose identity files already exist. Backs up the live DB before running.

### Added — Delegation

- **`workspace='system'`** in `delegate_task` — sugar for "fresh worktree of the CarsonOS project itself," auto-resolved by name. No `projectId` argument needed; the tool description steers agents toward `system` for any CarsonOS fix. Output is a PR against the live source.
- **Tools-workspace guardrail** — `delegate_task` rejects calls with `workspace='tools'` when the goal/context name-matches a registered project. Closes the common failure mode where an agent picked `tools` for what was actually a system fix, edited live source via absolute paths, and tripped the dev-server file watcher mid-run. The error response steers the caller to `system` (for CarsonOS) or `project` + `projectId` (for other registered codebases).
- **`DelegatorReply` module** — Consolidates the wake-with-retries-and-templated-fallback policy. The delegator agent gets the last word in their own voice, every time wake is possible: transient wake failures (engine busy, model blip, boot ordering, network errors) retry with backoff (5s/15s/30s, 50s total budget) before falling back to the templated notifier card; terminal failures (task gone, member without telegram_user_id, data invariant) skip retries. `markDeliveredByWake` now retries up to 3x to narrow the wake-double-fire race window.
- **Cached audio path exposed to agents** — Voice and audio messages now include `[Audio file cached at: <path>]` in the transcript so any tool the agent has (analyze_audio, transcribe, custom audio handlers) can read the original file bytes. Document/document-text already did this; voice/audio was the gap.

### Fixed — Crash safety

- **Workspace provision crash-safety** (TODO-5) — `executeDeveloperTask` now writes `status='in_progress'` with predicted workspace metadata BEFORE calling `git worktree add`. If the host dies between the DB write and provision succeeding, `recoverStuckTasks` finds the in_progress row with metadata and runs `workspace.teardown(...)` before marking failed. Without this, crashed runs orphaned a `carson/<slug>` branch + worktree dir that permanently blocked retries with the same task title (E_BRANCH_EXISTS forever). Provision-failure now also tears down any partial worktree before failing the task, for the same reason.
- **Tsx watch ignore for sandbox dev mode** — `pnpm dev:sandbox` was placing delegated-run worktrees inside the repo at `.sandbox/...`, which the tsx watcher saw — every Developer file write triggered a host restart that killed the in-flight specialist's session. Added `.sandbox/**` and `.carsonos/**` ignore patterns. See ADR-0001 for the larger architectural decision (live family instance must not file-watch its own source).

### Security

- **Custom-tool sandbox tightened** (TODO-3) — `ctx.db` was removed from the custom-tool handler context. A Developer with `specialty='tools'` could previously author a script tool whose handler did `ctx.db.select().from(toolSecrets)` to dump every household's encrypted secret rows. Handlers needing data should now use `ctx.fetch` (against the local API), `ctx.getSecret` (household-scoped), or `ctx.memory` (member-scoped). Existing handlers that referenced `ctx.db` will fail at runtime with a clear "Cannot read properties of undefined" — intentional break.
- **Forbidden Node builtin imports rejected at handler validation** (TODO-3) — `validateScriptHandler` now scans handler.ts at create AND apply-update time for imports of `fs`, `fs/promises`, `child_process`, `os`, `net`, `tls`, `dgram`, `cluster`, `worker_threads`, `v8`, `vm` (with and without the `node:` prefix). Closes the matching escape primitive: a handler that imported `fs` could `readFileSync('~/.carsonos/.secret')` to lift the AES master key. Allowed builtins are `path`, `url`, `crypto`, `buffer`, `stream` (pure or scoped).
- **`apply-update` gates script-tool changes through `pending_approval`** (TODO-4) — `POST /api/tools/custom/:id/apply-update` previously promoted upstream changes to `status='active'` unconditionally. For script-kind tools authored by anyone other than Chief of Staff, that was a supply-chain hole: a malicious upstream could mutate `handler.ts` and run new code in-process the moment the user clicked Apply Update. The /create path already had this gate; now /apply-update matches it. Prompt and HTTP tools are inert and stay on direct-to-active.

### Documentation

- **`CONTEXT.md`** — Project domain glossary covering 11 terms across agents/delegation, workspace/runtime, and memory/constitution. Used by engineering skills to ground refactors in shared vocabulary.
- **`docs/adr/0001-no-file-watch-on-live-instance.md`** — Architectural decision: CarsonOS is a self-modifying runtime, so naive file-watch auto-reload on the live instance is hostile. The live instance reloads via explicit drain-and-restart, not file events.
- **Agent skills setup** — `CLAUDE.md` now references `docs/agents/` for issue-tracker, triage-labels, and domain-doc consumer rules. Engineering skills like `/improve-codebase-architecture`, `/diagnose`, and `/triage` read these.
- **README updated** — Memory section reflects the v0.5 model (5 layers including identity files, wikilinks/backlinks, background workers). Tools table reflects the CRUD memory tool collapse.

### Why this matters

v0.5 is the memory release. Conversations now build a typed knowledge graph in the background — facts, preferences, people, events, relationships — and agents read it back through compiled views and wikilinks. The split between identity (stable) and memory (drifting) keeps personality from getting drowned by recent details. Together with the delegation hardening, agents can do longer-running work on the system itself without losing state to mid-run restarts.

## [0.4.2.1] - 2026-04-27

### Added

- **`gmail_read` now handles HTML-only emails.** Marketing newsletters and similar messages without a `text/plain` part used to come back with an empty body. The tool now re-fetches with `--html`, converts to readable text, and surfaces all extracted links so the agent can answer "what's the unsubscribe URL" or summarize the prose.
- **`delegate_task` now takes an explicit `workspace` per task** (`'tools' | 'project'`). The calling agent picks where the Developer works on a per-task basis. `'tools'` provisions a sandbox at `~/.carsonos/sandbox/{runId}/` for building a new custom tool from scratch. `'project'` provisions a fresh git worktree of the registered project specified by `projectId` — this is the right answer for ANY fix to existing code in a registered codebase, including CarsonOS itself. If the calling agent omits `workspace`, the call falls back to the specialist's hired specialty (back-compat).
- **Operating contract is now per-task, not per-hire.** When a Developer is given a task whose workspace differs from their hired specialty (e.g., a tools-Dev assigned a `'project'` task to fix carson-os), the dispatcher loads the operating contract that matches the task's workspace, not the one stored at hire time. Stops the "you build new tools in a sandbox" instructions from being sent to a Dev who's actually editing a worktree.
- **Failure notifications now feed Carson the actual reason.** Successes already routed through the parent agent's voice; failures used the same path but with a thin trigger that didn't carry the error. The trigger now includes the failure reason verbatim (the SDK error message, or "host restart during run" for tasks killed by a dev-server reload), plus a guidance note for the host-restart case telling the agent to suggest re-running with `workspace='project'` so the next attempt happens in a worktree where it won't trip the file watcher.

### Why this matters

Yesterday's failed Gmail-fix Dev runs all hit the same loop: Carson delegated to Dev with the default `tools` workspace → Dev got an empty sandbox → Dev couldn't find `gmail-tools.ts` there → Dev edited the live source via absolute paths → tsx watch saw the change → server restarted → in-progress task killed by `recoverStuckTasks` → Carson received a thin "Tool build failed" card and wrote generic prose. With per-task `workspace='project'` + `projectId=<carson-os>`, the same task runs in a git worktree where tsx watch doesn't see the edits, the work survives the run, and produces a reviewable PR. With richer failure context, Carson can explain what actually went wrong instead of echoing a deterministic card.

## [0.4.2.0] - 2026-04-27

### Fixed

- **Telegram relay watchdog no longer false-positives on quiet bots.** The previous stall watchdog interpreted "5 minutes with no incoming Telegram messages" as a wedged bot and force-restarted it. Family bots have natural quiet periods (overnight, school, work), so this fired ~1700+ times per day per bot, churning connections for no reason. The watchdog now checks `runner.isRunning()` directly: if the grammy runner thinks it's polling, it is. A genuine stall is when we believe a bot is running but the runner has stopped underneath us.
- **Failed restarts no longer evict the bot from the running set.** The old restart path called `stopBot()` (which deletes from `this.bots`) and then `startBot()`. If the start failed (Telegram 409 from a fast restart cadence, network blip), the bot disappeared from the manager's map entirely and the watchdog had no record of it to retry. The bot stayed dead until the whole server process restarted. Restart-in-place keeps the entry alive across failures so the next watchdog tick can try again.

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
