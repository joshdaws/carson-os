/**
 * Subprocess adapter -- pluggable LLM execution layer.
 *
 * Three adapters:
 *   1. ClaudeCodeAdapter      -- spawns `claude` CLI (text only, no tools)
 *   2. CodexAdapter           -- spawns `codex` CLI
 *   3. ClaudeAgentSdkAdapter  -- Claude Agent SDK with MCP tools (default)
 *
 * The Agent SDK adapter uses the Claude subscription (no API key needed).
 * Tools are exposed as an MCP server that the SDK manages internally.
 * This is the same pattern mr-carson uses.
 */

import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  AdapterType,
  AdapterExecuteParams,
  AdapterExecuteResult,
} from "@carsonos/shared";

// -- Adapter interface -----------------------------------------------

export interface Adapter {
  name: string;
  execute(params: AdapterExecuteParams): Promise<AdapterExecuteResult>;
  healthCheck(): Promise<boolean>;
}

// -- Constants -------------------------------------------------------

const TIMEOUT_MS = 120_000;
const IS_WIN = process.platform === "win32";
const WHICH_CMD = IS_WIN ? "where" : "which";
const CLAUDE_BIN = IS_WIN ? "claude.cmd" : "claude";
const CODEX_BIN = IS_WIN ? "codex.cmd" : "codex";

// Quote an arg for cmd.exe when spawning with shell:true. Node joins args with
// spaces and hands the whole string to `cmd.exe /d /s /c` without quoting, so
// any arg containing whitespace (e.g. a temp path under "C:\Users\John Doe\...")
// will be misparsed unless we wrap it ourselves.
function quoteWinArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function spawnArgs(args: string[]): string[] {
  return IS_WIN ? args.map(quoteWinArg) : args;
}

type JsonSchemaProperty = {
  type?: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
};

function jsonSchemaPropToZod(prop: JsonSchemaProperty): z.ZodTypeAny {
  if (prop.enum && prop.enum.length > 0) {
    return z.enum(prop.enum as [string, ...string[]]);
  }

  switch (prop.type) {
    case "object":
      return z.record(z.string(), z.unknown());
    case "array":
      return z.array(prop.items ? jsonSchemaPropToZod(prop.items) : z.unknown());
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "string":
    default:
      return z.string();
  }
}

