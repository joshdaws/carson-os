# TODOS

## v0.5 — Specialist-path abort-controller parity (cancel doesn't stop specialist compute)
- **What:** Mirror the v0.4 Developer-task cancel infrastructure on the specialist (non-Developer) path. Register an `AbortController` at `dispatcher.executeSpecialistTask` start, stash it in `inFlightAborts`, thread it into `adapter.execute`, and handle the aborted-mid-stream case the same way `executeDeveloperTask` does.
- **Why:** v0.4's mid-release refinement fixed the "cancelled task flips back to completed" bug for Developer tasks by wiring the abort through the Agent SDK. The specialist path (Lex, Nora, any non-`tools`/`project`/`core` specialty) got the cancel-sticky DB guard via the shared `finalizeTerminalTask`, so the status row is safe, but the specialist's SDK query keeps running to completion and burns tokens before its result is dropped. Specialist tasks are usually short (research one-liners) so low practical impact today, but the invariant is inconsistent between paths.
- **Pros:** Consistent cancel semantics everywhere. Stops wasted compute.
- **Cons:** ~30 lines of near-duplicate plumbing. Could be paired with the workspace-strategy dedupe below so both execute paths merge.
- **Context:** Surfaced 2026-04-24 during the /codex review of the PR 3 (proactive wake) commit. The Developer path was the one we hit in E2E testing, so it got fixed; the specialist path was logged here for v0.5.
- **Depends on:** None.

## v0.5 — Merge executeDeveloperTask / executeSpecialistTask via WorkspaceStrategy
- **What:** Extract a `WorkspaceStrategy` interface with two implementations: `DeveloperWorkspace` (provisions a git worktree or tool_sandbox, sets `cwd` + `maxTurns=200` on the adapter, registers the abort controller) and `NoWorkspace` (no cwd, no turn-limit override, no abort controller today but see previous item). Then `dispatcher.executeDeveloperTask` + `executeSpecialistTask` collapse into a single `executeTask(taskId, agent, slotKey, strategy)` method that calls `strategy.setup()` → `adapter.execute(...)` → `finalizeTerminalTask(...)` → `strategy.teardown()`.
- **Why:** v0.4 PR 3 extracted the shared post-execute finalize step into `finalizeTerminalTask`, but the pre-execute setup still forks: workspace provisioning, `cwd`/`maxTurns` passing, AbortController registration, queue-key scheme (`drainDeveloperQueue` vs `drainSpecialistQueue`). Every new cancel/wake/notifier refinement has to touch two places. Codex flagged this during PR 3 review; Josh ratified the plan to dedupe in v0.5 since the divergence is real (not pure dupe) and needs a thoughtful abstraction, not a rushed one.
- **Pros:** Single execute path, lower cost of future refinements (canary hooks, budget gates, resume-after-restart).
- **Cons:** Non-trivial refactor touching both the dispatcher hot path and the workspace provisioning layer. Needs regression coverage for both Dev and specialist flows.
- **Context:** Surfaced 2026-04-24 during the /codex review of PR 3 and called out explicitly in Josh's "are we making this DRY" pushback. Scoped to v0.5 to avoid dragging mid-release refinements past the v0.4 merge window.
- **Depends on:** Could land alongside the specialist-path abort-controller parity item above — same area, same diff.

## v0.5 — Scope ctx.db in custom-tool handlers (tool_secrets exfil risk)
- **What:** Replace `ctx.db` in `CustomToolHandlerContext` with scoped helpers (`ctx.getSecret`, `ctx.storeSecret`, `ctx.listTools`, etc.) or a Proxy that injects `householdId` into queries. Also restrict `node:fs` in the esbuild bundle (`packages: 'external'` currently allows `fs.readFileSync`), so the handler can't `readFileSync('~/.carsonos/.secret')` to lift the AES master key.
- **Why:** A Developer with `specialty='tools'` + `canCreateActiveTools=true` can author a script tool whose handler does `ctx.db.select().from(toolSecrets)` to dump every household's encrypted secret rows, then reads `~/.carsonos/.secret` (32-byte master key) from disk and decrypts. Single-family today = low practical risk, but the scoping gap is live code.
- **Pros:** Closes the cross-household data exfil primitive; enforces the principle of least privilege for tool handlers.
- **Cons:** Requires surveying every existing script tool to confirm none depend on raw `ctx.db` access. Scoping via Proxy is subtle — easy to miss a table.
- **Context:** Surfaced 2026-04-23 during v0.4 /review (RT-05). v0.4 mitigation: the tools-specialty operating_instructions (in `specialty-templates/tools.md`) ask the Developer not to do this, but that's guidance, not a gate.
- **Depends on:** None.

