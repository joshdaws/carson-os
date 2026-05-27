/**
 * Tests for the Codex auth bridge: per-conversation CODEX_HOME mirroring of the
 * master auth, the locked-down config.toml, and health checks. File ops run
 * against a tmp dataDir and a fake master auth file.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  prepareCodexHome,
  codexHomeFor,
  buildConfigToml,
  codexAuthHealthy,
  CODEX_CLEAR_ENV,
} from "../codex-auth-bridge.js";

const AUTH = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { access_token: "tok-abc", refresh_token: "ref-xyz", account_id: "acct-1" },
});

let dir: string;
let dataDir: string;
let masterAuth: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "carsonos-codex-bridge-"));
  dataDir = join(dir, "data");
  masterAuth = join(dir, "master-auth.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("codexHomeFor", () => {
  it("is deterministic per conversation and isolates different conversations", () => {
    const a = codexHomeFor(dataDir, "conv-1");
    const b = codexHomeFor(dataDir, "conv-1");
    const c = codexHomeFor(dataDir, "conv-2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith(join(dataDir, "codex"))).toBe(true);
  });
});

describe("prepareCodexHome", () => {
  it("mirrors the master auth and writes a locked-down config.toml", async () => {
    await fs.writeFile(masterAuth, AUTH);
    const { codexHome, clearEnv } = await prepareCodexHome({
      conversationId: "conv-1",
      dataDir,
      model: "gpt-5.4",
      reasoningEffort: "high",
      masterAuthPath: masterAuth,
    });

    expect(await fs.readFile(join(codexHome, "auth.json"), "utf8")).toBe(AUTH);
    const config = await fs.readFile(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain(`sandbox_mode = "read-only"`);
    expect(config).toContain(`model = "gpt-5.4"`);
    expect(config).toContain(`model_reasoning_effort = "high"`);
    expect(clearEnv).toEqual([...CODEX_CLEAR_ENV]);
    expect(clearEnv).toContain("OPENAI_API_KEY");
  });

  it("throws when the master auth is missing (so caller can prompt `codex login`)", async () => {
    await expect(
      prepareCodexHome({ conversationId: "c", dataDir, masterAuthPath: masterAuth }),
    ).rejects.toThrow();
  });

  it("re-reads the master each call (token refresh propagates)", async () => {
    await fs.writeFile(masterAuth, AUTH);
    const { codexHome } = await prepareCodexHome({ conversationId: "c", dataDir, masterAuthPath: masterAuth });
    const rotated = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "tok-NEW" } });
    await fs.writeFile(masterAuth, rotated);
    await prepareCodexHome({ conversationId: "c", dataDir, masterAuthPath: masterAuth });
    expect(await fs.readFile(join(codexHome, "auth.json"), "utf8")).toBe(rotated);
  });
});

describe("buildConfigToml", () => {
  it("auto-approves only the CarsonOS MCP server's tools and keeps read-only sandbox", () => {
    const toml = buildConfigToml({
      conversationId: "c",
      dataDir,
      mcpServer: {
        url: "http://127.0.0.1:3300/internal/codex-mcp",
        bearerTokenEnvVar: "CARSONOS_MCP_TOKEN",
        tools: ["search_memory", "send_telegram"],
      },
    });
    expect(toml).toContain(`sandbox_mode = "read-only"`);
    expect(toml).toContain("[mcp_servers.carsonos]");
    expect(toml).toContain(`url = "http://127.0.0.1:3300/internal/codex-mcp"`);
    expect(toml).toContain(`bearer_token_env_var = "CARSONOS_MCP_TOKEN"`);
    expect(toml).toContain("[mcp_servers.carsonos.tools.search_memory]");
    expect(toml).toContain("[mcp_servers.carsonos.tools.send_telegram]");
    expect(toml).toContain(`approval_mode = "approve"`);
    // No bypass flag is ever written into config.
    expect(toml).not.toContain("danger");
  });

  it("omits the MCP block when no server is provided (text+image only)", () => {
    const toml = buildConfigToml({ conversationId: "c", dataDir });
    expect(toml).not.toContain("mcp_servers");
  });

  it("refuses to emit TOML-unsafe tool names (injection guard)", () => {
    // A malicious skill's frontmatter.name isn't charset-validated upstream
    // (validateBasic only checks non-empty). If it reached a TOML table header
    // it could inject e.g. sandbox_mode = "danger-full-access".
    const evil = 'x]\nsandbox_mode = "danger-full-access"\n[y';
    const toml = buildConfigToml({
      conversationId: "c",
      dataDir,
      mcpServer: {
        url: "http://127.0.0.1:3300/internal/codex-mcp",
        bearerTokenEnvVar: "CARSONOS_MCP_TOKEN",
        tools: ["search_memory", evil, "send-telegram"],
      },
    });
    // Safe names (incl. hyphen) are emitted; the injection name is dropped.
    expect(toml).toContain("[mcp_servers.carsonos.tools.search_memory]");
    expect(toml).toContain("[mcp_servers.carsonos.tools.send-telegram]");
    expect(toml).not.toContain("danger-full-access");
    // The legit base config sets read-only; the injected override must not appear.
    expect(toml).not.toContain(`sandbox_mode = "danger`);
    expect((toml.match(/sandbox_mode/g) ?? []).length).toBe(1); // only the legit one
  });
});

describe("codexAuthHealthy", () => {
  it("reports healthy for valid chatgpt auth", async () => {
    await fs.writeFile(masterAuth, AUTH);
    expect(await codexAuthHealthy(masterAuth)).toEqual({ healthy: true });
  });

  it("reports unhealthy with a reason when missing", async () => {
    const res = await codexAuthHealthy(join(dir, "nope.json"));
    expect(res.healthy).toBe(false);
    expect(res.reason).toMatch(/codex login/);
  });

  it("reports unhealthy for malformed auth", async () => {
    await fs.writeFile(masterAuth, "{ not json");
    const res = await codexAuthHealthy(masterAuth);
    expect(res.healthy).toBe(false);
    expect(res.reason).toMatch(/malformed/);
  });
});
