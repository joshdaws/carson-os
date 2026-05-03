# TODOS

## v0.5.4 — FormField migration + modal dirty-guard (UI audit #51)
- **What:** Wire the new `FormField` component (already shipped in v0.5.3 foundation at `ui/src/components/ui/form-field.tsx`) through Projects, Schedules, Household member-and-agent forms, Onboarding family setup, and Settings. Add `useDirtyGuard` to modal/drawer editors so closing-while-dirty asks before discarding.
- **Why:** Pre-v0.5.3 forms wired their own labels (`<label>` siblings without `htmlFor`), skipped `name` and `autocomplete`, and signaled error/required state through copy alone. That weakens browser autofill, screen reader traversal, and validation recovery. The component contract is in place — only the per-page migration remains.
- **Pros:** Closes the last UI-audit form item. Browser autofill works correctly across all setup flows. First-error focus + dirty-guard reduce data-loss accidents on long forms.
- **Cons:** Touches every form on every page. ~400-600 LOC across 5 page files. Visual regression risk during conversion if existing forms have bespoke layouts.
- **Caveats from the v0.5.3 review (2026-05-02):**
  - FormField uses `React.cloneElement` to inject `id` / `name` / `autoComplete` / `aria-*` onto its child. That works for `<Input>`, `<Textarea>`, and any plain `<input>`-shaped element. It does **not** work for radix `<Select>`, which is a compound component (`<Select>` → `<SelectTrigger>` etc.) and doesn't accept `id` or `autoComplete` at the root. Most member/agent forms in scope have a Select for role / model / trust-level — those need either a `skipInputProps` escape hatch added to FormField or label+error positioned manually with explicit id threading on the trigger.
  - FormField only injects an `id` if neither the wrapper nor the child already has one. Existing `<Input id="foo">` callers stay intact — useful when migrating onto pages that already wired ids manually.
  - `useDirtyGuard` only protects modal/drawer-style close handlers that explicitly call `guardClose`. It does **not** intercept React Router navigation (sidebar clicks, browser back). If we want navigation protection too, that's a `useBlocker` follow-up.
- **Context:** Issue #51. Originally part of v0.5.3 scope; deferred to v0.5.4 because the bug-class items (#43, #44, #45, #46, #49) plus the Tools mobile card and the destructive-action standardization filled the v0.5.3 release.
- **Depends on:** v0.5.3 foundation shipped (FormField + useDirtyGuard primitives are in `ui/src/components/ui/form-field.tsx`).

## v0.5.4 — Tasks/Conversations search + URL-backed filters (UI audit #48)
- **What:** URL-backed filter state via React Router `useSearchParams`, search input on both pages, simple pagination once counts exceed a modest threshold (~50 items), selected task/conversation persisted in the URL for reload + deep-link.
- **Why:** Audit measured 51 tasks and 80 conversations on the live instance. Both pages render full `.map()` lists without virtualization, search, pagination, or URL-backed filters. Filter state is local component state, so a filtered view can't be bookmarked or shared and resets on reload.
- **Pros:** Pages stay fast as activity grows. Bookmark/share-friendly. Works the way every other production list-view does.
- **Cons:** ~200-300 LOC across Tasks and Conversations. Existing local filter state needs to migrate to URL state without breaking the empty-default behavior. Pagination needs a per-list threshold decision.
- **Context:** Issue #48. Deferred from v0.5.3 release scope (paired with #51).
- **Depends on:** None.

