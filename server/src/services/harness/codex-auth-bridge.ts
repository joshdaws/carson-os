/**
 * Per-conversation CODEX_HOME bridge.
 *
 * The Codex path authenticates with the user's ChatGPT subscription via the
 * `codex` CLI — never an OPENAI_API_KEY. `codex login` populates the master
 * `~/.codex/auth.json`; this bridge mirrors it into an isolated per-conversation
 * CODEX_HOME (so two family members' Codex sessions never share tool/session
 * state — the same isolation class as the v0.5.7 tool-cache fix) and writes a
 * locked-down `config.toml`.
 *
 * Security posture (verified by the 0.130.0 spike, see memory/project_v060_harness):
 *   - `sandbox_mode = "read-only"` → the model's apply_patch/file_change and
 *     shell cannot write anything.
 *   - shell/browser/computer tools are also disabled at spawn (defense in depth).
 *   - Only the CarsonOS MCP server's tools are auto-approved (`approval_mode =
 *     "approve"`), so they run non-interactively WITHOUT the dangerous
 *     `--dangerously-bypass-approvals-and-sandbox` flag.
 *   - `OPENAI_API_KEY` is cleared from the child env.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/** Env key(s) stripped from the Codex child so it can only use ChatGPT auth. */
export const CODEX_CLEAR_ENV = ["OPENAI_API_KEY"] as const;

function masterAuthPath(): string {
  return path.join(os.homedir(), ".codex", "auth.json");
}

/**
 * The CarsonOS system-tools MCP server, exposed as a loopback streamable-HTTP
 * endpoint by the main process (no subprocess → not subject to codex's
 * sandbox; tools execute in the unjailed main process). Codex connects with a
 * per-turn bearer token read from `bearerTokenEnvVar`.
 */
export interface CarsonosMcpServer {
  /** Loopback MCP URL, e.g. http://127.0.0.1:3300/internal/codex-mcp. */
  url: string;
  /** Env var name codex reads the per-turn bearer token from. */
  bearerTokenEnvVar: string;
  /** Tool names to auto-approve (`approval_mode = "approve"`). */
  tools: string[];
}

export interface PrepareCodexHomeOptions {
  conversationId: string;
  /** CarsonOS data dir root (e.g. ~/.carsonos). */
  dataDir: string;
  /** Concrete Codex model id, e.g. "gpt-5.4". */
  model?: string;
  /** Reasoning effort: low | medium | high. */
  reasoningEffort?: string;
  /** CarsonOS system-tools MCP server. Omitted until tool migration lands —
   * a Codex agent then runs text+image only. */
  mcpServer?: CarsonosMcpServer;
  /** Test override for the master auth file location. */
  masterAuthPath?: string;
}

export interface PreparedCodexHome {
  codexHome: string;
  /** Env keys the caller must delete from the child process env. */
  clearEnv: string[];
}

/** Deterministic per-conversation CODEX_HOME path. */
export function codexHomeFor(dataDir: string, conversationId: string): string {
  const digest = crypto.createHash("sha256").update(conversationId).digest("hex").slice(0, 16);
  return path.join(dataDir, "codex", digest);
}

/**
 * Mirror the master auth into a per-conversation CODEX_HOME and write the
 * locked-down config.toml. Re-reads the master on every turn (cheap) so codex's
 * own token refresh of the master file propagates. Throws if the master auth is
 * missing or unparseable (caller surfaces a "run `codex login`" message).
 */
export async function prepareCodexHome(
  opts: PrepareCodexHomeOptions,
): Promise<PreparedCodexHome> {
  const master = opts.masterAuthPath ?? masterAuthPath();
  const raw = await fs.readFile(master, "utf8");
  JSON.parse(raw); // validate — surfaces torn/garbage reads before we spawn codex

  const codexHome = codexHomeFor(opts.dataDir, opts.conversationId);
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  await atomicWrite(path.join(codexHome, "auth.json"), raw, 0o600);
  await atomicWrite(path.join(codexHome, "config.toml"), buildConfigToml(opts), 0o600);

  return { codexHome, clearEnv: [...CODEX_CLEAR_ENV] };
}

/** Build the locked-down config.toml for a per-conversation CODEX_HOME. */
export function buildConfigToml(opts: PrepareCodexHomeOptions): string {
  const lines = [`sandbox_mode = "read-only"`, `approval_policy = "on-request"`];
  if (opts.model) lines.push(`model = ${JSON.stringify(opts.model)}`);
  if (opts.reasoningEffort) {
    lines.push(`model_reasoning_effort = ${JSON.stringify(opts.reasoningEffort)}`);
  }
  if (opts.mcpServer) {
    lines.push("", "[mcp_servers.carsonos]");
    lines.push(`url = ${JSON.stringify(opts.mcpServer.url)}`);
    lines.push(`bearer_token_env_var = ${JSON.stringify(opts.mcpServer.bearerTokenEnvVar)}`);
    for (const tool of opts.mcpServer.tools) {
      lines.push("", `[mcp_servers.carsonos.tools.${tool}]`, `approval_mode = "approve"`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Whether the master ChatGPT auth is present and usable. */
export async function codexAuthHealthy(
  master: string = masterAuthPath(),
): Promise<{ healthy: boolean; reason?: string }> {
  let raw: string;
  try {
    raw = await fs.readFile(master, "utf8");
  } catch {
    return { healthy: false, reason: "no chatgpt auth — run `codex login`" };
  }
  try {
    const parsed = JSON.parse(raw) as { auth_mode?: string; tokens?: { access_token?: string } };
    if (parsed.auth_mode !== "chatgpt" && !parsed.tokens?.access_token) {
      return { healthy: false, reason: "codex auth.json missing chatgpt tokens" };
    }
    return { healthy: true };
  } catch {
    return { healthy: false, reason: "codex auth.json is malformed" };
  }
}

async function atomicWrite(filePath: string, content: string, mode: number): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, { mode });
  await fs.rename(tmp, filePath);
}
