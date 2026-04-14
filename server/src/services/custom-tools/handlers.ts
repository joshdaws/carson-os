/**
 * System tool handlers for the custom tool registry.
 *
 * Each handler writes to all three layers (file, DB, registry) using the
 * reconciliation sequence defined in the design doc. Per-tool async mutexes
 * prevent concurrent writes to the same tool name.
 */

import { and, eq, inArray } from "drizzle-orm";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@carsonos/db";
import { customTools, staffAgents, toolGrants, toolSecrets } from "@carsonos/db";
import type { ToolResult } from "@carsonos/shared";

import {
  atomicWriteFile,
  ensureToolsDir,
  hashToolDir,
  toolDirPath,
  toolRelPath,
  validateToolName,
} from "./fs-helpers.js";
import { parseSkillMd, writeSkillMd, type HttpConfig, type SkillDoc, type ToolKind } from "./skill-md.js";
import { build as esbuildBuild } from "esbuild";
import { encryptSecret } from "./secrets.js";
import { invalidateHandlerCache } from "./executors.js";
import { CUSTOM_TOOL_NAMES, CUSTOM_TOOL_SYSTEM_TOOLS } from "./system-tools.js";

// Keep system-tools re-exports tidy
export { CUSTOM_TOOL_NAMES, CUSTOM_TOOL_SYSTEM_TOOLS };

// ── Handler context ───────────────────────────────────────────────────

export interface CustomToolHandlerContext {
  db: Db;
  agentId: string;
  householdId: string;
  dataDir?: string;
  isChiefOfStaff: boolean;
  /** Called when a tool is created/updated/disabled so the registry can refresh. */
  onToolChanged: (event: ToolChangeEvent) => Promise<void>;
}

export type ToolChangeEvent =
  | { type: "created"; toolId: string }
  | { type: "updated"; toolId: string; affectsScript: boolean }
  | { type: "disabled"; toolId: string }
  | { type: "activated"; toolId: string };

// ── Per-tool mutex ────────────────────────────────────────────────────

const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const p = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, prev.then(() => p));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Clean up if we're still the tail
    if (locks.get(key) === prev.then(() => p)) {
      // noop — best-effort; map can be cleaned on next create
    }
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────

export async function handleCustomToolSystemTool(
  ctx: CustomToolHandlerContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "create_http_tool":
      return handleCreateHttpTool(ctx, input);
    case "create_prompt_tool":
      return handleCreatePromptTool(ctx, input);
    case "create_script_tool":
      return handleCreateScriptTool(ctx, input);
    case "list_custom_tools":
      return handleListCustomTools(ctx, input);
    case "update_custom_tool":
      return handleUpdateCustomTool(ctx, input);
    case "disable_custom_tool":
      return handleDisableCustomTool(ctx, input);
    case "store_secret":
      return handleStoreSecret(ctx, input);
    case "install_skill":
      return handleInstallSkill(ctx, input);
    default:
      return errResult("not_found", `Unknown custom tool system tool: ${name}`);
  }
}

// ── Create HTTP tool ──────────────────────────────────────────────────

