/**
 * Integration test for the v0.6.0 engine cutover: ConstitutionEngine.processMessage
 * routes each turn through a harness chosen by agent.model.
 *
 *   - A Claude model streams through ClaudeHarness wrapping the engine's own
 *     injected adapter (so existing adapter behavior is preserved).
 *   - A Codex model resolves from the harness registry — the injected Claude
 *     adapter is NOT touched.
 *
 * This is the first automated coverage of processMessage end-to-end; it seeds
 * a minimal in-memory household so the turn reaches the harness call.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb, type Db, households, familyMembers, staffAgents } from "@carsonos/db";
import type { AdapterExecuteParams, AdapterExecuteResult } from "@carsonos/shared";
import type { Adapter } from "../subprocess-adapter.js";
import { ConstitutionEngine } from "../constitution-engine.js";
import { registerHarness, __TEST_resetRegistry } from "../harness/registry.js";
import type { AgentHarness } from "../harness/types.js";

class FakeAdapter implements Adapter {
  name = "fake-claude";
  lastParams: AdapterExecuteParams | undefined;
  async execute(params: AdapterExecuteParams): Promise<AdapterExecuteResult> {
    this.lastParams = params;
    params.onTextDelta?.("claude ");
    params.onTextDelta?.("says hi");
    return { content: "claude says hi", sessionId: "claude-sess-1" };
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

async function seed(db: Db, model: string) {
  const [household] = await db
    .insert(households)
    .values({ id: "h1", name: "Test", timezone: "America/New_York" })
    .returning();
  const [member] = await db
    .insert(familyMembers)
    .values({ householdId: household.id, name: "Josh", role: "parent", age: 48 })
    .returning();
  const [agent] = await db
    .insert(staffAgents)
    .values({ householdId: household.id, name: "Carson", staffRole: "personal", model })
    .returning();
  return { household, member, agent };
}

let db: Db;

beforeEach(() => {
  __TEST_resetRegistry();
  db = createDb(":memory:");
});

afterEach(() => {
  __TEST_resetRegistry();
});

describe("ConstitutionEngine harness routing", () => {
  it("routes a Claude agent through ClaudeHarness wrapping the injected adapter", async () => {
    const { household, member, agent } = await seed(db, "claude-sonnet-4-6");
    const adapter = new FakeAdapter();
    const deltas: string[] = [];
    const engine = new ConstitutionEngine({ db, broadcast: () => {}, adapter });

    const result = await engine.processMessage({
      agentId: agent.id,
      memberId: member.id,
      householdId: household.id,
      message: "hi",
      channel: "telegram",
      onTextDelta: (t) => deltas.push(t),
    });

    expect(result.blocked).toBe(false);
    expect(result.response).toContain("claude says hi");
    // Streamed through the harness, not collected only at the end.
    expect(deltas).toEqual(["claude ", "says hi"]);
    // Claude harness used the engine's injected adapter.
    expect(adapter.lastParams).toBeDefined();
  });

  it("routes a Codex agent to the registered codex harness, never touching the Claude adapter", async () => {
    const { household, member, agent } = await seed(db, "codex/gpt-5.4");

    let codexCalled = false;
    const codexHarness: AgentHarness = {
      id: "codex",
      capabilities: {
        supportsImages: true,
        supportsMcp: true,
        refreshTier: "per-turn",
        resumeKind: "thread_id",
      },
      streamTurn: () => {
        codexCalled = true;
        return (async function* () {
          yield { type: "text_delta", text: "codex hi" } as const;
          yield { type: "session_id", harness: "codex", id: "thread-1" } as const;
          yield { type: "done", content: "codex hi" } as const;
        })();
      },
      healthCheck: async () => ({ healthy: true }),
    };
    registerHarness("codex", () => codexHarness);

    const adapter = new FakeAdapter();
    const engine = new ConstitutionEngine({ db, broadcast: () => {}, adapter });

    const result = await engine.processMessage({
      agentId: agent.id,
      memberId: member.id,
      householdId: household.id,
      message: "hi",
      channel: "telegram",
    });

    expect(codexCalled).toBe(true);
    expect(result.response).toContain("codex hi");
    // The Claude adapter must not be invoked for a Codex agent.
    expect(adapter.lastParams).toBeUndefined();
  });
});
