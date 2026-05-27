/**
 * Streamable-HTTP MCP server exposing CarsonOS system tools to Codex agents.
 *
 * Runs IN the CarsonOS main process (loopback only), so tools execute unjailed
 * even though codex itself spawns under `--sandbox read-only`. Codex connects
 * with a per-turn bearer token (config.toml `bearer_token_env_var`); the token
 * resolves to that turn's {tools, executor} via {@link CodexToolRegistry}, so
 * each agent only ever sees its own tools.
 *
 * Hand-rolled JSON-RPC over HTTP (no SDK): for a request/response-only tool
 * server, the streamable-HTTP spec permits a plain `application/json` response
 * per POST — no SSE, no session id needed. This mirrors the stdio echo server
 * the security spike proved codex accepts.
 */

import express, { type Request, type Response } from "express";
import type { CodexToolRegistry, RegisteredTurn } from "./codex-tool-registry.js";

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
}

/**
 * Handle one JSON-RPC message for a resolved turn. Returns the JSON-RPC
 * response, or null for notifications (no id) which get a 202.
 */
export async function handleMcpMessage(
  msg: JsonRpcRequest,
  turn: RegisteredTurn,
): Promise<object | null> {
  if (!msg || typeof msg !== "object" || msg.id === undefined || msg.id === null) {
    return null; // notification (e.g. notifications/initialized) — no response body
  }
  const id = msg.id;

  switch (msg.method) {
    case "initialize":
      return ok(id, {
        protocolVersion:
          typeof msg.params?.protocolVersion === "string"
            ? msg.params.protocolVersion
            : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "carsonos", version: "0.6.0" },
      });

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, {
        tools: turn.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: normalizeSchema(t.input_schema),
        })),
      });

    case "tools/call": {
      const name = msg.params?.name;
      const def = typeof name === "string" ? turn.tools.find((t) => t.name === name) : undefined;
      if (!def) {
        return rpcError(id, -32602, `unknown tool: ${String(name)}`);
      }
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      // The Claude SDK path validates args against the tool's JSON schema before
      // dispatch; the Codex path must too, or executors get raw model-shaped args
      // (missing required fields, wrong types) the SDK path never lets through.
      const argErr = validateArgs(def.input_schema, args);
      if (argErr) {
        return rpcError(id, -32602, `invalid arguments for ${def.name}: ${argErr}`);
      }
      try {
        const result = await turn.executor(def.name, args);
        // Tool-level failures are returned as a successful result with
        // isError:true (per MCP) so the model sees the error, not a transport fault.
        return ok(id, {
          content: [{ type: "text", text: result.content }],
          isError: result.is_error ?? false,
        });
      } catch (e) {
        return ok(id, {
          content: [{ type: "text", text: `tool error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        });
      }
    }

    default:
      return rpcError(id, -32601, `method not found: ${String(msg.method)}`);
  }
}

/** Express router for the loopback MCP endpoint. Bearer token = per-turn auth. */
export function createCodexMcpRouter(registry: CodexToolRegistry): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "4mb" }));

  router.post("/", async (req: Request, res: Response) => {
    const token = extractBearer(req.headers.authorization);
    const turn = token ? registry.get(token) : undefined;
    if (!turn) {
      res.status(401).json(rpcError(null, -32001, "unauthorized: unknown or expired MCP token"));
      return;
    }

    const body = req.body as JsonRpcRequest | JsonRpcRequest[];
    try {
      if (Array.isArray(body)) {
        const responses = (await Promise.all(body.map((m) => handleMcpMessage(m, turn)))).filter(
          (r): r is object => r !== null,
        );
        if (responses.length === 0) res.status(202).end();
        else res.json(responses);
        return;
      }
      const response = await handleMcpMessage(body, turn);
      if (response === null) res.status(202).end();
      else res.json(response);
    } catch (e) {
      res.status(500).json(
        rpcError(
          (!Array.isArray(body) && body?.id) || null,
          -32603,
          e instanceof Error ? e.message : "internal error",
        ),
      );
    }
  });

  return router;
}

// -- helpers ----------------------------------------------------------

function ok(id: string | number, result: object): object {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : undefined;
}

/** MCP requires inputSchema to be a JSON-Schema object; default to an empty one. */
function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema && typeof schema === "object" && schema.type) return schema;
  return { type: "object", properties: {} };
}

/**
 * Lightweight JSON-Schema validation for tool args: required fields present and
 * top-level property types match. Not a full validator — just enough to match
 * the trust boundary the Claude SDK enforces. Returns an error string or null.
 */
function validateArgs(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  if (!schema || typeof schema !== "object") return null;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  for (const key of required) {
    if (typeof key === "string" && !(key in args)) return `missing required field "${key}"`;
  }
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  for (const [key, val] of Object.entries(args)) {
    const declared = props[key]?.type;
    if (!declared || val === null || val === undefined) continue;
    if (!matchesJsonType(val, declared)) {
      return `field "${key}" expected ${declared}, got ${Array.isArray(val) ? "array" : typeof val}`;
    }
  }
  return null;
}

function matchesJsonType(val: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof val === "string";
    case "number":
    case "integer": return typeof val === "number";
    case "boolean": return typeof val === "boolean";
    case "array": return Array.isArray(val);
    case "object": return typeof val === "object" && !Array.isArray(val);
    default: return true; // unknown/unconstrained type — don't reject
  }
}