async function handleCreateHttpTool(
  ctx: CustomToolHandlerContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const name = String(input.name ?? "").trim();
  const description = String(input.description ?? "").trim();
  const method = input.method as HttpConfig["method"];
  const urlTemplate = String(input.urlTemplate ?? "");
  const bundle = input.bundle ? String(input.bundle) : undefined;

  const basic = validateBasic(name, description, input.input_schema);
  if (basic) return basic;

  if (!method || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return errResult("validation_error", `method must be one of GET, POST, PUT, PATCH, DELETE. Got '${method ?? ""}'.`);
  }
  if (!urlTemplate || !urlTemplate.startsWith("https://")) {
    return errResult(
      "validation_error",
      `urlTemplate must be an HTTPS URL. Got '${urlTemplate}'. Retry with a URL starting with 'https://'.`,
    );
  }

  // Validate auth if present
  const auth = input.auth as HttpConfig["auth"] | undefined;
  if (auth) {
    const authErr = validateAuth(auth);
    if (authErr) return authErr;
  }

  // Validate domainAllowlist
  if (input.domainAllowlist !== undefined) {
    if (!Array.isArray(input.domainAllowlist)) {
      return errResult("validation_error", "domainAllowlist must be an array. Omit to allow only urlTemplate's domain.");
    }
    if (input.domainAllowlist.length === 0) {
      return errResult(
        "validation_error",
        "domainAllowlist cannot be empty []. Omit the field entirely to allow only urlTemplate's domain.",
      );
    }
  }

  const config: HttpConfig = {
    method,
    urlTemplate,
    ...(input.headers ? { headers: input.headers as Record<string, string> } : {}),
    ...(auth ? { auth } : {}),
    ...(input.bodyTemplate ? { bodyTemplate: String(input.bodyTemplate) } : {}),
    ...(input.responseExtract ? { responseExtract: String(input.responseExtract) } : {}),
    ...(input.domainAllowlist ? { domainAllowlist: input.domainAllowlist as string[] } : {}),
  };

  const doc: SkillDoc = {
    frontmatter: {
      name,
      description,
      kind: "http",
      input_schema: input.input_schema as Record<string, unknown>,
      http: config,
    },
    body: `# ${name}\n\n${description}\n`,
  };

  return writeAndRegisterTool(ctx, name, bundle, "http", doc);
}

// ── Create prompt tool ────────────────────────────────────────────────

async function handleCreatePromptTool(
  ctx: CustomToolHandlerContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const name = String(input.name ?? "").trim();
  const description = String(input.description ?? "").trim();
  const body = String(input.body ?? "");
  const bundle = input.bundle ? String(input.bundle) : undefined;

  const basic = validateBasic(name, description, input.input_schema);
  if (basic) return basic;

  if (!body.trim()) {
    return errResult("validation_error", "body must be a non-empty markdown template. Example: 'Steps: 1. Do X. 2. Do Y.'");
  }

  const doc: SkillDoc = {
    frontmatter: {
      name,
      description,
      kind: "prompt",
      input_schema: input.input_schema as Record<string, unknown>,
    },
    body,
  };

  return writeAndRegisterTool(ctx, name, bundle, "prompt", doc);
}

// ── Create script tool ────────────────────────────────────────────────

async function handleCreateScriptTool(
  ctx: CustomToolHandlerContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const name = String(input.name ?? "").trim();
  const description = String(input.description ?? "").trim();
  const handlerCode = String(input.handler_code ?? "");
  const bundle = input.bundle ? String(input.bundle) : undefined;

  const basic = validateBasic(name, description, input.input_schema);
  if (basic) return basic;

  if (!handlerCode.trim()) {
    return errResult("validation_error", "handler_code must be non-empty TypeScript. Include an 'export async function handler(input, ctx)' definition.");
  }

  // Pre-validate by running esbuild (no disk write yet)
  try {
    await esbuildBuild({
      stdin: { contents: handlerCode, loader: "ts", resolveDir: process.cwd() },
      bundle: false,
      write: false,
      platform: "node",
      format: "esm",
      target: "node20",
    });
  } catch (err) {
    return errResult(
      "validation_error",
      `handler_code has a TypeScript/esbuild error: ${(err as Error).message}. Fix the syntax and retry.`,
    );
  }

  const doc: SkillDoc = {
    frontmatter: {
      name,
      description,
      kind: "script",
      input_schema: input.input_schema as Record<string, unknown>,
    },
    body: `# ${name}\n\n${description}\n`,
  };

  return writeAndRegisterTool(ctx, name, bundle, "script", doc, handlerCode);
}

// ── Shared create path ────────────────────────────────────────────────