## v0.5 — Apply-update must preserve script-tool approval invariant
- **What:** `POST /api/tools/custom/:id/apply-update` currently re-fetches `source_url`, promotes the new files, and sets `status='active'` unconditionally. For `kind='script'` tools that aren't authored by the Chief of Staff, this should re-enter `pending_approval` instead of silently going live.
- **Why:** A malicious upstream skill source can mutate its `handler.ts` and, on the next "Apply Update" click, instantly run its new code in-process. The /create path gates this behind the approval queue; /apply-update doesn't.
- **Pros:** Closes the supply-chain gap on installed script tools. Same invariant applies whether code enters via create, update, or apply-update.
- **Cons:** Extra click for the human on every script-tool upstream update. For prompt/http tool kinds the current behavior (no approval on update) is still fine.
- **Context:** Surfaced 2026-04-23 during v0.4 /review (RT-07).
- **Depends on:** None.

## v0.5 — Workspace provision crash-safety (orphan branches block retry)
- **What:** Swap the order in `dispatcher.executeDeveloperTask` so the DB UPDATE marking the task in_progress happens BEFORE `git worktree add`. If the server crashes between the two, the task stays pending (next boot re-queues) instead of orphaning a `carson/<slug>` branch + worktree dir that permanently blocks any re-try with the same title.
- **Why:** Re-running a failed Dev task with the same title currently hits `E_BRANCH_EXISTS` forever because the stale branch isn't torn down until `task.cancelled` fires. A principal who re-queues a failed task has to manually `git branch -D` + `git worktree prune`.
- **Pros:** Crash-recovery correctness; removes a real footgun for principals.
- **Cons:** If we write the DB row first and git fails, we need teardown-on-provision-failure to roll the row back to pending. Adds a second state transition.
- **Context:** Surfaced 2026-04-23 during v0.4 /review (RT-09).
- **Depends on:** None.

## v0.5 — Signal transport: delegation approval UX
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

## CoS Dev Mode: Harness Self-Modification
- **What:** Let the Chief of Staff agent modify CarsonOS source itself — add new system tools, fix bugs in the harness, ship commits via the agent. Includes a GUIDE.md for repo layout + git workflow, and git operations (commit/push/PR) as first-class agent capabilities with proper canUseTool gating.
- **Why:** Today a CoS can create custom tools but can't add a new TOOL KIND or fix a harness bug without a human opening the editor. The platform should learn from itself.
- **Pros:** Self-improving harness, Claude Code-parity for CarsonOS developers, unlocks "the right answer is to add a new system tool, not a custom one" scenarios
- **Cons:** Needs safe-restart path (tsx watch reloads on save — works for typos, crashes for real logic errors). Git as agent capability needs careful auth plumbing.
- **Context:** User surfaced during the custom tools retrospective (2026-04-14): "I want CoS to be in dev mode where it can edit CarsonOS code." Identified as the natural next layer above custom tools.
- **Depends on:** Custom tools registry (shipped in v0.2.0)

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