## [COMPLETED v0.5.1] v0.5.1 — Fix `/api/health` adapter probe (false-negative on launchd)
- **What:** `ClaudeAgentSdkAdapter.healthCheck()` at `server/src/services/subprocess-adapter.ts:841-848` runs `which claude` to confirm CLI presence. The Agent SDK doesn't use the `claude` CLI at runtime — it's an npm package (`@anthropic-ai/claude-agent-sdk`) that talks to Anthropic via OAuth. The CLI probe is a copy-paste vestige from `ClaudeCodeAdapter`.
- **Why:** Under launchd the service's PATH is `/Users/{user}/.nvm/.../bin:/usr/local/bin:/usr/bin:/bin`. Users who installed `claude` via the official installer (which puts it at `~/.local/bin/claude`) get a CLI that's not on the launchd PATH. `which claude` returns non-zero → `/api/health` reports `adapter.healthy: false` even though SDK runtime is fine. Surfaced 2026-05-01 during /land-and-deploy on the v0.5.0 PR.
- **Fix:** Replace the `which` probe with a real liveness check. Two options:
  1. Cheap: just `return true` — module-load already proved availability. Probe becomes "did the module import succeed."
  2. Better: call a no-arg SDK function (e.g., model listing or a dry-run init) to confirm the OAuth token is valid and the SDK can reach Anthropic.
- **Pros:** /api/health stops lying. Downstream consumers (canary monitoring, deploy verification) trust the answer. Removes a confusing on-call false alarm.
- **Cons:** Option 2 costs an API call per health check — fine if rate-limited, bad if hammered.
- **Recommended:** Option 1 (return true on module presence) for now. If the SDK ever gains a real `ping()` or `validateAuth()` method, swap in Option 2.
- **Depends on:** None.