function computeToolSignature(toolDefs: import("@carsonos/shared").ToolDefinition[]): string {
  const payload = toolDefs
    .map((toolDef) => ({
      name: toolDef.name,
      description: toolDef.description,
      input_schema: toolDef.input_schema,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Process-global cache of `tool()` return values keyed by tool name.
 *
 * The Claude Agent SDK's tool()/createSdkMcpServer pair retains global state
 * about registered tool names and throws "Tool X is already registered" when
 * you call tool() twice with the same name — which happens in our flow
 * whenever we rebuild the MCP server (either for a mid-session refresh or on
 * a subsequent execute() call).
 *
 * By caching the SdkMcpToolDefinition objects by name, we avoid the SDK's
 * global-state tripwire entirely. Each cached entry carries a mutable
 * `handlerRef` so the actual executor invoked at tool-call time always
 * resolves to the current request's engine-provided executor, not a stale
 * closure from when the tool was first registered.
 *
 * Tradeoff: the SdkMcpToolDefinition's cached `description` and Zod `shape`
 * are sticky for the process lifetime. If a tool's name is reused with a
 * different input_schema in a later call, the old shape wins until restart.
 * For M1 this is acceptable — update_custom_tool changes rarely and a
 * server restart picks them up. Revisit if/when that becomes painful.
 */
type HandlerRef = { current: import("@carsonos/shared").ToolExecutor };
type CachedTool = { def: ReturnType<typeof tool>; handlerRef: HandlerRef };
const mcpToolCache = new Map<string, CachedTool>();

function getOrCreateCachedTool(
  def: import("@carsonos/shared").ToolDefinition,
  executor: import("@carsonos/shared").ToolExecutor,
  onCall: (name: string, input: Record<string, unknown>, result: import("@carsonos/shared").ToolResult) => void,
): ReturnType<typeof tool> {
  const cached = mcpToolCache.get(def.name);
  if (cached) {
    cached.handlerRef.current = executor;
    return cached.def;
  }

  const handlerRef: HandlerRef = { current: executor };
  const properties = (def.input_schema.properties ?? {}) as Record<string, JsonSchemaProperty>;
  const required = (def.input_schema.required ?? []) as string[];
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(properties)) {
    let fieldSchema = jsonSchemaPropToZod(prop);
    if (prop.description) fieldSchema = fieldSchema.describe(prop.description);
    if (!required.includes(key)) fieldSchema = fieldSchema.optional();
    shape[key] = fieldSchema;
  }

  const newDef = tool(def.name, def.description, shape, async (input: Record<string, unknown>) => {
    const result = await handlerRef.current(def.name, input);
    onCall(def.name, input, result);
    return {
      content: [{ type: "text" as const, text: result.content }],
      isError: result.is_error,
    };
  });

  mcpToolCache.set(def.name, { def: newDef, handlerRef });
  return newDef;
}

// -- Claude Code adapter (text only, no tools) -----------------------

class ClaudeCodeAdapter implements Adapter {
  name = "claude-code";

  // Clean working directory so Claude CLI doesn't load CLAUDE.md from any project
  private cleanDir: string | null = null;

  private getCleanDir(): string {
    if (!this.cleanDir) {
      this.cleanDir = mkdtempSync(join(tmpdir(), "carsonos-agent-"));
    }
    return this.cleanDir;
  }

  async execute(params: AdapterExecuteParams): Promise<AdapterExecuteResult> {
    const { systemPrompt, messages, maxTokens } = params;

    // Build the user message from the messages array
    const userMessage = messages
      .map((m) => (m.role === "user" ? m.content : `[assistant]: ${m.content}`))
      .join("\n\n");

    // Write system prompt to a temp file to avoid CLI argument length limits
    const promptFile = join(this.getCleanDir(), `prompt-${Date.now()}.txt`);
    writeFileSync(promptFile, systemPrompt);

    // Pipe the user message via stdin instead of -p <arg>. This avoids cmd.exe
    // mangling quotes/newlines on Windows when shell:true is required for .cmd files.
    const args = [
      "--output-format", "json",
      "--max-turns", "3",
      "--allowed-tools", "none",
      "--system-prompt-file", promptFile,
      "-p",
    ];

    if (maxTokens) {
      args.push("--max-tokens", String(maxTokens));
    }

    return new Promise<AdapterExecuteResult>((resolve, reject) => {
      // shell:true is required on Windows to spawn .cmd files (Node CVE-2024-27980).
      const child = spawn(CLAUDE_BIN, spawnArgs(args), {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: TIMEOUT_MS,
        cwd: this.getCleanDir(),
        shell: IS_WIN,
      });

      child.stdin.write(userMessage);
      child.stdin.end();

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        reject(new Error(`Claude Code binary failed to start: ${err.message}`));
      });

      child.on("close", (code) => {
        try {
          const parsed = JSON.parse(stdout);

          if (parsed.is_error || code !== 0) {
            const errorMsg = parsed.result || parsed.error || stderr || "unknown error";
            console.error(`[adapter] Claude stdout: ${stdout.slice(0, 500)}`);
            console.error(`[adapter] Claude stderr: ${stderr.slice(0, 500)}`);
            reject(new Error(`Claude Code error (exit ${code}): ${errorMsg}`));
            return;
          }

          const content =
            typeof parsed.result === "string"
              ? parsed.result
              : typeof parsed.content === "string"
                ? parsed.content
                : stdout;

          resolve({
            content,
            metadata: { adapter: "claude-code", exitCode: code },
          });
        } catch {
          resolve({
            content: stdout.trim(),
            metadata: { adapter: "claude-code", rawOutput: true },
          });
        }
      });

      setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Claude Code timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      execFileSync(WHICH_CMD, ["claude"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }
}

// -- Codex adapter ---------------------------------------------------

class CodexAdapter implements Adapter {
  name = "codex";

  async execute(params: AdapterExecuteParams): Promise<AdapterExecuteResult> {
    const { systemPrompt, messages } = params;

    const userMessage = messages
      .map((m) => (m.role === "user" ? m.content : `[assistant]: ${m.content}`))
      .join("\n\n");

    const fullPrompt = `${systemPrompt}\n\n---\n\n${userMessage}`;

    // Pipe the prompt via stdin (codex exec reads stdin when no prompt arg is given).
    // This avoids cmd.exe quoting issues on Windows for multi-line prompts with quotes.
    const args = ["exec"];

    return new Promise<AdapterExecuteResult>((resolve, reject) => {
      // shell:true is required on Windows to spawn .cmd files (Node CVE-2024-27980).
      const child = spawn(CODEX_BIN, spawnArgs(args), {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: TIMEOUT_MS,
        shell: IS_WIN,
      });

      child.stdin.write(fullPrompt);
      child.stdin.end();

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        reject(new Error(`Codex binary failed to start: ${err.message}`));
      });

      child.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `Codex exited with code ${code}: ${stderr || "no stderr"}`,
            ),
          );
          return;
        }

        resolve({
          content: stdout.trim(),
          metadata: { adapter: "codex", exitCode: code },
        });
      });

      setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Codex timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      execFileSync(WHICH_CMD, ["codex"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }
}

// -- Claude Agent SDK adapter (with MCP tools) -----------------------

const DEFAULT_MODEL = "sonnet";

/**
 * Per-session turn limit for the Claude Agent SDK.
 *
 * The SDK's circuit breaker against runaway tool-call loops (search → think
 * → search → ... burning tokens without progress). Configurable because
 * different use cases want different ceilings:
 *   - simple Q&A: 10–20 is fine
 *   - tool creation / multi-step work: 50–80
 *   - one-shot scripted tasks: can be lower
 *
 * Clamped to [1, 200]. Override via CARSONOS_MAX_TURNS env var.
 *
 * Hitting the limit is NOT a silent failure — we catch the SDK error and
 * surface a user-visible "I got stuck" message so the human knows to retry
 * with tighter scope. See the try/catch around the for-await loop below.
 */
function parseMaxTurns(): number {
  const raw = process.env.CARSONOS_MAX_TURNS;
  if (!raw) return 50;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(200, Math.floor(n));
}
const MAX_TURNS = parseMaxTurns();

/** Matches the SDK's "Reached maximum number of turns (N)" error. */
function isTurnLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /Reached maximum number of turns/i.test(msg);
}

/**
 * Build an AsyncIterable<SDKUserMessage> that yields a single user turn with
 * text + image content blocks. Used when the caller passes media attachments.
 *
 * The full conversation history is collapsed into the text part (matches the
 * non-multimodal path's prompt construction). The images are appended as
 * Anthropic-format image blocks, which Claude 4.x models all accept natively.
 */
function buildMultimodalPrompt(
  userPromptText: string,
  attachments: import("@carsonos/shared").MediaAttachment[],
): AsyncIterable<import("@anthropic-ai/claude-agent-sdk").SDKUserMessage> {
  type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  const ALLOWED_IMAGE_MIMES = new Set<ImageMime>([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ]);

  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: { type: "base64"; media_type: ImageMime; data: string };
      }
  > = [];

  for (const att of attachments) {
    if (att.type !== "image") continue;
    if (!ALLOWED_IMAGE_MIMES.has(att.mediaType as ImageMime)) continue;
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: att.mediaType as ImageMime,
        data: att.base64,
      },
    });
  }

  // Text follows the images so the model reads context after seeing them.
  content.push({ type: "text", text: userPromptText });

  return (async function* () {
    yield {
      type: "user" as const,
      parent_tool_use_id: null,
      message: {
        role: "user" as const,
        content,
      },
    };
  })();
}