## v0.5 — Detached Claude adapter for durable Developer tasks
- **What:** Add a `ClaudeCodeDetachedAdapter` that spawns `claude` CLI directly with `detached: true`, `stdio: ['ignore', logFd, logFd]`, `child.unref()`. Used only for `Developer` specialty tasks. Family agents stay on the existing SDK adapter.
- **Why:** v0.4 ships with demo-grade durability — server restart kills in-flight Developer tasks (20 min of Claude work wasted, user pays tokens twice on retry). Detached adapter survives parent SIGKILL and lets the reconciler tail the JSONL log.
- **Pros:** Real durability. Enables pause/resume/steer primitives below. Moves CarsonOS closer to gbrain-minions-class reliability without the Postgres rewrite.
- **Cons:** Two adapter code paths to maintain. Session resume semantics get complex (`claude --resume <sessionId>` reloads state but can't replace system prompt). PID tracking + `ps -o lstart=` start-time verification + group-kill on teardown = real footgun surface.
- **Context:** Deferred from v0.4 per eng review (2026-04-20). Codex pushed hard on the SIGKILL test; v0.4 accepted demo-grade but flagged this as the right v0.5 primitive. See design doc `~/.gstack/projects/joshdaws-carson-os/joshdaws-main-design-20260419-172055.md` Premise 15 + "v0.5 placeholder" sections.
- **Depends on:** v0.4 shipped and one week of real-world interrupted-task rate data (to confirm this is worth building).

## v0.5 — Pause / Steer / Replay as first-class task primitives
- **What:** Three new MCP tools: `pause_task(runId)`, `send_task_message(runId, text)`, `replay_task(runId)`. Parent agent can stop a runaway Developer task, inject mid-flight guidance ("also verify mobile"), or replay with same inputs after a fix.
- **Why:** gbrain minions has all three; benchmark + docs show this is where the "whoa" lives in a delegation primitive. Real use case: you're chatting with Carson, Bob is working on HomeschoolHappy, you remember "also check the tablet layout" — `send_task_message` instead of waiting for him to finish and starting over.
- **Pros:** Huge UX win for long-running dev tasks. Matches how you'd actually work with a human developer. Uses checkpoint-friendly state you already get from Claude Code session persistence.
- **Cons:** Replay-with-same-inputs is dangerous if external state (PRs, branches) already changed — need replay-safety rules. Pause mechanics require snapshotting mid-session state, only feasible with the detached adapter.
- **Context:** Stolen wholesale from gbrain minions architecture study (2026-04-20). See full comparison in session notes.
- **Depends on:** Detached Claude adapter (above) ships first.

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

## Post-v0.4 — Music pack: audio + MIDI + theory tools as v0.3-registry SKILL.md bundles
- **What:** A bundle of custom tools for music-interested family members. Implemented as `kind: script` SKILL.md packages in the v0.3 tool registry. Audio analysis (librosa), MIDI/MusicXML (music21), Hooktheory API, Open Music Theory v2 cached citations. Inspired by what Josh's brother Jeremiah built for his son Andrew ("Morning, Andrew" capability drop, 2026-04).
- **Why:** Son will want music capabilities. Day-to-day music questions ("what key is this?", "is this too quiet for streaming?") need to happen in the conversation flow, not via delegation. These are deterministic, fast, local — classic routing-rule "code not judgment."
- **Pros:** All libraries are free and open source (librosa/pyloudnorm/music21 = MIT/BSD, Hooktheory API free, OMT = CC BY-SA). Fast (<5 sec per tool). No new infrastructure required — uses the v0.3 custom tool registry already shipped. Grounds music conversation in real data instead of LLM hallucination.
- **Cons:** Python subprocess from Node handler.ts adds a language boundary. Needs Python + librosa + music21 + pyloudnorm installed on the host. OMT content needs caching (CC BY-SA allows this) since there's no programmatic API.
- **Context:** Brother's version at Andrew's household is built as a Mozart subagent. For CarsonOS, split the surface: tools on personal agents for conversational flow, Mozart specialist (see below) for long-form composition work. Routing-rule driven.
- **Depends on:** v0.3 custom tool registry (shipped). No dependency on v0.4 delegation.

## Post-v0.4 — Mozart music specialist (hired via v0.4 delegation flow)
- **What:** Staff agent `specialty: "music"`, `model: claude-opus-4-7`, `staff_role: "custom"`. Operating instructions: composition-focused, music-theory-anchored, Hooktheory-grounded, OMT-citing. Delegated via `delegate_task` for long-form composition review, arrangement advice, multi-track EP analysis.
- **Why:** Chat-speed music questions go to the personal agent's tools (above). Deep mentorship ("review my whole EP", "help me arrange Nostalgia for string quartet") is worth Opus max effort and a dedicated persona. Same split pattern as tools-vs-Developer.
- **Pros:** Uses the v0.4 delegation flow verbatim — no new infra. Opus max for complex harmonic analysis. Natural household-staff framing (Mozart is explicitly a music mentor).
- **Cons:** Asking son to decide "chat with my agent vs delegate to Mozart" adds mental overhead. Might want an automatic heuristic in the personal agent: "if this is more than ~5 min of work, offer to hand to Mozart."
- **Context:** Complements the music-pack tools (above). Brother's version is all-subagent; CarsonOS benefits from the split.
- **Depends on:** v0.4 delegation flow shipped. Music-pack tools (above) — Mozart wraps them in a specialist system prompt.

## Future — Suno integration
- **What:** Direct Suno generation from within CarsonOS. Let the music agent generate a demo and deliver the MP3 back in Telegram.
- **Why:** Suno-as-a-tool closes the "compose → generate → iterate" loop without leaving the chat.
- **Pros:** Huge creative unlock if it works.
- **Cons:** **No official self-serve Suno API in 2026** — only enterprise tier + unreliable third-party gateways (Jeremiah's attempt blocked on gateway Google-login bug). Paid, non-trivial auth, gateway reliability is the open question.
- **Context:** Deferred explicitly — keep the "generate in Suno app, log what worked in the prompt library" workflow until Suno opens a real API.
- **Depends on:** Suno shipping a public self-serve API.