async function writeAndRegisterTool(
  ctx: CustomToolHandlerContext,
  name: string,
  bundle: string | undefined,
  kind: ToolKind,
  doc: SkillDoc,
  handlerCode?: string,
): Promise<ToolResult> {
  try {
    validateToolName(name);
  } catch (err) {
    return errResult("validation_error", (err as Error).message);
  }

  // Check uniqueness + built-in name collision
  if (CUSTOM_TOOL_NAMES.has(name)) {
    return errResult(
      "validation_error",
      `'${name}' is a reserved system tool name. Choose a different name (e.g., 'my_${name}').`,
    );
  }

  const existing = ctx.db
    .select({ id: customTools.id, status: customTools.status })
    .from(customTools)
    .where(and(eq(customTools.householdId, ctx.householdId), eq(customTools.name, name)))
    .all();
  if (existing.length > 0) {
    return errResult(
      "validation_error",
      `A custom tool named '${name}' already exists in this household (status=${existing[0].status}). Use update_custom_tool to modify, or pick a different name.`,
    );
  }

  return withLock(`${ctx.householdId}:${name}`, async () => {
    // 1. Prepare paths
    ensureToolsDir(ctx.householdId);
    const dir = toolDirPath(ctx.householdId, bundle, name);
    const relPath = toolRelPath(bundle, name);

    // 2. Write files atomically
    atomicWriteFile(join(dir, "SKILL.md"), writeSkillMd(doc));
    if (kind === "script" && handlerCode) {
      atomicWriteFile(join(dir, "handler.ts"), handlerCode);
    }

    // 3. Compute hash
    const hash = hashToolDir(dir);

    // 4. Decide initial status
    // Script tools created by non-CoS enter pending_approval
    const initialStatus = kind === "script" && !ctx.isChiefOfStaff ? "pending_approval" : "active";
    // Only set approved_content_hash if activating now
    const approvedHash = initialStatus === "active" ? hash : null;

    // 5. Insert DB row
    const [row] = await ctx.db
      .insert(customTools)
      .values({
        householdId: ctx.householdId,
        name,
        kind,
        path: relPath,
        createdByAgentId: ctx.agentId,
        source: "agent",
        status: initialStatus,
        approvedContentHash: approvedHash,
        schemaVersion: 1,
        generation: 1,
      })
      .returning();

    // 6. Auto-grant to creator (only if active)
    if (initialStatus === "active") {
      await ctx.db
        .insert(toolGrants)
        .values({ agentId: ctx.agentId, toolName: name, grantedBy: ctx.agentId })
        .onConflictDoNothing();
    }

    // 7. Notify registry
    await ctx.onToolChanged({ type: "created", toolId: row.id });

    if (initialStatus === "pending_approval") {
      return {
        content:
          `Created '${name}' but it's awaiting Chief of Staff approval because script tools require review. ` +
          `Ask a parent to review and approve it in the admin UI at Settings → Custom Tools → Pending Approvals.`,
      };
    }

    return {
      content: `Created custom ${kind} tool '${name}'. ${
        kind === "prompt" ? "Invoke it like any other tool; the filled template will be returned to you." : "Available in subsequent messages."
      }`,
    };
  });
}

// ── List ──────────────────────────────────────────────────────────────

async function handleListCustomTools(
  ctx: CustomToolHandlerContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const kindFilter = input.kind as ToolKind | undefined;
  const includeDisabled = input.include_disabled === true;
  const includePending = input.include_pending === true;

  const statuses: string[] = ["active"];
  if (includeDisabled) statuses.push("disabled");
  if (includePending) statuses.push("pending_approval", "broken");

  const rows = ctx.db
    .select()
    .from(customTools)
    .where(and(eq(customTools.householdId, ctx.householdId), inArray(customTools.status, statuses)))
    .all();
  const filtered = kindFilter ? rows.filter((r) => r.kind === kindFilter) : rows;

  if (filtered.length === 0) {
    return { content: "No custom tools found." };
  }

  const lines = filtered.map(
    (r) =>
      `- ${r.name} (${r.kind}, ${r.status}) used ${r.usageCount}×${r.lastUsedAt ? ` last on ${r.lastUsedAt.toISOString?.() ?? r.lastUsedAt}` : ""}${r.lastError ? ` — error: ${r.lastError}` : ""}`,
  );

  return { content: `${filtered.length} custom tool(s):\n${lines.join("\n")}` };
}

