/**
 * Tests for the hand-rolled HTTP MCP server's message handler — the JSON-RPC
 * logic that exposes a turn's tools to Codex (initialize / tools.list /
 * tools.call / notifications / errors).
 */

import { describe, it, expect, vi } from "vitest";
import type { ToolDefinition } from "@carsonos/shared";
import type { RegisteredTurn } from "../codex-tool-registry.js";
import { handleMcpMessage } from "../codex-mcp-server.js";

const tools: ToolDefinition[] = [
  {
    name: "search_memory",
    description: "Search the family memory.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

function turn(executor: RegisteredTurn["executor"]): RegisteredTurn {
  return { tools, executor, expiresAt: Date.now() + 60_000 };
}

describe("handleMcpMessage", () => {
  it("answers initialize with capabilities + echoed protocol version", async () => {
    const res = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      turn(async () => ({ content: "" })),
    )) as { result: { protocolVersion: string; capabilities: object; serverInfo: { name: string } } };

    expect(res.result.protocolVersion).toBe("2025-06-18");
    expect(res.result.capabilities).toMatchObject({ tools: {} });
    expect(res.result.serverInfo.name).toBe("carsonos");
  });

  it("lists the turn's tools with inputSchema", async () => {
    const res = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      turn(async () => ({ content: "" })),
    )) as { result: { tools: Array<{ name: string; description: string; inputSchema: object }> } };

    expect(res.result.tools).toEqual([
      {
        name: "search_memory",
        description: "Search the family memory.",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    ]);
  });

  it("runs the executor on tools/call and returns content + isError", async () => {
    const executor = vi.fn(async () => ({ content: "found 3 memories" }));
    const res = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_memory", arguments: { query: "x" } } },
      turn(executor),
    )) as { result: { content: Array<{ type: string; text: string }>; isError: boolean } };

    expect(executor).toHaveBeenCalledWith("search_memory", { query: "x" });
    expect(res.result).toEqual({ content: [{ type: "text", text: "found 3 memories" }], isError: false });
  });

  it("surfaces an executor throw as a tool result with isError:true (not a protocol error)", async () => {
    const res = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_memory", arguments: {} } },
      turn(async () => {
        throw new Error("db locked");
      }),
    )) as { result: { isError: boolean; content: Array<{ text: string }> } };

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("db locked");
  });

  it("rejects an unknown tool with -32602", async () => {
    const res = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rm_rf", arguments: {} } },
      turn(async () => ({ content: "" })),
    )) as { error: { code: number } };
    expect(res.error.code).toBe(-32602);
  });

  it("returns null (no body) for notifications", async () => {
    expect(
      await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, turn(async () => ({ content: "" }))),
    ).toBeNull();
  });

  it("returns -32601 for unknown methods", async () => {
    const res = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 6, method: "resources/list" },
      turn(async () => ({ content: "" })),
    )) as { error: { code: number } };
    expect(res.error.code).toBe(-32601);
  });
});
