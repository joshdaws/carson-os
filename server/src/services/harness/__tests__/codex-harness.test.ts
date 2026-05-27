/**
 * Tests for CodexHarness using a hermetic fake `spawn` (no real codex binary,
 * no real process signals — the fake child's pid is undefined so killTree is a
 * no-op) and a fake master auth file in a tmp dir.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HarnessEvent, HarnessTurnParams } from "@carsonos/shared";
import { CodexHarness } from "../codex-harness.js";
import { codexHomeFor } from "../codex-auth-bridge.js";
import { CodexToolRegistry } from "../codex-tool-registry.js";
import { promises as fsp } from "node:fs";

const SPIKE_LINES = [
  `{"type":"thread.started","thread_id":"019e5af2-fb3a-7d61-81be-65fd34f323db"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"spike_echo","tool":"spike_echo","arguments":{"message":"hi"},"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"spike_echo","tool":"spike_echo","arguments":{"message":"hi"},"result":{"content":[{"type":"text","text":"ECHO: hi"}]},"status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"DONE"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":51227,"output_tokens":169}}`,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeSpawn(lines: string[], opts: { code?: number | null; stderr?: string } = {}) {
  const captured: { bin?: string; args?: string[]; env?: NodeJS.ProcessEnv } = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = ((bin: string, args: string[], spawnOpts?: { env?: NodeJS.ProcessEnv }) => {
    captured.bin = bin;
    captured.args = args;
    captured.env = spawnOpts?.env;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const child: any = new EventEmitter();
    child.pid = undefined; // killTree() is a no-op — never signals a real pgroup
    child.stdout = Readable.from(lines.map((l) => l + "\n"));
    child.stderr = new EventEmitter();
    child.kill = () => true;
    child.stdout.on("end", () => {
      if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
      setImmediate(() => child.emit("close", opts.code ?? 0));
    });
    return child;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return { fn, captured };
}

const AUTH = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "tok" } });
const baseParams: HarnessTurnParams = {
  systemPrompt: "you are carson",
  messages: [{ role: "user", content: "hi" }],
  model: "codex/gpt-5.4",
  conversationId: "conv-1",
};

let dir: string;
let dataDir: string;
let masterAuth: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "carsonos-codex-harness-"));
  dataDir = join(dir, "data");
  masterAuth = join(dir, "auth.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function collect(stream: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("CodexHarness", () => {
  it("streams a successful turn; session_id (thread) is emitted right before done", async () => {
    await fs.writeFile(masterAuth, AUTH);
    const { fn } = fakeSpawn(SPIKE_LINES);
    const h = new CodexHarness({ dataDir, masterAuthPath: masterAuth, spawn: fn });

    const events = await collect(h.streamTurn(baseParams, new AbortController().signal));
    expect(events).toEqual<HarnessEvent[]>([
      { type: "tool_use_start", name: "spike_echo", input: { message: "hi" }, id: "item_1" },
      { type: "tool_use_end", name: "spike_echo", result: "ECHO: hi", isError: false, id: "item_1" },
      { type: "text_delta", text: "DONE" },
      { type: "usage", inputTokens: 51227, outputTokens: 169 },
      { type: "session_id", harness: "codex", id: "019e5af2-fb3a-7d61-81be-65fd34f323db" },
      { type: "done", content: "DONE" },
    ]);
  });

  it("mirrors auth + writes a locked-down config + instructions into per-conversation CODEX_HOME", async () => {
    await fs.writeFile(masterAuth, AUTH);
    const { fn } = fakeSpawn(SPIKE_LINES);
    const h = new CodexHarness({ dataDir, masterAuthPath: masterAuth, spawn: fn });
    await collect(h.streamTurn(baseParams, new AbortController().signal));

    const home = codexHomeFor(dataDir, "conv-1");
    expect(await fs.readFile(join(home, "auth.json"), "utf8")).toBe(AUTH);
    // Instructions are written to a per-turn nonce file (concurrency-safe).
    const files = await fsp.readdir(home);
    const instrFile = files.find((f) => /^instructions-[0-9a-f]+\.md$/.test(f));
    expect(instrFile).toBeTruthy();
    expect(await fs.readFile(join(home, instrFile!), "utf8")).toBe("you are carson");
    const config = await fs.readFile(join(home, "config.toml"), "utf8");
    expect(config).toContain(`sandbox_mode = "read-only"`);
    expect(config).toContain(`model = "gpt-5.4"`); // codex/ prefix stripped
  });

  it("spawns with the safe flags and never the bypass flag; resume uses the thread", async () => {
    await fs.writeFile(masterAuth, AUTH);
    const { fn, captured } = fakeSpawn(SPIKE_LINES);
    const h = new CodexHarness({ dataDir, masterAuthPath: masterAuth, spawn: fn });
    await collect(h.streamTurn({ ...baseParams, resumeSessionId: "thread-1" }, new AbortController().signal));

    const args = captured.args!;
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "thread-1"]);
    expect(args).toContain("shell_tool");
    // sandbox is config-driven (sandbox_mode in config.toml), NOT a CLI flag —
    // `codex exec resume` rejects --sandbox, so it must never appear.
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("returns a non-recoverable error (and never spawns) when auth is missing", async () => {
    let spawned = false;
    const { fn } = fakeSpawn(SPIKE_LINES);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = ((...a: unknown[]) => {
      spawned = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (fn as any)(...a);
    }) as never;
    const h = new CodexHarness({ dataDir, masterAuthPath: join(dir, "nope.json"), spawn: spy });

    const events = await collect(h.streamTurn(baseParams, new AbortController().signal));
    expect(spawned).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", recoverable: false });
    expect((events[0] as { error: string }).error).toMatch(/codex login/);
  });

  it("maps a nonzero exit to a non-recoverable error carrying stderr", async () => {
    await fs.writeFile(masterAuth, AUTH);
    const { fn } = fakeSpawn([], { code: 1, stderr: "codex boom" });
    const h = new CodexHarness({ dataDir, masterAuthPath: masterAuth, spawn: fn });
    const events = await collect(h.streamTurn(baseParams, new AbortController().signal));
    expect(events).toEqual<HarnessEvent[]>([{ type: "error", recoverable: false, error: "codex boom" }]);
  });

  it("registers the turn's tools, wires the MCP token + config, and unregisters after", async () => {
    await fs.writeFile(masterAuth, AUTH);
    const registry = new CodexToolRegistry();
    const { fn, captured } = fakeSpawn(SPIKE_LINES);
    const h = new CodexHarness({
      dataDir,
      masterAuthPath: masterAuth,
      spawn: fn,
      toolRegistry: registry,
      mcpUrl: "http://127.0.0.1:3300/internal/codex-mcp",
    });

    await collect(
      h.streamTurn(
        {
          ...baseParams,
          tools: [{ name: "search_memory", description: "d", input_schema: {} }],
          toolExecutor: async () => ({ content: "ok" }),
        },
        new AbortController().signal,
      ),
    );

    // Token was minted, passed to the codex child, and written into config.toml...
    const token = captured.env?.CARSONOS_MCP_TOKEN;
    expect(token).toBeTruthy();
    const config = await fsp.readFile(join(codexHomeFor(dataDir, "conv-1"), "config.toml"), "utf8");
    expect(config).toContain("[mcp_servers.carsonos]");
    expect(config).toContain(`url = "http://127.0.0.1:3300/internal/codex-mcp"`);
    expect(config).toContain(`bearer_token_env_var = "CARSONOS_MCP_TOKEN"`);
    expect(config).toContain("[mcp_servers.carsonos.tools.search_memory]");
    // ...and released when the turn ended (no leak).
    expect(registry.size).toBe(0);
  });

  it("releases the MCP token and yields a terminal error (never throws) when spawn fails", async () => {
    await fs.writeFile(masterAuth, AUTH);
    const registry = new CodexToolRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const throwingSpawn = (() => {
      throw new Error("spawn codex ENOENT");
    }) as any;
    const h = new CodexHarness({
      dataDir,
      masterAuthPath: masterAuth,
      spawn: throwingSpawn,
      toolRegistry: registry,
      mcpUrl: "http://127.0.0.1:3300/internal/codex-mcp",
    });

    const events = await collect(
      h.streamTurn(
        {
          ...baseParams,
          tools: [{ name: "search_memory", description: "d", input_schema: {} }],
          toolExecutor: async () => ({ content: "ok" }),
        },
        new AbortController().signal,
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", recoverable: false });
    // The per-turn token must be released even though spawn threw — no leak.
    expect(registry.size).toBe(0);
  });

  it("emits a recoverable 'aborted' error and no done when the signal is aborted", async () => {
    await fs.writeFile(masterAuth, AUTH);
    const { fn } = fakeSpawn(SPIKE_LINES, { code: null });
    const h = new CodexHarness({ dataDir, masterAuthPath: masterAuth, spawn: fn });
    const ac = new AbortController();
    ac.abort();
    const events = await collect(h.streamTurn(baseParams, ac.signal));
    expect(events.at(-1)).toEqual({ type: "error", recoverable: true, error: "aborted" });
    expect(events.some((e) => e.type === "done")).toBe(false);
  });
});
