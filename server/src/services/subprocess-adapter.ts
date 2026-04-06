/**
 * Subprocess adapter -- pluggable LLM execution layer.
 *
 * Three adapters:
 *   1. ClaudeCodeAdapter  -- spawns the `claude` CLI binary
 *   2. CodexAdapter       -- spawns the `codex` CLI binary
 *   3. AnthropicSdkAdapter -- direct Anthropic SDK calls
 *
 * All implement the same Adapter interface so the engine
 * doesn't care which one is running underneath.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Anthropic from "@anthropic-ai/sdk";
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

// -- Claude Code adapter ---------------------------------------------

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
      "--allowed-tools", "none",          // No tools allowed — text responses only
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
        // Always try to parse JSON stdout first (Claude CLI returns JSON even on error)
        try {
          const parsed = JSON.parse(stdout);

          // Check if Claude returned an error in JSON
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
          // If JSON parsing fails, return raw stdout
          resolve({
            content: stdout.trim(),
            metadata: { adapter: "claude-code", rawOutput: true },
          });
        }
      });

      // Enforce timeout
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

    // Build the prompt combining system + user messages
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

      // Enforce timeout
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

// -- Anthropic SDK adapter -------------------------------------------

class AnthropicSdkAdapter implements Adapter {
  name = "anthropic-sdk";
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
    }
    return this.client;
  }

  async execute(params: AdapterExecuteParams): Promise<AdapterExecuteResult> {
    const { systemPrompt, messages, maxTokens } = params;
    const anthropic = this.getClient();

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens ?? 2048,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });

    const content = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      content,
      metadata: {
        adapter: "anthropic-sdk",
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  async healthCheck(): Promise<boolean> {
    return !!process.env.ANTHROPIC_API_KEY;
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
      return new AnthropicSdkAdapter();
    default:
      throw new Error(`Unknown adapter type: ${type}`);
  }
}