class ClaudeAgentSdkAdapter implements Adapter {
  name = "claude-agent-sdk";

  async execute(params: AdapterExecuteParams): Promise<AdapterExecuteResult> {
    const { systemPrompt, messages, tools, toolExecutor, model, attachments } = params;
    const traceId = (params as AdapterExecuteParams & { traceId?: string }).traceId;
    const tracePrefix = traceId ? `[adapter:${traceId}]` : "[adapter]";

    // Build the user prompt from the messages array
    const userPrompt = messages
      .map((m) => (m.role === "user" ? m.content : `[assistant]: ${m.content}`))
      .join("\n\n");

    // When attachments (images, etc) are present, swap the string prompt for
    // an AsyncIterable<SDKUserMessage> that yields a single user message with
    // text + image content blocks. This goes to the agent's actual model
    // (sonnet/opus/haiku — all multimodal) in one round-trip; no Haiku
    // pre-describe needed.
    const hasAttachments = !!attachments && attachments.length > 0;
    const promptForSdk = hasAttachments
      ? buildMultimodalPrompt(userPrompt, attachments!)
      : userPrompt;

    // Build MCP server with memory tools if tools + executor provided
    let mcpConfig: Record<string, ReturnType<typeof createSdkMcpServer>> | undefined;
    const allowedTools: string[] = [];
    const allToolCalls: Array<{ name: string; input: Record<string, unknown>; result: { content: string; is_error?: boolean } }> = [];

    // Each execute() invocation + each mid-session refresh gets a unique MCP
    // server name. createSdkMcpServer / tool() retain process-global state
    // about registered tool names, so re-creating a server with the same name
    // and overlapping tools throws "Tool X is already registered". Unique
    // names force the SDK to cleanly disconnect the prior server via
    // setMcpServers (or avoid the collision on initial init across calls).
    const MCP_SERVER_BASE = "carsonos-memory";
    let mcpServerCounter = 0;
    const nextMcpServerName = () => `${MCP_SERVER_BASE}-${Date.now()}-${++mcpServerCounter}`;
    let currentMcpServerName = nextMcpServerName();

    // Forward-declared so the tool() callback can call it after a successful
    // tool-list-modifying tool returns. Assigned below once conversation exists.
    let triggerRefresh: (toolName: string) => Promise<void> = async () => {};

    /**
     * Build an MCP server config from a tool list + executor. Reuses cached
     * SdkMcpToolDefinitions keyed by name to avoid the SDK's "Tool X is
     * already registered" error on rebuilds.
     */
    const buildMcpServer = (
      toolDefs: import("@carsonos/shared").ToolDefinition[],
      executor: import("@carsonos/shared").ToolExecutor,
    ) => {
      const onCall = (
        name: string,
        input: Record<string, unknown>,
        result: import("@carsonos/shared").ToolResult,
      ) => {
        allToolCalls.push({ name, input, result });
        if (!result.is_error && TOOL_LIST_MODIFYING.has(name)) {
          // Fire and forget — the MCP swap runs async so we don't block
          // returning this tool's result to the SDK.
          void triggerRefresh(name);
        }
      };
      // Defensive dedup by tool name. If upstream hands us duplicates (e.g.
      // a tool resolving via both the bare-name path and the scoped-name
      // path in getAgentTools), createSdkMcpServer throws "already
      // registered". Pick the first occurrence.
      const seenNames = new Set<string>();
      const uniqueDefs: typeof toolDefs = [];
      for (const t of toolDefs) {
        if (seenNames.has(t.name)) {
          console.warn(`[adapter] buildMcpServer dropping duplicate tool: ${t.name}`);
          continue;
        }
        seenNames.add(t.name);
        uniqueDefs.push(t);
      }
      const mcpTools = uniqueDefs.map((t) => getOrCreateCachedTool(t, executor, onCall));
      console.log(`${tracePrefix} buildMcpServer server=${currentMcpServerName} tools=${uniqueDefs.length}${toolDefs.length !== uniqueDefs.length ? ` (deduped from ${toolDefs.length})` : ""}`);
      return createSdkMcpServer({
        name: currentMcpServerName,
        version: "1.0.0",
        tools: mcpTools,
      });
    };

    if (tools && tools.length > 0 && toolExecutor) {
      const mcpServer = buildMcpServer(tools, toolExecutor);
      mcpConfig = { [currentMcpServerName]: mcpServer };
      for (const t of tools) {
        allowedTools.push(`mcp__${currentMcpServerName}__${t.name}`);
      }
    }

    // Track the current tool set for change detection during for-await
    let currentMcpToolNames = new Set((tools ?? []).map((t) => t.name));
    let currentToolSignature = computeToolSignature(tools ?? []);

    /**
     * Tool names whose successful execution should trigger a mid-session MCP
     * server refresh so newly-created/updated tools become immediately usable.
     */
    const TOOL_LIST_MODIFYING = new Set([
      "create_http_tool",
      "create_prompt_tool",
      "create_script_tool",
      "update_custom_tool",
      "disable_custom_tool",
      "install_skill",
    ]);

    // Resolve model name to SDK shorthand
    const sdkModel = model === "claude-sonnet-4-6" ? "sonnet"
      : model === "claude-opus-4-6" ? "opus"
      : model === "claude-haiku-4-5-20251001" ? "haiku"
      : model ?? DEFAULT_MODEL;

    // Build env, filtering out undefined values
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    delete env.CLAUDECODE; // Allow SDK to spawn Claude from within a Claude session

    const t0 = Date.now();

    // Collect text blocks from assistant turns
    const assistantTextBlocks: string[] = [];
    let resultText = "";
    let capturedSessionId: string | null = null;
    let totalCost: number | null = null;
    let numTurns: number | null = null;
    let firstDeltaMs: number | null = null;

    const allAllowedTools = [...allowedTools];

    const onTextDelta = params.onTextDelta;

    const isResume = !!params.resumeSessionId;
    console.log(
      `${tracePrefix} payload systemPromptChars=${systemPrompt.length} systemPromptHash=${shortHash(systemPrompt)} userPromptChars=${userPrompt.length} messages=${messages.length} mcpToolDefs=${tools?.length ?? 0} builtinTools=${params.builtinTools?.length ?? 0} allowedMcpTools=${allowedTools.length} resume=${isResume ? "yes" : "no"}`,
    );

    // Trust-level enforcement via canUseTool callback.
    //
    // `bypassPermissions` skips the interactive "Allow this tool?" prompt (we
    // have no human operator to prompt), but empirically the declarative
    // `tools`/`disallowedTools` lists do NOT reliably block tool calls when
    // bypassPermissions is set. The SDK's `canUseTool` hook is the real
    // enforcement point: it's invoked on EVERY tool call and its decision is
    // authoritative.
    //
    // Rules:
    //   - Built-in tools (Bash/Read/Write/etc) must be in params.builtinTools
    //   - MCP tools (prefix `mcp__`) always allowed (they're our own)
    //   - Anything else: deny with a retry hint the model can act on
    const grantedBuiltins = new Set(params.builtinTools ?? []);
    const canUseToolCallback = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<
      | { behavior: "allow"; updatedInput: Record<string, unknown> }
      | { behavior: "deny"; message: string }
    > => {
      // MCP tool prefix starts with mcp__{currentMcpServerName}__, but since
      // the server name is versioned and may change via setMcpServers, accept
      // any mcp__{base}-*__ prefix for the duration of this execute() call.
      if (toolName.startsWith(`mcp__${MCP_SERVER_BASE}`)) {
        const match = toolName.match(/^mcp__[^_]+(?:-[^_]+)*__(.+)$/);
        const bareName = match ? match[1] : toolName.split("__").slice(-1)[0];
        if (currentMcpToolNames.has(bareName)) {
          return { behavior: "allow", updatedInput: input };
        }
      }
      // Claude Code built-ins: only allow if granted by trust level
      if (grantedBuiltins.has(toolName)) return { behavior: "allow", updatedInput: input };
      // Anything else: deny with a pointer to the right approach
      return {
        behavior: "deny",
        message: `'${toolName}' is not available at this agent's trust level. To build a tool, call one of: create_http_tool, create_prompt_tool, create_script_tool, store_secret, list_custom_tools. Do not write installer scripts.`,
      };
    };

    const conversation = query({
      prompt: promptForSdk,
      options: {
        systemPrompt,
        model: sdkModel as "sonnet" | "opus" | "haiku",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Explicit empty array → SDK passes `--setting-sources=` to the CLI,
        // which isolates the subprocess from ~/.claude/. Omitting the option
        // entirely lets the CLI fall back to its user-loading default.
        settingSources: [],
        // Restrict MCP servers to only what we pass via `mcpServers` below.
        // Without this, the CLI also loads claude.ai account-level connectors
        // (Gmail/Drive/Calendar/Notion/Canva). CarsonOS has its own google/
        // imap/caldav providers — those connectors are redundant.
        strictMcpConfig: true,
        maxTurns: params.maxTurns ?? MAX_TURNS,
        ...(params.cwd ? { cwd: params.cwd } : {}),
        canUseTool: canUseToolCallback,
        tools: params.builtinTools ?? [],
        allowedTools: allAllowedTools.length > 0 ? allAllowedTools : undefined,
        ...(mcpConfig ? { mcpServers: mcpConfig } : {}),
        // Enable streaming when a delta callback is provided
        ...(onTextDelta ? { includePartialMessages: true } : {}),
        // Resume existing session for conversation continuity
        ...(params.resumeSessionId ? { resume: params.resumeSessionId } : {}),
        // v0.4 cancel-actually-stops-compute: when the dispatcher aborts this
        // controller, the SDK terminates the CLI subprocess and the for-await
        // below throws. We catch, tag as aborted, and return an aborted result.
        ...(params.abortController ? { abortController: params.abortController } : {}),
        env,
      },
    });

    let hasStreamedText = false;
    let hitTurnLimit = false;
    let sdkErrorMessage: string | null = null;
    let initLogged = false;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;

    // Assign the refresh function now that `conversation` exists in scope.
    triggerRefresh = async (lastToolName: string) => {
      if (!params.refreshTools) return;
      try {
        const fresh = await params.refreshTools();
        const newSignature = computeToolSignature(fresh.tools);
        if (newSignature === currentToolSignature) {
          return;
        }
        // Rotate server name so the SDK disconnects the previous server cleanly
        // (avoids "Tool X is already registered" from overlapping tool names).
        currentMcpServerName = nextMcpServerName();
        const newServer = buildMcpServer(fresh.tools, fresh.toolExecutor);
        await conversation.setMcpServers({ [currentMcpServerName]: newServer });
        currentMcpToolNames = new Set(fresh.tools.map((t) => t.name));
        currentToolSignature = newSignature;
        console.log(`${tracePrefix} MCP tool list refreshed after ${lastToolName} (${fresh.tools.length} tools, server=${currentMcpServerName})`);
      } catch (err) {
        console.warn(`${tracePrefix} Failed to refresh MCP tools after ${lastToolName}:`, err);
      }
    };

    try {
      for await (const message of conversation) {
        // Capture session_id from any message that carries it
        if ("session_id" in message && typeof message.session_id === "string") {
          capturedSessionId = message.session_id;
        }

        if (!initLogged && message.type === "system" && "subtype" in message && message.subtype === "init") {
          const init = message as unknown as {
            tools?: string[];
            mcp_servers?: Array<{ name: string; status: string }>;
            skills?: string[];
            model?: string;
          };
          initLogged = true;
          console.log(
            `${tracePrefix} SDK init model=${init.model ?? "unknown"} tools=${init.tools?.length ?? 0} mcpServers=${(init.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`).join(",") || "none"} skills=${init.skills?.length ?? 0}`,
          );
        }

        // Stream text deltas to the caller as they arrive
        if (onTextDelta && message.type === "stream_event") {
          const event = (message as Record<string, unknown>).event as Record<string, unknown> | undefined;
          if (
            event?.type === "content_block_delta" &&
            (event?.delta as Record<string, unknown>)?.type === "text_delta"
          ) {
            firstDeltaMs ??= Date.now() - t0;
            onTextDelta((event.delta as { text: string }).text);
            hasStreamedText = true;
          }
        }

        // Inject paragraph break when a new assistant turn starts after a tool call
        // (prevents "Let me check.Here's what I found" with no space)
        if (message.type === "assistant" && hasStreamedText && onTextDelta) {
          onTextDelta("\n\n");
        }

        // Collect text content blocks from each assistant turn
        if (message.type === "assistant" && "message" in message) {
          const msgObj = message.message as { content?: unknown[] } | undefined;
          if (msgObj?.content && Array.isArray(msgObj.content)) {
            for (const block of msgObj.content) {
              if (
                block &&
                typeof block === "object" &&
                "type" in block &&
                (block as { type: unknown }).type === "text" &&
                "text" in block &&
                typeof (block as { text: unknown }).text === "string"
              ) {
                const txt = ((block as { text: string }).text).trim();
                if (txt) assistantTextBlocks.push(txt);
              }
            }
          }
        }

        if (message.type === "result") {
          if ("total_cost_usd" in message && typeof message.total_cost_usd === "number") {
            totalCost = message.total_cost_usd;
          }
          if ("num_turns" in message && typeof message.num_turns === "number") {
            numTurns = message.num_turns;
          }
          if ("usage" in message && message.usage && typeof message.usage === "object") {
            const usage = message.usage as { input_tokens?: number; output_tokens?: number };
            if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
            if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
          }
          if ("modelUsage" in message && message.modelUsage && typeof message.modelUsage === "object") {
            let inTotal = 0;
            let outTotal = 0;
            for (const usage of Object.values(message.modelUsage as Record<string, { inputTokens?: number; outputTokens?: number }>)) {
              inTotal += usage.inputTokens ?? 0;
              outTotal += usage.outputTokens ?? 0;
            }
            if (inTotal > 0) inputTokens = inTotal;
            if (outTotal > 0) outputTokens = outTotal;
          }

          if (message.subtype === "success") {
            const sdkResult = ("result" in message && typeof message.result === "string")
              ? message.result
              : "";
            resultText = assistantTextBlocks.length > 0
              ? assistantTextBlocks.join("\n\n")
              : sdkResult;
          } else {
            // SDK returned a final result with an error subtype (e.g., error_max_turns).
            const errors: string[] =
              "errors" in message && Array.isArray(message.errors)
                ? message.errors
                : [];
            const errorJoined = errors.join("; ");
            if (isTurnLimitError(errorJoined) || message.subtype === "error_max_turns") {
              hitTurnLimit = true;
            } else {
              sdkErrorMessage = errors.length > 0 ? errorJoined : "Something went wrong.";
            }
          }
        }
      }
    } catch (err) {
      // The SDK throws mid-iteration on some failures (including the turn limit
      // when no final result message is produced). Classify and convert to a
      // user-facing message instead of bubbling a raw stack trace.
      if (isTurnLimitError(err)) {
        hitTurnLimit = true;
      } else {
        sdkErrorMessage = err instanceof Error ? err.message : String(err);
        console.error(`${tracePrefix} SDK error:`, err);
      }
    }

    // If we never set resultText from a success path, synthesize one the user
    // can actually read. Prefer partial assistant text if we captured any
    // (better than a bare error — user sees what the agent was trying to say).
    if (!resultText) {
      if (hitTurnLimit) {
        const partial = assistantTextBlocks.join("\n\n").trim();
        const header = `(I got stuck after ${MAX_TURNS} turns. Try breaking the request into smaller steps, or tell me what to focus on first.)`;
        resultText = partial ? `${partial}\n\n${header}` : header;
      } else if (sdkErrorMessage) {
        resultText = `Error: ${sdkErrorMessage}`;
      }
    }

    const totalMs = Date.now() - t0;
    console.log(`${tracePrefix} Agent SDK: ${totalMs}ms, firstDelta=${firstDeltaMs ?? "none"}ms, ${numTurns} turns, ${allToolCalls.length} tool calls, inputTokens=${inputTokens ?? "unknown"}, outputTokens=${outputTokens ?? "unknown"}, resume=${isResume ? 'yes' : 'no'}, session=${capturedSessionId ?? 'none'}`);
    if (totalCost != null) {
      console.log(`${tracePrefix} Cost: $${totalCost.toFixed(4)}`);
    }

    return {
      content: resultText || "No response.",
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
      sessionId: capturedSessionId ?? undefined,
      metadata: {
        adapter: "claude-agent-sdk",
        model: sdkModel,
        turns: numTurns,
        costUsd: totalCost,
        durationMs: totalMs,
      },
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      execFileSync(WHICH_CMD, ["claude"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }
}

// -- Factory ---------------------------------------------------------

export function createAdapter(type: AdapterType): Adapter {
  switch (type) {
    case "claude-code":
      return new ClaudeCodeAdapter();
    case "codex":
      return new CodexAdapter();
    case "anthropic-sdk":
      return new ClaudeAgentSdkAdapter();
    default:
      throw new Error(`Unknown adapter type: ${type}`);
  }
}
