/**
 * System tool definitions for custom tool management, authored as LLM-friendly
 * tool definitions. Each definition embeds a concrete example in its description
 * so Claude-family models get higher first-call success rates.
 *
 * Tools are split by kind (create_http_tool, create_prompt_tool, create_script_tool)
 * rather than using a polymorphic config discriminator — LLMs do measurably better
 * with flat, kind-specific schemas.
 */

import type { ToolDefinition } from "@carsonos/shared";

export const CUSTOM_TOOL_SYSTEM_TOOLS: ToolDefinition[] = [
  {
    name: "create_http_tool",
    description:
      "Create an HTTP custom tool for calling an external REST API. Use this for APIs that take parameters and return JSON. " +
      "Example: { name: 'check_weather', description: 'Get current weather for a city', " +
      "input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, " +
      "method: 'GET', urlTemplate: 'https://api.weather.com/v1/current?q={{city}}', " +
      "auth: { method: 'query', param: 'appid', secretKey: 'weather_api_token' } }. " +
      "IMPORTANT: If using auth.secretKey, call store_secret({ key_name, value }) FIRST so the secret exists before the tool is invoked.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Short identifier in snake_case (lowercase, underscores only, max 64 chars). Example: 'check_ynab_balance'.",
        },
        description: {
          type: "string",
          description:
            "One-line explanation starting with a verb. Shown to agents choosing which tool to invoke. Example: 'Get current balance for a YNAB account.'",
        },
        input_schema: {
          type: "object",
          description:
            "JSON Schema describing tool inputs. Must have type='object' at root. Example: { type: 'object', properties: { budget_id: { type: 'string' } }, required: ['budget_id'] }.",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method. Example: 'GET'.",
        },
        urlTemplate: {
          type: "string",
          description:
            "Full HTTPS URL with {{placeholder}} tokens. Example: 'https://api.ynab.com/v1/budgets/{{budget_id}}/accounts'. Non-HTTPS is rejected.",
        },
        headers: {
          type: "object",
          description: "Optional static headers. Example: { 'Accept': 'application/json' }.",
        },
        auth: {
          type: "object",
          description:
            "Optional auth config. One of: { method: 'bearer', secretKey: 'my_token' } OR { method: 'header', name: 'X-API-Key', secretKey: 'my_token' } OR { method: 'query', param: 'api_key', secretKey: 'my_token' }. The secretKey must be stored via store_secret first.",
        },
        bodyTemplate: {
          type: "string",
          description:
            "Optional JSON body with {{placeholder}} substitution, for POST/PUT/PATCH. Example: '{\"amount\": {{amount_cents}}}'.",
        },
        responseExtract: {
          type: "string",
          description:
            "Optional JSONPath to extract from response. Example: '$.items'. Omit to return the full response text.",
        },
        domainAllowlist: {
          type: "array",
          description:
            "Optional allowed domains. If omitted, only urlTemplate's domain is allowed. Empty array [] is invalid. Example: ['api.ynab.com'].",
        },
        bundle: {
          type: "string",
          description:
            "Optional bundle/group name for filesystem organization. Example: 'ynab'. Related tools can share a bundle.",
        },
      },
      required: ["name", "description", "input_schema", "method", "urlTemplate"],
    },
  },
  {
    name: "create_prompt_tool",
    description:
      "Create a prompt custom tool: a reusable instruction template the calling agent follows step-by-step using its other tools. " +
      "NO separate LLM call happens; the template text is filled with placeholders and returned to the agent as instructions. " +
      "Example: { name: 'family_briefing', description: 'Prepare weekly family briefing using calendar, email, and memory', " +
      "input_schema: { type: 'object', properties: { member_name: { type: 'string' } }, required: ['member_name'] }, " +
      "body: '# Briefing for {{member_name}}\\n\\nSteps:\\n1. Call list_calendar_events(days=7)\\n2. Call gmail_triage(query=\"is:unread\")\\n...' }",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Snake_case identifier. Example: 'family_briefing'." },
        description: {
          type: "string",
          description:
            "One-line explanation. Example: 'Prepare weekly family briefing using calendar, email, and memory.'",
        },
        input_schema: {
          type: "object",
          description:
            "JSON Schema for the template's variables. Example: { type: 'object', properties: { member_name: { type: 'string' } } }.",
        },
        body: {
          type: "string",
          description:
            "Markdown template with {{placeholder}} tokens. When invoked, placeholders are filled and returned as the tool result. Example: 'Steps for {{member_name}}: 1. Do X. 2. Do Y.'",
        },
        bundle: { type: "string", description: "Optional bundle/group name." },
      },
      required: ["name", "description", "input_schema", "body"],
    },
  },
  {
    name: "create_script_tool",
    description:
      "Create a script custom tool with a TypeScript handler running server-side in the main Node process with household-scoped context. " +
      "Use this for complex workflows, multi-step API calls, or data transformation. Your handler receives (input, ctx) where ctx contains: " +
      "db (household-scoped Drizzle client), fetch (standard Fetch API, unrestricted), getSecret(key_name) => Promise<string | null>, " +
      "memory (household's MemoryProvider), householdId, memberId?, memberName?, log(msg) (writes to server stdout). " +
      "Imports allowed: any installed npm package. " +
      "Example handler_code: `import type { CustomToolContext, ToolResult } from '@carsonos/shared'; " +
      "export async function handler(input: any, ctx: CustomToolContext): Promise<ToolResult> { " +
      "const token = await ctx.getSecret('ynab_api_token'); " +
      "if (!token) return { content: 'Token missing', is_error: true }; " +
      "const res = await ctx.fetch('https://api.ynab.com/v1/budgets', { headers: { Authorization: 'Bearer ' + token } }); " +
      "return { content: JSON.stringify((await res.json()).data, null, 2) }; }`. " +
      "IMPORTANT: Script tools created by agents who are NOT the Chief of Staff enter 'pending_approval' status and require review via admin UI before they activate.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Snake_case identifier. Example: 'analyze_spending'." },
        description: {
          type: "string",
          description: "One-line explanation. Example: 'Deep YNAB spending analysis with category trends.'",
        },
        input_schema: {
          type: "object",
          description: "JSON Schema for handler input. Example: { type: 'object', properties: { months: { type: 'number' } } }.",
        },
        handler_code: {
          type: "string",
          description:
            "Full TypeScript source for handler.ts. Must export 'async function handler(input, ctx)'. Will be validated via esbuild at create time.",
        },
        bundle: { type: "string", description: "Optional bundle/group name." },
      },
      required: ["name", "description", "input_schema", "handler_code"],
    },
  },
  {
    name: "list_custom_tools",
    description:
      "List all custom tools in this household. Returns name, description, kind, status, usage_count, and last_used_at for each. " +
      "Use this to see what tools exist before creating a new one or when the user asks what custom tools are available.",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["http", "prompt", "script"],
          description: "Optional: filter by kind.",
        },
        include_disabled: {
          type: "boolean",
          description: "Default: false. Set true to include disabled tools.",
        },
        include_pending: {
          type: "boolean",
          description: "Default: false. Set true to include tools awaiting approval.",
        },
      },
    },
  },
  {
    name: "update_custom_tool",
    description:
      "Update an existing custom tool's definition. Requires MODIFY permission (you created it, or you are Chief of Staff). " +
      "For script tools: if handler_code changes, the tool enters 'pending_approval' until the Chief of Staff approves via admin UI " +
      "(except when the updater IS the Chief of Staff — then auto-approve). " +
      "Pass only the fields you want to change.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the tool to update (identifier)." },
        description: { type: "string", description: "New description (optional)." },
        input_schema: { type: "object", description: "New input schema (optional)." },
        method: { type: "string", description: "HTTP only: new method (optional)." },
        urlTemplate: { type: "string", description: "HTTP only: new URL template (optional)." },
        headers: { type: "object", description: "HTTP only: new headers (optional)." },
        auth: { type: "object", description: "HTTP only: new auth config (optional)." },
        bodyTemplate: { type: "string", description: "HTTP only: new body template (optional)." },
        responseExtract: { type: "string", description: "HTTP only: new response extract (optional)." },
        domainAllowlist: { type: "array", description: "HTTP only: new domain allowlist (optional)." },
        body: { type: "string", description: "Prompt only: new markdown body (optional)." },
        handler_code: { type: "string", description: "Script only: new TypeScript source (optional)." },
      },
      required: ["name"],
    },
  },
  {
    name: "disable_custom_tool",
    description:
      "Disable a custom tool (reversible). The tool stops appearing in agent tool lists but grants are preserved, " +
      "so re-enabling restores access. Use this when a tool is misbehaving or no longer needed. " +
      "For permanent deletion, use the admin UI.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Name of the tool to disable." } },
      required: ["name"],
    },
  },
  {
    name: "store_secret",
    description:
      "Store an encrypted secret (API key, password, token) for use by custom tools. Called by its key_name from HTTP tools' " +
      "auth.secretKey and from script tools via ctx.getSecret(key_name). Encrypted with AES-256-GCM. Never logged. " +
      "Example: store_secret({ key_name: 'ynab_api_token', value: 'abc123...' }). " +
      "Calling with an existing key_name overwrites (rotation). ALWAYS call this BEFORE creating a tool that references the secret.",
    input_schema: {
      type: "object",
      properties: {
        key_name: {
          type: "string",
          description: "Short identifier in snake_case. Example: 'ynab_api_token'. Reference via auth.secretKey or ctx.getSecret.",
        },
        value: {
          type: "string",
          description: "The secret value. Encrypted at rest; never logged or returned from list APIs.",
        },
      },
      required: ["key_name", "value"],
    },
  },
  {
    name: "install_skill",
    description:
      "Install a skill from skills.sh or a URL as custom tools in this household. The skill's SKILL.md file(s) become registered tools. " +
      "Only the Chief of Staff can install; grant to others via the admin UI after install. " +
      "Example: install_skill({ source: 'skills.sh/softwaredry/agent-toolkit' }). " +
      "HTTPS only; the URL must return an actual .tar.gz archive, not a web page. " +
      "Page URLs returning HTML will be rejected — look for a 'Download' or release asset link.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description:
            "skills.sh shorthand ('skills.sh/<author>/<package>', 1-3 path segments) OR a direct HTTPS URL to a .tar.gz archive. " +
            "Examples: 'skills.sh/youtube-transcript', 'skills.sh/softwaredry/agent-toolkit', 'https://github.com/user/skill/releases/download/v1/skill.tar.gz'.",
        },
        rename: {
          type: "string",
          description: "Optional local name override (to avoid collision with an existing tool).",
        },
      },
      required: ["source"],
    },
  },
];

export const CUSTOM_TOOL_NAMES = new Set(CUSTOM_TOOL_SYSTEM_TOOLS.map((t) => t.name));
