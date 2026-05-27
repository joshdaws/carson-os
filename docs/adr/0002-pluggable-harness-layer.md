# 0002 — A pluggable harness layer routes turns by agent.model

Before v0.6.0 the engine called the Claude Agent SDK adapter directly. Every agent ran on Claude, and the model string only chose between Sonnet/Opus/Haiku inside one runtime. We wanted a second runtime — Codex, via the `codex` CLI under a ChatGPT subscription — so a family member's agent could run on either brain with the same constitution, memory, tools, personality, and Telegram streaming. This is also a hedge against Anthropic's June 15 credit metering: if one subscription gets expensive or rate-limited, agents move to the other without losing their identity or relationship.

We introduce a `Harness` abstraction. A harness owns one model family's agent loop: it runs a single turn (`streamTurn`), emits a normalized `HarnessEvent` stream (text deltas, tool calls, usage, terminal `done`/`error`), declares its `HarnessCapabilities`, and owns its own session resume. The engine resolves the harness for `agent.model` through a registry (`resolveHarness`) and never branches on a model enum. `ClaudeHarness` wraps the existing adapter unchanged; `CodexHarness` shells out to `codex exec --json`.

## Decision

- The harness key is a free-form string, not a `'claude' | 'codex'` union. Adding a model family is one `registerHarness()` call at startup plus a registry entry — not a type change rippling across the codebase. `harnessKeyForModel()` maps `agent.model` to a key (`codex/*`, `openai/*`, `gpt*` → `codex`; everything else → `claude`).
- An unknown model key falls back to the `claude` harness with a logged warning, so a typo'd or future model string degrades to a working agent rather than crashing the conversation.
- The engine and the UI picker read declared `HarnessCapabilities` (image support, MCP support, tool-refresh tier, reasoning levels, resume-token kind), so neither hardcodes per-model behavior.
- Codex gets full tool parity through a loopback streamable-HTTP MCP server running in the main process (not a subprocess), so its tools execute unjailed even though codex runs under a read-only sandbox. Per-turn bearer tokens scope each agent to its own tools. See ARCHITECTURE.md "The Harness Layer" for the security posture.

## Consequences

- A conversation can be served by different harnesses over its life. Each harness owns its own resume token (Claude `session_id`, Codex `thread_id`), so `conversations.session_context` stores a keyed shape (`{ activeHarness, sessions: { claude, codex } }`) instead of a single flat session id. The legacy flat shape is upgraded on read — no DB migration. Switching an agent's model never drops the sibling runtime's session.
- The Claude harness wraps `subprocess-adapter.ts` rather than replacing it. The adapter remains the source of truth for the Claude path; the harness only bridges its callback shape to an event stream. "Adapter" now means specifically the Claude-SDK process wrapper, not the routing layer.
- Codex authenticates through a per-conversation `CODEX_HOME` auth bridge (read-only sandbox, no shell/browser/computer tools, `OPENAI_API_KEY` stripped). Two family members' Codex sessions never share tool or session state. If the disabled shell/file tools are ever re-enabled, the token-exposure tradeoff in `codex-auth-bridge.ts` must be revisited.
- Abort plumbing differs per harness. The Claude harness links the incoming `AbortSignal` to the adapter's controller; the Codex harness bounds a turn with a watchdog timeout because the engine has no abort path into the codex subprocess.
