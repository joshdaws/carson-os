# Tool Creation Guide

This is the playbook for creating custom tools in CarsonOS. Read this before
calling any of the `create_*_tool` functions. It replaces the need to explore
the CarsonOS source code or write installer scripts.

## What is a custom tool?

A custom tool is a capability you register once and can then invoke forever
after, scoped to this household. Tools persist across conversations and server
restarts. Other agents in the household can be granted access to your tools
via the admin UI.

## The three kinds

Pick exactly one. If unsure, prefer `http`.

### `http` — Wrap a REST API
Use this when the task is "call an external API and return the response." The
system handles auth, allowlisting, timeouts, and response parsing for you.

Best for: YNAB, weather APIs, package tracking, calendar lookups, anything
that's a single HTTP request.

### `prompt` — Save a reusable instruction template
Use this when the task is a multi-step workflow the agent should follow using
its OTHER tools. The "tool" is just a filled-in markdown template that the
calling agent then executes step by step. NO separate LLM call happens.

Best for: "weekly family briefing" (calls calendar + email + memory tools),
"grocery list from meal plan", canned multi-step procedures.

### `script` — Run TypeScript server-side
Use this ONLY when `http` + `prompt` aren't enough. Script tools are full
TypeScript handlers with access to the household's DB, memory, and secrets.

Best for: multi-step API flows that can't be expressed as one HTTP call, data
transformation, custom logic.

Note: script tools created by non-Chief-of-Staff agents enter `pending_approval`
until a Chief of Staff approves them via admin UI. If you're not the Chief of
Staff, this is expected — the user will need to approve.

## The happy path (follow this)

For 90% of tool creation requests (any REST API), the flow is:

```
1. Ask the user for the API token if they haven't given it.
   Keep it short: "What's your YNAB Personal Access Token? Get one at
   https://app.ynab.com/settings/developer"

2. Call store_secret({ key_name: "ynab_api_token", value: <token> })
   This MUST happen BEFORE create_http_tool if the tool uses auth.

3. Call create_http_tool({ ... }) with the tool definition.
```

That's it. Three calls. Under 30 seconds.

## Worked example: YNAB budget check

User: "Build me a tool that lists our YNAB budgets."

Carson:
1. "What's your YNAB Personal Access Token? Get one at https://app.ynab.com/settings/developer"
2. (user gives token)
3. `store_secret({ key_name: "ynab_api_token", value: "..." })`
4. `create_http_tool({
     name: "ynab_list_budgets",
     description: "List all YNAB budgets in our household",
     input_schema: { type: "object", properties: {} },
     method: "GET",
     urlTemplate: "https://api.ynab.com/v1/budgets",
     auth: { method: "bearer", secretKey: "ynab_api_token" }
   })`
5. "Done. The `ynab_list_budgets` tool is ready. Try it on your next message."

## Auth shapes

The `auth` field is one of three shapes, pick the one the API uses:

```
{ method: "bearer", secretKey: "my_token" }
  → Authorization: Bearer <secret>

{ method: "header", name: "X-API-Key", secretKey: "my_token" }
  → <name>: <secret>

{ method: "query", param: "api_key", secretKey: "my_token" }
  → ?<param>=<secret>
```

Check the API's docs for which it uses. YNAB uses `bearer`. OpenWeather uses
`query` with `appid`. Most API keys are `bearer` or `header`.

## Naming conventions

- Tool names: `snake_case`, lowercase, underscores, max 64 chars. Good: `ynab_list_budgets`. Bad: `YNABBudgets`, `ynab budgets`, `ynab-budgets`.
- Prefix tools that belong together: `ynab_list_budgets`, `ynab_get_accounts`, `ynab_get_transactions`. Makes permissions easy to manage (grant `ynab_list_*` to kids, keep `ynab_update_*` to adults).
- Use `bundle: "ynab"` in the create call to put related tools in the same filesystem directory.

## Anti-patterns — DON'T do these

- **DON'T write installer scripts.** `create_http_tool` IS the installer. You don't need `server/src/scripts/install-*.ts`. You don't need the user to run `npx tsx` anything.
- **DON'T explore carson-os source.** You don't need to read `tool-registry.ts`, `custom-tools/handlers.ts`, or the schema. The `create_*_tool` MCP tools handle everything.
- **DON'T use Bash, Write, or Edit.** These won't be granted for tool creation. If the SDK denies a tool call, DO NOT try a different built-in. Use the MCP tools.
- **DON'T use WebFetch as a shortcut for custom tools.** Once you've created an HTTP tool for an API, ALWAYS use that tool, not WebFetch. Directly fetching with WebFetch bypasses auth-secret injection, domain allowlisting, and activity logging — the whole security layer. If a user asks a question right after you built a tool and the tool hasn't appeared in your tool list yet, the system will refresh your tools automatically before your next turn. Wait for the refresh. Don't shortcut.
- **DON'T batch questions.** Ask for the API token in one turn. Then store + create in the next turn. Don't ask "what endpoints do you want, what should the tool be named, what's your token, should it be read-only" all at once.
- **DON'T preface with "let me check the codebase first".** You have everything you need in this guide.

## Secret hygiene: redact tokens from chat after storing

When the user pastes an API token or other secret into the conversation, the
message is stored in plaintext in the chat history and may still be visible in
the Telegram chat scrollback. After you successfully call `store_secret`, call
`redact_recent_user_message({ reason: 'contained API token' })` to:
  - Replace the message content in our DB with `[REDACTED: contained API token]`
  - Log the redaction so there's an audit trail

This should happen IMMEDIATELY after `store_secret` returns success, before you
call any `create_*_tool`. Order: ask for secret → user pastes → store_secret →
redact_recent_user_message → create_http_tool(s) → short reply.

## Failure modes (what to do when things fail)

If `create_http_tool` returns `validation_error`:
- Read the error's `content` field. It will say exactly which field is wrong and what to try.
- Fix that one field. Retry. Don't rebuild everything from scratch.

If you get `auth_missing`:
- The secret wasn't stored. Call `store_secret` first, then retry `create_http_tool`.

If you get `domain_blocked`:
- The `urlTemplate` points at a domain that isn't in the allowlist. Either fix the URL or add `domainAllowlist: ["api.example.com"]` to the create call.

If you get `permission_denied` on `update_custom_tool`:
- You're trying to modify a tool someone else created and you're not the Chief of Staff. Ask the creator or CoS to make the change.

## Multi-tool integrations (bundles)

For a full YNAB integration, you'd create multiple related tools in a bundle.
Call `create_http_tool` once per capability:

- `ynab_list_budgets` (GET /budgets)
- `ynab_get_accounts` (GET /budgets/{budget_id}/accounts)
- `ynab_get_categories` (GET /budgets/{budget_id}/categories)
- `ynab_get_transactions` (GET /budgets/{budget_id}/transactions)

Each call takes about 5 seconds. A full YNAB integration should take under 30
seconds of real work plus however long the user takes to answer questions.

Pass `bundle: "ynab"` in every call so they're organized together on disk.

## When NOT to use a custom tool

- If the integration already exists as a built-in (Gmail, Google Calendar, Drive) — just ask the user to grant access to the existing tool.
- If the user is asking a one-time question ("how much did we spend last month?") — call the existing tools and answer directly. Don't create a tool every time.
- If you're trying to debug or explore — that's what memory search and conversation are for.

## Summary

Tool creation is four or five MCP calls at most. `store_secret` then
`create_http_tool` (or multiple, for a bundle). Short reply to the user.
Done.

If this guide doesn't cover your case, ask the user what they want. Do not
infer by reading the codebase.
