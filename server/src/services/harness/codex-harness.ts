/**
 * CodexHarness — runs an agent turn through the user's ChatGPT subscription via
 * the local `codex` CLI (no OPENAI_API_KEY), behind the {@link AgentHarness}
 * interface. Spawns `codex exec --json`, normalizes its event stream to
 * {@link HarnessEvent}s, and owns thread resume + abort.
 *
 * Security: spawns with `--sandbox read-only` + shell/browser/computer tools
 * disabled, and NEVER `--dangerously-bypass-approvals-and-sandbox`. Only the
 * CarsonOS MCP server's tools are auto-approved (via the per-conversation
 * config.toml written by the auth bridge). See memory/project_v060_harness.
 *
 * Streaming note: Codex emits complete `agent_message` items (no character
 * deltas), so text arrives as one `text_delta` per message. `session_id`
 * (the thread_id) is emitted only on a successful turn, so an aborted/killed
 * turn never persists a resume token.
 */

import { spawn as nodeSpawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import type { HarnessEvent, HarnessTurnParams, MediaAttachment } from "@carsonos/shared";
import type { AgentHarness, HarnessCapabilities } from "./types.js";
import { CodexEventMapper } from "./codex-json.js";
import { prepareCodexHome, codexAuthHealthy } from "./codex-auth-bridge.js";
import type { CodexToolRegistry } from "./codex-tool-registry.js";

type SpawnFn = typeof nodeSpawn;

const CODEX_BIN = process.platform === "win32" ? "codex.cmd" : "codex";
const KILL_GRACE_MS = 5_000;
const MCP_TOKEN_ENV = "CARSONOS_MCP_TOKEN";
// Watchdog ceiling for a single Codex turn. Generous because high-reasoning +
// multiple tool calls can be slow, but bounded so a hung subprocess can't wedge
// the conversation forever (the engine has no abort plumbing for Codex).
const TURN_TIMEOUT_MS = 300_000;

export interface CodexHarnessOptions {
  /** CarsonOS data dir root (e.g. ~/.carsonos). */
  dataDir: string;
  /** Per-turn tool registry backing the loopback MCP server. When provided
   * (with mcpUrl), a turn's tools are exposed to codex over HTTP MCP; without
   * it, a Codex agent runs text+image only. */
  toolRegistry?: CodexToolRegistry;
  /** Loopback MCP endpoint URL, e.g. http://127.0.0.1:3300/internal/codex-mcp. */
  mcpUrl?: string;
  /** Test seam: inject a fake spawn. */
  spawn?: SpawnFn;
  /** Override the codex binary name/path. */
  codexBin?: string;
  /** Test seam: override the master `~/.codex/auth.json` path. */
  masterAuthPath?: string;
}

export class CodexHarness implements AgentHarness {
  readonly id = "codex";
  readonly capabilities: HarnessCapabilities = {
    supportsImages: true,
    supportsMcp: true,
    refreshTier: "per-turn",
    reasoningLevels: ["low", "medium", "high"],
    resumeKind: "thread_id",
  };

  private readonly spawnFn: SpawnFn;
  private readonly codexBin: string;

  constructor(private readonly opts: CodexHarnessOptions) {
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.codexBin = opts.codexBin ?? CODEX_BIN;
  }

  streamTurn(params: HarnessTurnParams, signal: AbortSignal): AsyncIterable<HarnessEvent> {
    const self = this;
    return (async function* (): AsyncGenerator<HarnessEvent> {
      const conversationId = params.conversationId ?? "default";
      const model = stripFamily(params.model);

      // 0. Expose this turn's system tools over the loopback MCP server (if a
      //    registry + URL are wired and the turn has tools). The bearer token
      //    scopes codex to exactly this turn's tools; tools run in this (main)
      //    process, so the read-only codex sandbox never touches them.
      const registry = self.opts.toolRegistry;
      let mcpToken: string | undefined;
      let mcpServer: { url: string; bearerTokenEnvVar: string; tools: string[] } | undefined;
      if (registry && self.opts.mcpUrl && params.toolExecutor && params.tools?.length) {
        mcpToken = registry.register(params.tools, params.toolExecutor);
        mcpServer = {
          url: self.opts.mcpUrl,
          bearerTokenEnvVar: MCP_TOKEN_ENV,
          tools: params.tools.map((t) => t.name),
        };
      }
      const releaseTurn = () => {
        if (mcpToken) {
          registry?.unregister(mcpToken);
          mcpToken = undefined;
        }
      };

      // 1. Prepare the per-conversation CODEX_HOME (auth mirror + config.toml).
      let codexHome: string;
      let clearEnv: string[];
      try {
        const prep = await prepareCodexHome({
          conversationId,
          dataDir: self.opts.dataDir,
          ...(model ? { model } : {}),
          ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
          ...(mcpServer ? { mcpServer } : {}),
          ...(self.opts.masterAuthPath ? { masterAuthPath: self.opts.masterAuthPath } : {}),
        });
        codexHome = prep.codexHome;
        clearEnv = prep.clearEnv;
      } catch (err) {
        releaseTurn();
        yield {
          type: "error",
          recoverable: false,
          error: `Codex auth unavailable — run \`codex login\`. (${errMsg(err)})`,
        };
        return;
      }

      // 2-4. Instructions file, image files, and spawn — guarded so a failure
      //       (disk full, EACCES, missing binary) releases the per-turn MCP
      //       token and surfaces a terminal error instead of throwing out of
      //       the generator (the AgentHarness contract: streamTurn never throws).
      let child: ReturnType<SpawnFn>;
      try {
        // Per-turn nonce so concurrent turns on the same conversation (e.g. a
        // scheduled task firing mid-chat — both share this CODEX_HOME) can't
        // read each other's half-written instructions or overwrite images.
        const turnNonce = crypto.randomBytes(6).toString("hex");
        const instructionsPath = path.join(codexHome, `instructions-${turnNonce}.md`);
        await fs.writeFile(instructionsPath, params.systemPrompt, { mode: 0o600 });
        const imagePaths = await writeImages(codexHome, params.attachments, turnNonce);

        // sandbox_mode = "read-only" comes from config.toml (auth bridge), NOT a
        // --sandbox CLI flag: `codex exec` accepts --sandbox but `codex exec
        // resume` does not, so a CLI flag breaks the resume path. --disable, -c,
        // --image, --json, --skip-git-repo-check work on both.
        const opts = [
          "--json",
          "--skip-git-repo-check",
          "--disable",
          "shell_tool",
          "--disable",
          "browser_use",
          "--disable",
          "computer_use",
          "-c",
          `model_instructions_file=${JSON.stringify(instructionsPath)}`,
          ...imagePaths.flatMap((p) => ["--image", p]),
        ];
        const prompt = renderPrompt(params);
        const args = params.resumeSessionId
          ? ["exec", "resume", params.resumeSessionId, ...opts, prompt]
          : ["exec", ...opts, prompt];

        // Spawn detached (own process group) so abort/timeout can kill codex +
        // its MCP grandchildren together.
        child = self.spawnFn(self.codexBin, args, {
          cwd: codexHome,
          env: childEnv(codexHome, clearEnv, mcpToken),
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        releaseTurn();
        yield { type: "error", recoverable: false, error: `Failed to start Codex: ${errMsg(err)}` };
        return;
      }

      let aborted = signal.aborted;
      const onAbort = () => {
        aborted = true;
        killTree(child.pid);
      };
      if (signal.aborted) killTree(child.pid);
      else signal.addEventListener("abort", onAbort, { once: true });

      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      let closed = false;
      const exited = new Promise<number | null>((resolve) => {
        child.on("close", (code) => {
          closed = true;
          resolve(code);
        });
        child.on("error", () => {
          closed = true;
          resolve(null);
        });
      });

      // Watchdog: codex turns have no engine-side abort (processMessage passes a
      // never-aborted signal), so without this a hung subprocess (stuck on the
      // network, or stdout open but idle) blocks the conversation forever.
      // Killing the process group closes stdout, which ends the readline loop.
      let timedOut = false;
      const watchdog = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, TURN_TIMEOUT_MS);
      watchdog.unref?.();

      // 5. Stream stdout: each JSON line maps to zero+ HarnessEvents.
      const mapper = new CodexEventMapper();
      try {
        if (child.stdout) {
          const rl = createInterface({ input: child.stdout });
          for await (const line of rl) {
            for (const ev of mapper.handleLine(line)) yield ev;
          }
        }
        const code = await exited;

        // 6. Terminal event.
        if (timedOut) {
          yield {
            type: "error",
            recoverable: false,
            error: `Codex timed out after ${Math.round(TURN_TIMEOUT_MS / 1000)}s`,
          };
        } else if (aborted) {
          yield { type: "error", recoverable: true, error: "aborted" };
        } else if (code === 0 && mapper.sawTurnCompleted) {
          if (mapper.capturedThreadId) {
            yield { type: "session_id", harness: "codex", id: mapper.capturedThreadId };
          }
          yield { type: "done", content: mapper.content };
        } else {
          yield {
            type: "error",
            recoverable: false,
            error: stderr.trim() || `codex exited with code ${code ?? "unknown"}`,
          };
        }
      } finally {
        clearTimeout(watchdog);
        releaseTurn();
        signal.removeEventListener("abort", onAbort);
        // Only kill if still running. After a clean close the pid is reaped, and
        // signalling it could hit a recycled process group.
        if (!closed) killTree(child.pid);
      }
    })();
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    return codexAuthHealthy(this.opts.masterAuthPath);
  }
}

// -- helpers ----------------------------------------------------------

/** "codex/gpt-5.4" -> "gpt-5.4"; "gpt-5.4" -> "gpt-5.4"; undefined -> undefined. */
function stripFamily(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const i = model.indexOf("/");
  return i >= 0 ? model.slice(i + 1) : model;
}

/** Render the message array into a single prompt string for `codex exec`. */
function renderPrompt(params: HarnessTurnParams): string {
  const msgs = params.messages;
  if (msgs.length === 1) return msgs[0].content;
  return msgs
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

async function writeImages(
  codexHome: string,
  attachments: MediaAttachment[] | undefined,
  nonce: string,
): Promise<string[]> {
  if (!attachments?.length) return [];
  const paths: string[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i];
    const ext = (a.mediaType.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "");
    const p = path.join(codexHome, `attachment-${nonce}-${i}.${ext}`);
    await fs.writeFile(p, Buffer.from(a.base64, "base64"), { mode: 0o600 });
    paths.push(p);
  }
  return paths;
}

function childEnv(
  codexHome: string,
  clearEnv: string[],
  mcpToken: string | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
  if (mcpToken) env[MCP_TOKEN_ENV] = mcpToken;
  for (const key of clearEnv) delete env[key];
  return env;
}

/** Kill the whole process group (codex + MCP grandchildren); SIGKILL after grace. */
function killTree(pid: number | undefined): void {
  if (pid == null) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return; // already gone / not a group leader
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }, KILL_GRACE_MS).unref();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
