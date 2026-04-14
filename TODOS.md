# TODOS

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

## Delegation: Chief of Staff → Specialist Agent for Big Tasks
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
