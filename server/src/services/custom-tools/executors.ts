/**
 * Custom tool executors — HTTP, prompt, script.
 *
 * The registry's in-memory entry carries the tool's kind, config, body, and
 * path. These executors consume those fields to produce ToolResults.
 *
 * Script execution: handler.ts is bundled with esbuild at first invocation
 * (and after updates bump the generation counter). The bundle is written to
 * a temp .mjs file and dynamic-imported via file://…?gen=N URLs, which is
 * how we invalidate Node's permanent ESM module cache on updates.
 */

import { build as esbuildBuild } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { toolSecrets } from "@carsonos/db";
import type { ToolResult, MemoryProvider } from "@carsonos/shared";

import type { HttpConfig, HttpAuth } from "./skill-md.js";
import { decryptSecret } from "./secrets.js";

// ── Shared ──────────────────────────────────────────────────────────

export type CustomErrorCode =
  | "timeout"
  | "http_error"
  | "domain_blocked"
  | "sandbox_error"
  | "auth_missing"
  | "validation_error"
  | "rate_limited"
  | "permission_denied"
  | "not_found"
  | "pending_approval"
  | "broken";

export function toolError(code: CustomErrorCode, content: string, detail?: string): ToolResult {
  return { content, is_error: true, ...(detail ? { error_code: code, detail } : { error_code: code }) } as ToolResult;
}

export interface ExecContext {
  db: Db;
  householdId: string;
  memberId?: string;
  memberName?: string;
  memoryProvider?: MemoryProvider | null;
  dataDir?: string;
}

/** Single-pass substitution of {{placeholders}} from an input object. */
export function substituteTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => {
    const val = input[key];
    if (val === undefined || val === null) return "";
    return String(val);
  });
}

// ── HTTP executor ───────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000;