// ── Update ────────────────────────────────────────────────────────────

async function handleUpdateCustomTool(
  ctx: CustomToolHandlerContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const name = String(input.name ?? "").trim();
  if (!name) return errResult("validation_error", "name is required (identifies the tool to update).");

  const row = ctx.db
    .select()
    .from(customTools)
    .where(and(eq(customTools.householdId, ctx.householdId), eq(customTools.name, name)))
    .all()[0];

  if (!row) {
    return errResult("not_found", `No custom tool named '${name}' in this household. Call list_custom_tools to see what exists.`);
  }

  // MODIFY permission
  if (!ctx.isChiefOfStaff && row.createdByAgentId !== ctx.agentId) {
    return errResult(
      "permission_denied",
      `You can only modify custom tools you created. '${name}' was created by a different agent. Ask the Chief of Staff or the creator to update it.`,
    );
  }

  return withLock(`${ctx.householdId}:${name}`, async () => {
    const dir = toolDirPath(ctx.householdId, bundleFromPath(row.path), name);
    const skillPath = join(dir, "SKILL.md");
    if (!existsSync(skillPath)) {
      return errResult("broken", `SKILL.md missing at ${row.path}. Disable and recreate the tool.`);
    }

    const doc = parseSkillMd(readFileSync(skillPath, "utf8"));
    let affectsScript = false;

    // Apply updates by kind
    if (input.description !== undefined) {
      doc.frontmatter.description = String(input.description);
    }
    if (input.input_schema !== undefined) {
      doc.frontmatter.input_schema = input.input_schema as Record<string, unknown>;
    }

    if (row.kind === "http") {
      const http = (doc.frontmatter.http ?? {}) as HttpConfig;
      if (input.method !== undefined) http.method = input.method as HttpConfig["method"];
      if (input.urlTemplate !== undefined) http.urlTemplate = String(input.urlTemplate);
      if (input.headers !== undefined) http.headers = input.headers as Record<string, string>;
      if (input.auth !== undefined) {
        const authErr = validateAuth(input.auth as HttpConfig["auth"]);
        if (authErr) return authErr;
        http.auth = input.auth as HttpConfig["auth"];
      }
      if (input.bodyTemplate !== undefined) http.bodyTemplate = String(input.bodyTemplate);
      if (input.responseExtract !== undefined) http.responseExtract = String(input.responseExtract);
      if (input.domainAllowlist !== undefined) {
        if (!Array.isArray(input.domainAllowlist) || input.domainAllowlist.length === 0) {
          return errResult("validation_error", "domainAllowlist, if provided, must be a non-empty array. Omit to allow only urlTemplate's domain.");
        }
        http.domainAllowlist = input.domainAllowlist as string[];
      }
      doc.frontmatter.http = http;
    } else if (row.kind === "prompt") {
      if (input.body !== undefined) doc.body = String(input.body);
    } else if (row.kind === "script") {
      if (input.handler_code !== undefined) {
        // Validate before writing
        try {
          await esbuildBuild({
            stdin: { contents: String(input.handler_code), loader: "ts", resolveDir: process.cwd() },
            bundle: false,
            write: false,
            platform: "node",
            format: "esm",
            target: "node20",
          });
        } catch (err) {
          return errResult("validation_error", `handler_code has a TypeScript/esbuild error: ${(err as Error).message}`);
        }
        atomicWriteFile(join(dir, "handler.ts"), String(input.handler_code));
        affectsScript = true;
      }
    }

    atomicWriteFile(skillPath, writeSkillMd(doc));

    // Compute new hash
    const newHash = hashToolDir(dir);
    const newGeneration = row.generation + 1;
    const newSchemaVersion = row.schemaVersion + 1;

    // For script tools: if hash changed AND updater is not CoS, enter pending_approval
    let newStatus = row.status;
    let newApprovedHash = row.approvedContentHash;

    if (row.kind === "script" && newHash !== row.approvedContentHash) {
      if (ctx.isChiefOfStaff) {
        newApprovedHash = newHash;
      } else {
        newStatus = "pending_approval";
      }
    } else if (row.kind !== "script") {
      // Non-script: always update approved hash (approval doesn't apply)
      newApprovedHash = newHash;
    }

    await ctx.db
      .update(customTools)
      .set({
        status: newStatus,
        approvedContentHash: newApprovedHash,
        schemaVersion: newSchemaVersion,
        generation: newGeneration,
        updatedAt: new Date(),
      })
      .where(eq(customTools.id, row.id));

    // Invalidate handler cache for script tools
    if (affectsScript) {
      invalidateHandlerCache(join(dir, "handler.ts"));
    }

    await ctx.onToolChanged({ type: "updated", toolId: row.id, affectsScript });

    if (newStatus === "pending_approval") {
      return {
        content:
          `Updated '${name}' but the script changes require Chief of Staff approval. ` +
          `The tool is paused until approved via admin UI.`,
      };
    }

    return { content: `Updated '${name}'. Takes effect on the next message.` };
  });
}

