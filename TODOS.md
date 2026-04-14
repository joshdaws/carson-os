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