export async function executeHttpTool(
  config: HttpConfig,
  input: Record<string, unknown>,
  ctx: ExecContext,
): Promise<ToolResult> {
  const url = substituteTemplate(config.urlTemplate, input);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return toolError("validation_error", `Invalid URL after substitution: ${url}. Check that all {{placeholders}} resolved correctly.`);
  }
  if (parsedUrl.protocol !== "https:") {
    return toolError("domain_blocked", `HTTPS required; got ${parsedUrl.protocol}. Update urlTemplate to use https://.`);
  }

  const allowlist = config.domainAllowlist ?? [parsedUrl.hostname];
  if (!allowlist.includes(parsedUrl.hostname)) {
    return toolError(
      "domain_blocked",
      `Domain '${parsedUrl.hostname}' not in allowlist ${JSON.stringify(allowlist)}. Update the tool's domainAllowlist to include this domain.`,
    );
  }

  const headers: Record<string, string> = { ...(config.headers ?? {}) };

  // Auth injection
  if (config.auth) {
    const authResult = await applyAuth(parsedUrl, headers, config.auth, ctx);
    if ("error" in authResult) return authResult.error;
  }

  // Body substitution
  let body: string | undefined;
  if (config.bodyTemplate && ["POST", "PUT", "PATCH"].includes(config.method)) {
    body = substituteTemplate(config.bodyTemplate, input);
    if (!headers["content-type"] && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(parsedUrl.toString(), {
      method: config.method,
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    });

    // Handle redirects with per-hop allowlist re-check
    let finalRes = res;
    // Track the full authority (host:port) so a redirect from
    // `api.example.com` to `api.example.com:8443` is treated as cross-origin
    // — different port usually means a different service, and we shouldn't
    // hand its auth header over just because the hostname matches.
    let currentAuthority = parsedUrl.host;
    let hops = 0;
    while (finalRes.status >= 300 && finalRes.status < 400 && hops < 5) {
      const loc = finalRes.headers.get("location");
      if (!loc) break;
      const nextUrl = new URL(loc, `https://${currentAuthority}`);
      if (nextUrl.protocol !== "https:") {
        return toolError("domain_blocked", `Redirect to non-HTTPS '${loc}' blocked.`);
      }
      if (!allowlist.includes(nextUrl.hostname)) {
        return toolError(
          "domain_blocked",
          `Redirect to '${nextUrl.hostname}' blocked (not in allowlist).`,
        );
      }
      // Cross-origin redirect (different host OR different port): strip auth
      // headers before re-issuing. Same-port hostname-only match is the only
      // case where we carry auth across.
      const nextHeaders = nextUrl.host !== currentAuthority
        ? stripAuthHeaders(headers, config.auth)
        : headers;
      finalRes = await fetch(nextUrl.toString(), {
        method: config.method,
        headers: nextHeaders,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      currentAuthority = nextUrl.host;
      hops++;
    }

    if (!finalRes.ok) {
      const text = await readBodyCapped(finalRes);
      return toolError(
        "http_error",
        `HTTP ${finalRes.status} from ${parsedUrl.hostname}. Body: ${text.slice(0, 500)}`,
        `status=${finalRes.status}`,
      );
    }

    const text = await readBodyCapped(finalRes);
    const content = applyResponseExtract(text, config.responseExtract);
    return { content };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return toolError("timeout", `HTTP request timed out after ${DEFAULT_TIMEOUT_MS}ms.`);
    }
    return toolError("http_error", `Request failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function applyAuth(
  url: URL,
  headers: Record<string, string>,
  auth: HttpAuth,
  ctx: ExecContext,
): Promise<{ ok: true } | { error: ToolResult }> {
  const secret = await loadSecret(ctx.db, ctx.householdId, auth.secretKey, ctx.dataDir);
  if (secret === null) {
    return {
      error: toolError(
        "auth_missing",
        `Secret '${auth.secretKey}' is not stored. Call store_secret({ key_name: '${auth.secretKey}', value: <the token> }) first, then retry.`,
      ),
    };
  }
  if (auth.method === "bearer") {
    headers["Authorization"] = `Bearer ${secret}`;
  } else if (auth.method === "header") {
    headers[auth.name] = secret;
  } else if (auth.method === "query") {
    url.searchParams.set(auth.param, secret);
  }
  return { ok: true };
}

/**
 * Strip auth-bearing headers before following a cross-host redirect. Matches
 * the browser / curl --location-trusted default: never hand a bearer token to
 * a different origin than the one the user configured. Case-insensitive
 * because header maps are sometimes canonicalized upstream.
 */
function stripAuthHeaders(
  headers: Record<string, string>,
  authConfig: HttpAuth | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const stripNames = new Set(["authorization", "cookie", "proxy-authorization"]);
  if (authConfig?.method === "header") {
    stripNames.add(authConfig.name.toLowerCase());
  }
  for (const [k, v] of Object.entries(headers)) {
    if (!stripNames.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

async function loadSecret(
  db: Db,
  householdId: string,
  keyName: string,
  dataDir?: string,
): Promise<string | null> {
  const [row] = await db
    .select({ encryptedValue: toolSecrets.encryptedValue })
    .from(toolSecrets)
    .where(and(eq(toolSecrets.householdId, householdId), eq(toolSecrets.keyName, keyName)))
    .limit(1);
  if (!row) return null;
  try {
    return decryptSecret(row.encryptedValue, dataDir);
  } catch {
    return null;
  }
}

async function readBodyCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      chunks.push(value);
    }
  }
  const combined = new Uint8Array(total > MAX_RESPONSE_BYTES ? MAX_RESPONSE_BYTES : total);
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, combined.length - offset);
    combined.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= combined.length) break;
  }
  const text = new TextDecoder().decode(combined);
  return total > MAX_RESPONSE_BYTES ? text + "\n[truncated: response exceeded 1MB]" : text;
}

function applyResponseExtract(text: string, extract?: string): string {
  if (!extract) return text;
  try {
    const json = JSON.parse(text);
    const result = jsonPathSimple(json, extract);
    if (result === undefined) return text;
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  } catch {
    return text;
  }
}

/** Minimal JSONPath subset: $.a.b, $.items[0].name, $..key not supported. */
function jsonPathSimple(root: unknown, path: string): unknown {
  if (!path.startsWith("$")) return undefined;
  let curr: unknown = root;
  const parts = path.slice(1).split(/[.\[\]]+/).filter(Boolean);
  for (const part of parts) {
    if (curr === null || curr === undefined) return undefined;
    if (/^\d+$/.test(part)) {
      curr = (curr as unknown[])[Number(part)];
    } else {
      curr = (curr as Record<string, unknown>)[part];
    }
  }
  return curr;
}

// ── Prompt executor ─────────────────────────────────────────────────

export function executePromptTool(body: string, input: Record<string, unknown>): ToolResult {
  const filled = substituteTemplate(body, input);
  return { content: filled };
}

// ── Script executor ─────────────────────────────────────────────────

export interface CustomToolContext {
  db: Db;
  fetch: typeof globalThis.fetch;
  getSecret: (keyName: string) => Promise<string | null>;
  memory: MemoryProvider | null;
  householdId: string;
  memberId?: string;
  memberName?: string;
  log: (msg: string) => void;
}

interface LoadedHandler {
  fn: (input: Record<string, unknown>, ctx: CustomToolContext) => Promise<ToolResult>;
}

// Cache keyed by `${absPath}|${generation}` so updates get new modules.
const handlerCache = new Map<string, LoadedHandler>();

export async function executeScriptTool(
  handlerTsPath: string,
  generation: number,
  input: Record<string, unknown>,
  ctx: ExecContext,
): Promise<ToolResult> {
  const cacheKey = `${handlerTsPath}|${generation}`;
  let handler = handlerCache.get(cacheKey);

  if (!handler) {
    try {
      handler = await loadHandler(handlerTsPath, generation);
      handlerCache.set(cacheKey, handler);
    } catch (err) {
      return toolError(
        "sandbox_error",
        `Failed to compile handler.ts: ${(err as Error).message}. Fix the TypeScript error and update the tool.`,
      );
    }
  }

  const scriptCtx: CustomToolContext = {
    db: ctx.db,
    fetch: globalThis.fetch,
    getSecret: (keyName) => loadSecret(ctx.db, ctx.householdId, keyName, ctx.dataDir),
    memory: ctx.memoryProvider ?? null,
    householdId: ctx.householdId,
    memberId: ctx.memberId,
    memberName: ctx.memberName,
    log: (msg) => console.log(`[custom-tool] ${msg}`),
  };

  try {
    const result = await handler.fn(input, scriptCtx);
    if (!result || typeof result.content !== "string") {
      return toolError(
        "validation_error",
        `Script handler returned invalid shape. Expected { content: string, is_error?: boolean }, got ${JSON.stringify(result).slice(0, 200)}.`,
      );
    }
    return result;
  } catch (err) {
    return toolError("sandbox_error", `Script handler threw: ${(err as Error).message}`);
  }
}

async function loadHandler(handlerTsPath: string, generation: number): Promise<LoadedHandler> {
  const bundleResult = await esbuildBuild({
    entryPoints: [handlerTsPath],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    packages: "external", // don't bundle node_modules
    target: "node20",
  });
  if (!bundleResult.outputFiles?.[0]) {
    throw new Error("esbuild produced no output");
  }
  const code = bundleResult.outputFiles[0].text;

  // Write to a unique temp path so dynamic import()'s cache is per-generation.
  // mode 0700/0600 prevents other local users on a shared machine from reading
  // compiled handler source (which can contain inlined string literals that
  // esbuild doesn't strip even with `packages: "external"`).
  const outDir = join(tmpdir(), "carsonos-custom-tools");
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(6).toString("hex");
  const outPath = join(outDir, `handler.${generation}.${token}.mjs`);
  writeFileSync(outPath, code, { encoding: "utf8", mode: 0o600 });

  const url = `file://${outPath}?gen=${generation}`;
  const mod = (await import(url)) as { handler?: unknown };

  if (typeof mod.handler !== "function") {
    throw new Error("handler.ts must export an async function named 'handler'");
  }
  return { fn: mod.handler as LoadedHandler["fn"] };
}

/** Clear cached handlers for a given path (called from update_custom_tool). */
export function invalidateHandlerCache(handlerTsPath: string): void {
  for (const key of handlerCache.keys()) {
    if (key.startsWith(handlerTsPath + "|")) {
      handlerCache.delete(key);
    }
  }
}