## [COMPLETED v0.5.1] v0.5.1 — Eliminate QMD `SQLITE_CONSTRAINT_PRIMARYKEY` reindex errors
- **What:** `qmd update` (subprocess invoked from `qmd-provider.ts:runReindex`) intermittently throws `SQLITE_CONSTRAINT_PRIMARYKEY` on `insertDocument(collection, path, title, hash, createdAt, modifiedAt)`. The error is caught and warned at `qmd-provider.ts:661`, so search keeps working, but rows that hit the constraint are silently dropped from QMD's index — potential gaps where memories exist on disk but don't surface in `search_memory` results.
- **Why:** Pre-existing issue. A 2026-04-29 attempt added in-process reindex coalescing (`qmd-provider.ts:85-92, 645-669`) — at most one `qmd update` in flight, one queued. That fixed same-process burst races but the error persisted (32 occurrences in stderr.log across the file's history; some post-coalescing-fix). Most likely cause: `qmd update` itself does `INSERT` instead of `INSERT OR REPLACE` / `UPSERT` on `(collection, path)`. When the row already exists with different content, the insert collides instead of updating.
- **Diagnostic next steps:**
  1. Read QMD's source (`/Users/joshdaws/.nvm/versions/node/v22.18.0/lib/node_modules/@tobilu/qmd/dist/store.js:1502`) to confirm INSERT-vs-UPSERT.
  2. Reproduce locally: pick one entity, save it twice in succession with content changes, confirm the second save triggers the constraint.
  3. Capture which paths are hitting the constraint (the error message doesn't include them today — wrap the runReindex catch to inspect/log them).
- **Fix options:**
  1. **Pre-emptive cache delete** (defensive, slow): `qmd remove <collection>` before each `qmd update` so the inserts are always fresh. Throws away incremental indexing speed.
  2. **Switch qmd command** to a variant that does upsert. Check `qmd --help` for an `--upsert` or `--reset` flag.
  3. **Patch upstream**: fork `@tobilu/qmd`, change INSERT → INSERT OR REPLACE, send a PR to the maintainer.
  4. **Replace QMD** with a native SQLite-backed indexer maintained inside CarsonOS. Larger scope but eliminates the third-party-tool footgun entirely.
- **Pros:** Closes a silent data-correctness hole. Search becomes reliable instead of "usually works, sometimes misses things."
- **Cons:** Each fix has tradeoffs. Option 1 is fastest to ship but slowest at runtime. Option 4 is the cleanest long-term but is the biggest scope.
- **Recommended:** Option 2 first (cheapest if it exists). Fall back to Option 1 if no upsert flag. Schedule Option 4 for v0.6+ if QMD continues to be a footgun.
- **Depends on:** None.

## [COMPLETED v0.5.1] v0.5.1 — System update self-awareness (CoS proposes the update)
- **What:** CarsonOS becomes aware of its own pending updates and surfaces them in-voice through the Chief of Staff. Four pieces:
  1. Boot-time check (cached daily at `~/.carsonos/.update-check`) compares local `VERSION` against `origin/main:VERSION`. When behind, writes `update_available: { from, to, changelog_excerpt }` to `instance_settings` (or a dedicated state row).
  2. Chief of Staff system prompt gains a section: if `update_available` is set, mention it casually on the user's next interaction, explain what the update does in plain English using the changelog excerpt, and offer to apply it.
  3. New system tool `apply_system_update` wraps `./scripts/update-service.sh`. Trust-gated to parent-level members only. Tool returns immediately with a "restarting now" payload; the host process exits during the script.
  4. The post-restart wake leans on the existing DelegatorReply infrastructure — when CoS comes back up, replay finds the pending in-voice notification and CoS tells the user "update applied, here's what changed."
- **Why:** Today (v0.5.0) the update path is "user remembers to run a shell script." That works for one developer; it doesn't work for the actual product (a family AI staff). The Chief of Staff already manages household-level concerns; updates fit naturally there. Self-modifying systems should be aware of their own modification state, not delegate it to ambient knowledge.
- **Pros:** Closes the loop on the v0.4→v0.5 manual-QA pain. Future updates self-announce. Pairs cleanly with the v0.5 DelegatorReply + workspace crash-safety + watch-fix work — the foundation is exactly right for "agent restarts itself and reports back in voice."
- **Cons:** New surface area: boot check, new state, new prompt section, new tool, trust-level gate. ~200-400 lines + tests. Risk: if `apply_system_update` ever runs unintentionally (prompt injection on the changelog excerpt? a member with elevated trust the user didn't intend?), it restarts the family runtime.
- **Context:** Surfaced 2026-05-01 during /land-and-deploy on the v0.5.0 PR. The merge step lands code on main but doesn't actually update the live instance — that's still a manual `./scripts/update-service.sh`. Designed scope deferred from v0.5.0 because the v0.4 instance can't benefit from it (the awareness must already be present); v0.5.0 → v0.5.1+ updates can.
- **Security note:** the changelog excerpt that flows into the CoS prompt is a trust-boundary surface. Sanitize before injection; consider keeping it short (first N lines of the new CHANGELOG entry) and stripping markdown/HTML.
- **Depends on:** v0.5.0 shipped (DelegatorReply for in-voice post-restart, workspace crash-safety, tsx watch fix all already in place).

## [COMPLETED v0.5.2] v0.5 — Specialist-path abort-controller parity (cancel doesn't stop specialist compute)
- **What:** Mirror the v0.4 Developer-task cancel infrastructure on the specialist (non-Developer) path. Register an `AbortController` at `dispatcher.executeSpecialistTask` start, stash it in `inFlightAborts`, thread it into `adapter.execute`, and handle the aborted-mid-stream case the same way `executeDeveloperTask` does.
- **Why:** v0.4's mid-release refinement fixed the "cancelled task flips back to completed" bug for Developer tasks by wiring the abort through the Agent SDK. The specialist path (Lex, Nora, any non-`tools`/`project`/`core` specialty) got the cancel-sticky DB guard via the shared `finalizeTerminalTask`, so the status row is safe, but the specialist's SDK query keeps running to completion and burns tokens before its result is dropped. Specialist tasks are usually short (research one-liners) so low practical impact today, but the invariant is inconsistent between paths.
- **Pros:** Consistent cancel semantics everywhere. Stops wasted compute.
- **Cons:** ~30 lines of near-duplicate plumbing. Could be paired with the workspace-strategy dedupe below so both execute paths merge.
- **Context:** Surfaced 2026-04-24 during the /codex review of the PR 3 (proactive wake) commit. The Developer path was the one we hit in E2E testing, so it got fixed; the specialist path was logged here for v0.5.
- **Depends on:** None.

## [COMPLETED v0.5.2] v0.5 — Merge executeDeveloperTask / executeSpecialistTask via WorkspaceStrategy
- **What:** Extract a `WorkspaceStrategy` interface with two implementations: `DeveloperWorkspace` (provisions a git worktree or tool_sandbox, sets `cwd` + `maxTurns=200` on the adapter, registers the abort controller) and `NoWorkspace` (no cwd, no turn-limit override, no abort controller today but see previous item). Then `dispatcher.executeDeveloperTask` + `executeSpecialistTask` collapse into a single `executeTask(taskId, agent, slotKey, strategy)` method that calls `strategy.setup()` → `adapter.execute(...)` → `finalizeTerminalTask(...)` → `strategy.teardown()`.
- **Why:** v0.4 PR 3 extracted the shared post-execute finalize step into `finalizeTerminalTask`, but the pre-execute setup still forks: workspace provisioning, `cwd`/`maxTurns` passing, AbortController registration, queue-key scheme (`drainDeveloperQueue` vs `drainSpecialistQueue`). Every new cancel/wake/notifier refinement has to touch two places. Codex flagged this during PR 3 review; Josh ratified the plan to dedupe in v0.5 since the divergence is real (not pure dupe) and needs a thoughtful abstraction, not a rushed one.
- **Pros:** Single execute path, lower cost of future refinements (canary hooks, budget gates, resume-after-restart).
- **Cons:** Non-trivial refactor touching both the dispatcher hot path and the workspace provisioning layer. Needs regression coverage for both Dev and specialist flows.
- **Context:** Surfaced 2026-04-24 during the /codex review of PR 3 and called out explicitly in Josh's "are we making this DRY" pushback. Scoped to v0.5 to avoid dragging mid-release refinements past the v0.4 merge window.
- **Depends on:** Could land alongside the specialist-path abort-controller parity item above — same area, same diff.

## [COMPLETED v0.5.0] v0.5 — Scope ctx.db in custom-tool handlers (tool_secrets exfil risk)
- **What:** Replace `ctx.db` in `CustomToolHandlerContext` with scoped helpers (`ctx.getSecret`, `ctx.storeSecret`, `ctx.listTools`, etc.) or a Proxy that injects `householdId` into queries. Also restrict `node:fs` in the esbuild bundle (`packages: 'external'` currently allows `fs.readFileSync`), so the handler can't `readFileSync('~/.carsonos/.secret')` to lift the AES master key.
- **Why:** A Developer with `specialty='tools'` + `canCreateActiveTools=true` can author a script tool whose handler does `ctx.db.select().from(toolSecrets)` to dump every household's encrypted secret rows, then reads `~/.carsonos/.secret` (32-byte master key) from disk and decrypts. Single-family today = low practical risk, but the scoping gap is live code.
- **Pros:** Closes the cross-household data exfil primitive; enforces the principle of least privilege for tool handlers.
- **Cons:** Requires surveying every existing script tool to confirm none depend on raw `ctx.db` access. Scoping via Proxy is subtle — easy to miss a table.
- **Context:** Surfaced 2026-04-23 during v0.4 /review (RT-05). v0.4 mitigation: the tools-specialty operating_instructions (in `specialty-templates/tools.md`) ask the Developer not to do this, but that's guidance, not a gate.
- **Depends on:** None.

## [COMPLETED v0.5.0] v0.5 — Apply-update must preserve script-tool approval invariant
- **What:** `POST /api/tools/custom/:id/apply-update` currently re-fetches `source_url`, promotes the new files, and sets `status='active'` unconditionally. For `kind='script'` tools that aren't authored by the Chief of Staff, this should re-enter `pending_approval` instead of silently going live.
- **Why:** A malicious upstream skill source can mutate its `handler.ts` and, on the next "Apply Update" click, instantly run its new code in-process. The /create path gates this behind the approval queue; /apply-update doesn't.
- **Pros:** Closes the supply-chain gap on installed script tools. Same invariant applies whether code enters via create, update, or apply-update.
- **Cons:** Extra click for the human on every script-tool upstream update. For prompt/http tool kinds the current behavior (no approval on update) is still fine.
- **Context:** Surfaced 2026-04-23 during v0.4 /review (RT-07).
- **Depends on:** None.

## [COMPLETED v0.5.0] v0.5 — Workspace provision crash-safety (orphan branches block retry)
- **What:** Swap the order in `dispatcher.executeDeveloperTask` so the DB UPDATE marking the task in_progress happens BEFORE `git worktree add`. If the server crashes between the two, the task stays pending (next boot re-queues) instead of orphaning a `carson/<slug>` branch + worktree dir that permanently blocks any re-try with the same title.
- **Why:** Re-running a failed Dev task with the same title currently hits `E_BRANCH_EXISTS` forever because the stale branch isn't torn down until `task.cancelled` fires. A principal who re-queues a failed task has to manually `git branch -D` + `git worktree prune`.
- **Pros:** Crash-recovery correctness; removes a real footgun for principals.
- **Cons:** If we write the DB row first and git fails, we need teardown-on-provision-failure to roll the row back to pending. Adds a second state transition.
- **Context:** Surfaced 2026-04-23 during v0.4 /review (RT-09).
- **Depends on:** None.

## [COMPLETED v0.5.2] v0.5 — Signal transport: delegation approval UX
- **What:** Signal-only family members currently get a silently-broken delegation flow. notifierSend resolves member.telegramUserId → null for Signal users; SignalRelayManager has no inline-button equivalent (Signal doesn't support Telegram's callback_query). Hire proposals for Signal users create the approval task but never deliver, and Phase-2 replay re-attempts forever on every boot + hourly sweep with no user-facing error surface.
- **Why:** v0.4 ships with Signal transport (merged 2026-04 in #22) but the delegation flow was Telegram-inline-keyboard-only. A family with a Signal-only user can't hire specialists.
- **Pros:** Closes the feature-parity gap between Telegram and Signal. Unblocks Signal-only families from v0.4 delegation entirely.
- **Cons:** Signal doesn't have structured buttons — options are (a) a deep-link to the web-UI /tasks page that shows pending hire proposals with approve/reject, (b) keyword-reply parsing ("approve 1234" / "reject 1234"), or (c) require Signal users to also link Telegram for delegation.
- **Context:** Surfaced during v0.4 /review adversarial (2026-04-23, RT-12). Documented here until the approach is chosen.
- **Depends on:** v0.4 delegation shipped + Signal transport shipped (both done).

## Kid Agent Tool Approval Flow
- **What:** Kid asks for a tool, parent gets Telegram notification, parent approves/rejects
- **Why:** Lets kids participate in tool creation safely without giving them direct access
- **Pros:** Extends the platform to the whole family, not just parents
- **Cons:** Requires notification system (Telegram to parent), approval state machine, UI for parent review
- **Context:** M1 gates tool creation to full-trust agents only. This would add an approval path for restricted agents. User mentioned this as a cool future feature during office hours (2026-04-13).
- **Depends on:** M1 custom tools shipped and working

## SSRF Protection for HTTP Executor
- **What:** Block private network IPs (localhost, 10.x, 172.16-31.x, 192.168.x, 169.254.x) in HTTP executor
- **Why:** Prevents server-side request forgery if a tool URL targets internal services
- **Pros:** Standard security practice, prevents a real vulnerability class
- **Cons:** ~10 lines of DNS resolution + IP check before fetch
- **Context:** Codex flagged during eng review (2026-04-14). Low risk for home network deployment but matters if CarsonOS ever runs in cloud infra.
- **Depends on:** HTTP executor (M1 step 2)

## Tiered Creation by Trust Level
- **What:** Loosen custom tool creation gates: all agents can create `prompt` tools (text-only, no execution); full-trust agents can create `http` tools (network, sandboxed); CoS only can create `script` tools (full server privilege).
- **Why:** Currently every tool kind is CoS-only, which is too strict. A teenager's agent should be able to write a study-flow recipe (prompt tool) without going through parent approval.
- **Pros:** Unlocks creative recipe authoring for non-CoS agents, matches the actual threat model (prompts are safe, HTTP is medium, scripts are dangerous)
- **Cons:** 1-day fix. Need to map trust level to allowed tool kinds in the create path.
- **Context:** Surfaced during v0.2.0 retrospective (2026-04-14). All three tool kinds currently require CoS trust.
- **Depends on:** Custom tools registry (shipped in v0.2.0)

## [COMPLETED v0.4.0.0] Delegation: Chief of Staff → Specialist Agent for Big Tasks
- **Completed:** v0.4.0.0 (2026-04-23)
- **What:** When the Chief of Staff recognizes a request will take many turns or
  requires capabilities a specialist has (e.g., coding), it dispatches to a
  specialist agent (e.g., "Carlos" the coding agent, Opus-powered) via task
  creation. The task fires immediately, runs async. Chief of Staff tells the
  user "Carlos is working on it, I'll let you know when he's done" and the
  conversation continues. When Carlos finishes, he messages back, Chief of
  Staff relays: "Your tool is ready. Try it?"
- **Why:** Big jobs (e.g., building a YNAB script tool with multi-step handler)
  blow past per-session turn limits AND block the chat. Delegation lets the
  conversation stay responsive while heavy work runs in the background. Also
  lets us use the right model for the job (Opus for coding, Sonnet for chat).
- **Pros:** Non-blocking UX, specialized agents with tailored tool grants and
  models, natural fit for the existing delegation infrastructure (dispatcher,
  delegation-orchestrator, staffAssignments already exist in carson-os but
  were disabled in v0.1 per commit 0f156d6).
- **Cons:** Requires re-enabling delegation, wiring a notify-back event
  (delegation.result → main conversation), defining the "when to delegate"
  policy (turn-estimate heuristic? capability match?). Careful UX design
  needed so the user isn't confused about who is doing what.
- **Context:** User surfaced this pattern on 2026-04-14 after Carson hit the
  15-turn limit trying to create a YNAB tool in one session. Next phase after
  custom tools ships — not bundled with this PR.
- **Depends on:** Custom tool registry merged; re-enabling delegation in
  constitution-engine and staff routes; specialist agent provisioning UI.

## v0.5 — `lock_until` stalled-worker rescue pattern
- **What:** Add `lock_until INTEGER` column to tasks. Worker sets it to `now() + lease_seconds` when it picks up a task, bumps it every 30s. On boot, reconciler adopts any task with expired `lock_until` as an orphan. Replaces the current "mark in_progress → failed" boot sweep.
- **Why:** Cleaner invariant. Same pattern minions uses. Also sets up CarsonOS for a future multi-worker Dispatcher if needed.
- **Pros:** Doesn't require a worker to be dead to detect orphans (just stalled). Works if Dispatcher ever splits across processes.
- **Cons:** Marginal benefit in single-Node CarsonOS (only one worker today). Adds a background heartbeat timer in every running task.
- **Context:** From gbrain minions benchmarks study (2026-04-20) — their `handleStalled` rescued 10/10 jobs in their SIGKILL test vs 0/10 for OpenClaw.
- **Depends on:** None in particular; can land standalone.

## v0.5 — Folder-scan project auto-discovery
- **What:** `discoverProjectsIn(path)` scans `~/projects/*` on boot, reads each folder's `package.json` + `git remote get-url origin` to auto-fill project metadata. User toggles enable/disable per project in Settings.
- **Why:** Explicit registration is fine at v0.4 family scale (3-5 projects), but if you add a dozen personal side projects, typing each one in gets tedious. Convenience feature.
- **Pros:** Less setup friction. Auto-detects when you clone a new repo into the standard location.
- **Cons:** Surprises possible — a folder might be registered that you didn't mean to delegate against.
- **Context:** Deferred from v0.4 per eng review (2026-04-20).
- **Depends on:** v0.4 projects table shipped.

## Future — Per-member token budget (defer until it's actually a problem)
- **What:** If/when Claude Max usage limits start biting during real household use, add a per-member soft cap that CoS checks before approving a kid's delegation.
- **Why:** Not a real problem today. Claude Max handles the backpressure naturally — if you hit limits, requests start failing and that's feedback enough.
- **Pros:** Would bound cost if CarsonOS ever ran on pay-per-token instead of Claude Max.
- **Cons:** Token counts aren't stable across models; any budget number picked today will be wrong later. Premature optimization.
- **Context:** Explicitly deferred by user (2026-04-20): "Right now it's all Claude Max subscription, so I'm fine with it. Usage, anything we can do — worry about it when we cross that road." No action until real usage data says otherwise.
- **Depends on:** Actual evidence of token exhaustion being a real family-impact problem.

## v0.5 — Live task log tail UI
- **What:** Extend `ui/src/pages/Tasks.tsx` to show live progress of a running Developer task. Tail the Claude Code JSONL log via WebSocket, render tool calls + token counts + progress events in real time.
- **Why:** v0.4 ships with list + cancel only. For 20-min dev tasks, seeing what Bob is doing right now is valuable debugging + curiosity surface.
- **Pros:** Great for trust building — watch your Developer work. Useful for catching runaway tasks early.
- **Cons:** WebSocket log streaming adds UI state management complexity. Not on the critical path.
- **Context:** Deferred from v0.4 per eng review (2026-04-20).
- **Depends on:** v0.4 Tasks.tsx shipped.

## v5.X — HEARTBEAT.md per agent (deferred from v5 CEO review 2026-04-27)
- **What:** Per-agent declarative cadence file at `~/.carsonos/agents/{slug}/HEARTBEAT.md` describing every-message hooks, daily/weekly tasks, quiet hours, schedule staggering. From gbrain's soul-audit pattern.
- **Why:** Single auditable surface for "here's when this agent does what" instead of cadence scattered across cron, scheduler, and skill descriptions.
- **Pros:** Auditable, version-controllable, fits the identity-files-on-disk story (USER.md / PERSONALITY.md / RESOLVER.md).
- **Cons:** **Likely solves no problem.** The existing scheduled-tasks system already works as the source-of-truth for agent cadence; a declarative file adds drift surface without addressing a real need. Calibrated learning: prefer data-as-source-of-truth over config-file-as-source-of-truth when the data already exists.
- **Context:** Deferred from v5 SELECTIVE EXPANSION cherry-pick #4. Revisit ONLY IF scheduled tasks prove insufficient for some specific cadence requirement that can't be expressed as a schedule entry. Probably never.
- **Depends on:** scheduled-tasks system staying as-is and continuing to be the right primitive.

## Future — Suno integration
- **What:** Direct Suno generation from within CarsonOS. Let the music agent generate a demo and deliver the MP3 back in Telegram.
- **Why:** Suno-as-a-tool closes the "compose → generate → iterate" loop without leaving the chat.
- **Pros:** Huge creative unlock if it works.
- **Cons:** **No official self-serve Suno API in 2026** — only enterprise tier + unreliable third-party gateways (Jeremiah's attempt blocked on gateway Google-login bug). Paid, non-trivial auth, gateway reliability is the open question.
- **Context:** Deferred explicitly — keep the "generate in Suno app, log what worked in the prompt library" workflow until Suno opens a real API.
- **Depends on:** Suno shipping a public self-serve API.