// ── Disable ───────────────────────────────────────────────────────────

async function handleDisableCustomTool(
  ctx: CustomToolHandlerContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const name = String(input.name ?? "").trim();
  if (!name) return errResult("validation_error", "name is required.");

  const row = ctx.db
    .select()
    .from(customTools)
    .where(and(eq(customTools.householdId, ctx.householdId), eq(customTools.name, name)))
    .all()[0];

  if (!row) {
    return errResult("not_found", `No custom tool named '${name}'.`);
  }

  if (!ctx.isChiefOfStaff && row.createdByAgentId !== ctx.agentId) {
    return errResult("permission_denied", `You can only disable tools you created, or any tool if you are Chief of Staff.`);
  }

  if (row.status === "disabled") {
    return { content: `'${name}' was already disabled.` };
  }

  await ctx.db
    .update(customTools)
    .set({ status: "disabled", updatedAt: new Date() })
    .where(eq(customTools.id, row.id));

  await ctx.onToolChanged({ type: "disabled", toolId: row.id });

  return { content: `'${name}' disabled. Grants preserved; re-enable via admin UI.` };
}

// ── Store secret ──────────────────────────────────────────────────────

async function handleStoreSecret(
  ctx: CustomToolHandlerContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const keyName = String(input.key_name ?? "").trim();
  const value = String(input.value ?? "");

  if (!keyName) return errResult("validation_error", "key_name is required. Example: 'ynab_api_token'.");
  if (!/^[a-zA-Z0-9_]+$/.test(keyName) || keyName.length > 64) {
    return errResult(
      "validation_error",
      "key_name must be snake_case (letters, numbers, underscores only), max 64 chars.",
    );
  }
  if (!value) return errResult("validation_error", "value is required and must be non-empty.");

  const encrypted = encryptSecret(value, ctx.dataDir);

  const existing = ctx.db
    .select({ id: toolSecrets.id })
    .from(toolSecrets)
    .where(and(eq(toolSecrets.householdId, ctx.householdId), eq(toolSecrets.keyName, keyName)))
    .all()[0];

  if (existing) {
    await ctx.db
      .update(toolSecrets)
      .set({ encryptedValue: encrypted, updatedAt: new Date() })
      .where(eq(toolSecrets.id, existing.id));
    return { content: `Rotated secret '${keyName}'. Tools using it will pick up the new value on the next invocation.` };
  }

  await ctx.db
    .insert(toolSecrets)
    .values({ householdId: ctx.householdId, keyName, encryptedValue: encrypted });

  return { content: `Stored secret '${keyName}'. Reference it from custom tools via auth.secretKey or ctx.getSecret('${keyName}').` };
}

