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

    const args = [
      "--output-format", "json",
      "--max-turns", "3",
      "--allowed-tools", "none",
      "--system-prompt-file", promptFile,
      "-p", userMessage,
    ];

    if (maxTokens) {
      args.push("--max-tokens", String(maxTokens));
    }

    return new Promise<AdapterExecuteResult>((resolve, reject) => {
      const child = spawn("claude", args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: TIMEOUT_MS,
        cwd: this.getCleanDir(),
      });

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
      execFileSync("which", ["claude"], { stdio: "pipe" });
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

    const args = ["exec", fullPrompt];

    return new Promise<AdapterExecuteResult>((resolve, reject) => {
      const child = spawn("codex", args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: TIMEOUT_MS,
      });

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
      execFileSync("which", ["codex"], { stdio: "pipe" });
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

class ClaudeAgentSdkAdapter implements Adapter {
  name = "claude-agent-sdk";

  async execute(params: AdapterExecuteParams): Promise<AdapterExecuteResult> {
    const { systemPrompt, messages, tools, toolExecutor, model } = params;

    // Build the user prompt from the messages array
    const userPrompt = messages
      .map((m) => (m.role === "user" ? m.content : `[assistant]: ${m.content}`))
      .join("\n\n");

    // Build MCP server with memory tools if tools + executor provided
    let mcpConfig: Record<string, ReturnType<typeof createSdkMcpServer>> | undefined;
    const allowedTools: string[] = [];
    const allToolCalls: Array<{ name: string; input: Record<string, unknown>; result: { content: string; is_error?: boolean } }> = [];

    const MCP_SERVER_NAME = "carsonos-memory";

    // Forward-declared so the tool() callback can call it after a successful
    // tool-list-modifying tool returns. Assigned below once conversation exists.
    let triggerRefresh: (toolName: string) => Promise<void> = async () => {};

    /**
     * Build an MCP server config from a tool list + executor. Extracted so
     * we can rebuild it mid-session when custom tools are created/updated
     * via setMcpServers (see triggerRefresh handling below).
     */
    const buildMcpServer = (
      toolDefs: import("@carsonos/shared").ToolDefinition[],
      executor: import("@carsonos/shared").ToolExecutor,
    ) => {
      const mcpTools = toolDefs.map((t) => {
        const properties = (t.input_schema.properties ?? {}) as Record<string, { type: string; description?: string; enum?: string[] }>;
        const required = (t.input_schema.required ?? []) as string[];
        const shape: Record<string, z.ZodTypeAny> = {};

        for (const [key, prop] of Object.entries(properties)) {
          let fieldSchema: z.ZodTypeAny;
          if (prop.enum) {
            fieldSchema = z.enum(prop.enum as [string, ...string[]]);
          } else if (prop.type === "object") {
            fieldSchema = z.record(z.string(), z.unknown());
          } else {
            fieldSchema = z.string();
          }
          if (prop.description) fieldSchema = fieldSchema.describe(prop.description);
          if (!required.includes(key)) fieldSchema = fieldSchema.optional();
          shape[key] = fieldSchema;
        }

        return tool(
          t.name,
          t.description,
          shape,
          async (input: Record<string, unknown>) => {
            const result = await executor(t.name, input);
            allToolCalls.push({ name: t.name, input, result });
            // Fire mid-session MCP refresh if this was a tool-list-modifying
            // success. Swap happens after we return this result to the SDK
            // so there's no race with the current call.
            if (!result.is_error && TOOL_LIST_MODIFYING.has(t.name)) {
              // Fire and forget — the MCP swap runs async so we don't block
              // returning this tool's result to the SDK.
              void triggerRefresh(t.name);
            }
            return {
              content: [{ type: "text" as const, text: result.content }],
              isError: result.is_error,
            };
          },
        );
      });

      return createSdkMcpServer({
        name: MCP_SERVER_NAME,
        version: "1.0.0",
        tools: mcpTools,
      });
    };

    if (tools && tools.length > 0 && toolExecutor) {
      const mcpServer = buildMcpServer(tools, toolExecutor);
      mcpConfig = { [MCP_SERVER_NAME]: mcpServer };
      for (const t of tools) {
        allowedTools.push(`mcp__${MCP_SERVER_NAME}__${t.name}`);
      }
    }

    // Track the current tool set for change detection during for-await
    let currentToolNames = new Set((tools ?? []).map((t) => t.name));

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

    // Build the full allowed tools list: MCP tools
    // (Skills are enabled via "Skill" in the tools array + settingSources: ["user"],
    // not via allowedTools — the SDK picks them up from ~/.claude/skills/ automatically)
    const allAllowedTools = [...allowedTools];

    const onTextDelta = params.onTextDelta;

    const isResume = !!params.resumeSessionId;

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
      // MCP tools (our memory/scheduling/agent/custom-tools modules) are our own surface
      if (toolName.startsWith("mcp__")) return { behavior: "allow", updatedInput: input };
      // Claude Code built-ins: only allow if granted by trust level
      if (grantedBuiltins.has(toolName)) return { behavior: "allow", updatedInput: input };
      // Anything else: deny with a pointer to the right approach
      return {
        behavior: "deny",
        message: `'${toolName}' is not available at this agent's trust level. To build a tool, call one of: create_http_tool, create_prompt_tool, create_script_tool, store_secret, list_custom_tools. Do not write installer scripts.`,
      };
    };

    const conversation = query({
      prompt: userPrompt,
      options: {
        systemPrompt,
        model: sdkModel as "sonnet" | "opus" | "haiku",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["user"],
        maxTurns: MAX_TURNS,
        canUseTool: canUseToolCallback,
        tools: params.builtinTools ?? [],
        allowedTools: allAllowedTools.length > 0 ? allAllowedTools : undefined,
        ...(mcpConfig ? { mcpServers: mcpConfig } : {}),
        // Enable streaming when a delta callback is provided
        ...(onTextDelta ? { includePartialMessages: true } : {}),
        // Resume existing session for conversation continuity
        ...(params.resumeSessionId ? { resume: params.resumeSessionId } : {}),
        env,
      },
    });

    let hasStreamedText = false;
    let hitTurnLimit = false;
    let sdkErrorMessage: string | null = null;

    // Assign the refresh function now that `conversation` exists in scope.
    triggerRefresh = async (lastToolName: string) => {
      if (!params.refreshTools) return;
      try {
        const fresh = await params.refreshTools();
        const newNames = new Set<string>(fresh.tools.map((t: { name: string }) => t.name));
        // Skip if nothing actually changed (e.g. an update that didn't change
        // the tool's name and didn't add/remove anything).
        if (
          newNames.size === currentToolNames.size &&
          [...newNames].every((n: string) => currentToolNames.has(n))
        ) {
          return;
        }
        const newServer = buildMcpServer(fresh.tools, fresh.toolExecutor);
        await conversation.setMcpServers({ [MCP_SERVER_NAME]: newServer });
        currentToolNames = newNames;
        console.log(`[adapter] MCP tool list refreshed after ${lastToolName} (${fresh.tools.length} tools)`);
      } catch (err) {
        console.warn(`[adapter] Failed to refresh MCP tools after ${lastToolName}:`, err);
      }
    };

    try {
      for await (const message of conversation) {
        // Capture session_id from any message that carries it
        if ("session_id" in message && typeof message.session_id === "string") {
          capturedSessionId = message.session_id;
        }

        // Stream text deltas to the caller as they arrive
        if (onTextDelta && message.type === "stream_event") {
          const event = (message as Record<string, unknown>).event as Record<string, unknown> | undefined;
          if (
            event?.type === "content_block_delta" &&
            (event?.delta as Record<string, unknown>)?.type === "text_delta"
          ) {
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
        console.error("[adapter] SDK error:", err);
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
    console.log(`[adapter] Agent SDK: ${totalMs}ms, ${numTurns} turns, ${allToolCalls.length} tool calls, resume=${isResume ? 'yes' : 'no'}, session=${capturedSessionId ?? 'none'}`);
    if (totalCost != null) {
      console.log(`[adapter] Cost: $${totalCost.toFixed(4)}`);
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
      execFileSync("which", ["claude"], { stdio: "pipe" });
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