// ── Install skill ─────────────────────────────────────────────────────

async function handleInstallSkill(
  _ctx: CustomToolHandlerContext,
  _input: Record<string, unknown>,
): Promise<ToolResult> {
  // M1 implementation note: the full fetch+extract+manifest validation pipeline
  // is non-trivial (~200 lines with tarball handling, MANIFEST.json parsing,
  // HTTPS enforcement, size caps). Ship as follow-up PR. For now, return a
  // useful message so agents know the surface exists.
  return {
    content:
      "install_skill is registered but not yet implemented in this build. " +
      "To install a skill manually, extract it to ~/.carsonos/tools/{household-id}/{skill-name}/ " +
      "and restart the server; boot reconciliation will import the SKILL.md files as orphans " +
      "for admin approval. Full install_skill pipeline lands in a follow-up.",
    is_error: true,
    error_code: "not_found",
  } as ToolResult;
}

// ── Helpers ───────────────────────────────────────────────────────────

function validateBasic(
  name: string,
  description: string,
  inputSchema: unknown,
): ToolResult | null {
  if (!name) return errResult("validation_error", "name is required and must be non-empty. Example: 'check_ynab_balance'.");
  if (!description) return errResult("validation_error", "description is required and must be non-empty. Example: 'Get current balance for a YNAB account.'");
  if (!inputSchema || typeof inputSchema !== "object") {
    return errResult(
      "validation_error",
      "input_schema must be a JSON Schema object with 'type': 'object' at the root. Example: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }.",
    );
  }
  const is = inputSchema as Record<string, unknown>;
  if (is.type !== "object") {
    return errResult(
      "validation_error",
      "input_schema must have 'type': 'object' at the root. Wrap your properties like { type: 'object', properties: {...} }.",
    );
  }
  return null;
}

function validateAuth(auth: unknown): ToolResult | null {
  if (!auth || typeof auth !== "object") {
    return errResult("validation_error", "auth must be an object like { method: 'bearer', secretKey: 'my_token' }.");
  }
  const a = auth as { method?: string; secretKey?: string; name?: string; param?: string };
  if (!a.method || !["bearer", "header", "query"].includes(a.method)) {
    return errResult(
      "validation_error",
      `auth.method must be 'bearer', 'header', or 'query'. Got '${a.method ?? ""}'.`,
    );
  }
  if (!a.secretKey || typeof a.secretKey !== "string") {
    return errResult("validation_error", "auth.secretKey is required. Call store_secret({ key_name: '<name>', value: '<secret>' }) first.");
  }
  if (a.method === "header" && !a.name) {
    return errResult(
      "validation_error",
      "auth.method='header' requires auth.name (the HTTP header name). Example: { method: 'header', name: 'X-API-Key', secretKey: 'my_token' }.",
    );
  }
  if (a.method === "query" && !a.param) {
    return errResult(
      "validation_error",
      "auth.method='query' requires auth.param (the query param name). Example: { method: 'query', param: 'api_key', secretKey: 'my_token' }.",
    );
  }
  return null;
}

function errResult(code: string, content: string): ToolResult {
  // Append a pointer to the tool-creation guide for validation failures so
  // the agent has a cheap recovery path when inputs are malformed.
  const withGuidePointer =
    code === "validation_error"
      ? `${content} For the full tool-creation playbook, call get_agent_guide({ name: 'tool-creation' }).`
      : content;
  return {
    content: withGuidePointer,
    is_error: true,
    ...(code ? { error_code: code as never } : {}),
  } as ToolResult;
}

function bundleFromPath(path: string): string | undefined {
  const parts = path.split("/");
  return parts.length > 1 ? parts[0] : undefined;
}

/** Helper used by boot reconciliation. */
export async function loadHouseholdList(db: Db): Promise<string[]> {
  const agents = db
    .select({ householdId: staffAgents.householdId })
    .from(staffAgents)
    .all();
  return Array.from(new Set(agents.map((a) => a.householdId)));
}
