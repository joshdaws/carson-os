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
import { customTools, toolSecrets, delegationEdges } from "@carsonos/db";
import type { ToolResult } from "@carsonos/shared";
import type { ToolRegistry } from "../tool-registry.js";

import {
  atomicWriteFile,
  bundleFromPath,
  ensureToolsDir,
  hashToolDir,
  removeToolDir,
  toolDirPath,
  toolRelPath,
  validateToolName,
} from "./fs-helpers.js";
import { parseSkillMd, writeSkillMd, type HttpConfig, type SkillDoc, type ToolKind } from "./skill-md.js";
import { build as esbuildBuild } from "esbuild";
import { encryptSecret } from "./secrets.js";
import { invalidateHandlerCache } from "./executors.js";
import { CUSTOM_TOOL_NAMES, CUSTOM_TOOL_SYSTEM_TOOLS } from "./system-tools.js";
import { cleanupStaging, InstallError, prepareInstall, promoteTool } from "./install.js";

// Keep system-tools re-exports tidy
export { CUSTOM_TOOL_NAMES, CUSTOM_TOOL_SYSTEM_TOOLS };

// ── Handler context ───────────────────────────────────────────────────

export interface CustomToolHandlerContext {
  db: Db;
  agentId: string;
  householdId: string;
  toolRegistry: ToolRegistry;
  dataDir?: string;
  isChiefOfStaff: boolean;
  /** True for agents trusted to create `active` script tools without a
   *  review gate. Set for: Chief of Staff (legacy) AND Developer agents
   *  with specialty=tools (v0.4 — Dev's whole job is building tools; gating
   *  every one defeats the point for average users). */
  canCreateActiveTools?: boolean;
  /** Called when a tool is created/updated/disabled so the registry can refresh. */
  onToolChanged: (event: ToolChangeEvent) => Promise<void>;
}

export type ToolChangeEvent =
  | { type: "created"; toolId: string }
  | { type: "updated"; toolId: string; affectsScript: boolean }
  | { type: "disabled"; toolId: string };

// ── Per-tool mutex ────────────────────────────────────────────────────

const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const p = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => p);
  locks.set(key, tail);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) {
      locks.delete(key);
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
  const auth = input.auth as HttpConfig["auth"] | undefined;
  const bundle = input.bundle ? String(input.bundle) : undefined;

  const basic = validateBasic(name, description, input.input_schema);
  if (basic) return basic;
  const config: HttpConfig = {
    method,
    urlTemplate,
    ...(input.headers ? { headers: input.headers as Record<string, string> } : {}),
    ...(auth ? { auth } : {}),
    ...(input.bodyTemplate ? { bodyTemplate: String(input.bodyTemplate) } : {}),
    ...(input.responseExtract ? { responseExtract: String(input.responseExtract) } : {}),
    ...(input.domainAllowlist ? { domainAllowlist: input.domainAllowlist as string[] } : {}),
  };
  const configErr = validateHttpConfig(config);
  if (configErr) return configErr;

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
  const bodyErr = validatePromptBody(body);
  if (bodyErr) return bodyErr;

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
  const handlerErr = await validateScriptHandler(handlerCode);
  if (handlerErr) return handlerErr;

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

  // Reserved-name check is purely in-memory, safe to run outside the lock.
  // Also check the normalized form: now that validateToolName accepts hyphens
  // (for skills-ecosystem compatibility), a name like `create-http-tool` would
  // pass the regex but collide semantically with the reserved `create_http_tool`.
  // Normalize hyphens to underscores and re-check so the agent can't shadow a
  // system tool by alias.
  if (CUSTOM_TOOL_NAMES.has(name) || CUSTOM_TOOL_NAMES.has(name.replace(/-/g, "_"))) {
    return errResult(
      "validation_error",
      `'${name}' collides with a reserved system tool name (either exactly or after hyphen→underscore normalization). Pick a different name.`,
    );
  }

  return withLock(`${ctx.householdId}:${name}`, async () => {
    // Uniqueness check lives INSIDE the lock so two concurrent creates for the
    // same name can't both pass. Without this, the loser would overwrite the
    // winner's files on disk after the winner's DB insert, leaving the DB row
    // pointing at attacker-controlled content.
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

    // 1. Prepare paths
    ensureToolsDir(ctx.householdId);
    const dir = toolDirPath(ctx.householdId, bundle, name);
    const relPath = toolRelPath(bundle, name);

    // 2. Decide initial status before writes so we know what state to persist.
    // Script tools default to pending_approval EXCEPT for trusted creators —
    // Chief of Staff AND Developer-with-tools-specialty. Gating every tool a
    // Dev builds would make this unusable for the target user (family member
    // who just wants "can you make me a thing that does X").
    const bypassApproval = ctx.isChiefOfStaff || ctx.canCreateActiveTools === true;
    const initialStatus = kind === "script" && !bypassApproval ? "pending_approval" : "active";

    // 3. Insert DB row FIRST. Relies on the unique index on (household_id,
    // name) as the authoritative tiebreaker — if a racing insert snuck past
    // the in-memory lock somehow, the DB rejects the second writer before we
    // touch disk.
    let row: typeof customTools.$inferSelect;
    try {
      [row] = await ctx.db
        .insert(customTools)
        .values({
          householdId: ctx.householdId,
          name,
          kind,
          path: relPath,
          createdByAgentId: ctx.agentId,
          source: "agent",
          status: initialStatus,
          approvedContentHash: null, // filled in after file write + hash
          schemaVersion: 1,
          generation: 1,
        })
        .returning();
    } catch (err) {
      return errResult(
        "validation_error",
        `Failed to register '${name}' (database rejected insert, possibly a duplicate): ${(err as Error).message}`,
      );
    }

    // 4. Write files atomically. If either write fails we must roll back the
    // DB row so we don't leave an orphan entry pointing at a missing file.
    try {
      atomicWriteFile(join(dir, "SKILL.md"), writeSkillMd(doc));
      if (kind === "script" && handlerCode) {
        atomicWriteFile(join(dir, "handler.ts"), handlerCode);
      }
    } catch (err) {
      await ctx.db.delete(customTools).where(eq(customTools.id, row.id));
      return errResult("validation_error", `Failed to write tool files: ${(err as Error).message}`);
    }

    // 5. Hash the written content and finalize the row
    const hash = hashToolDir(dir);
    const approvedHash = initialStatus === "active" ? hash : null;
    await ctx.db
      .update(customTools)
      .set({ approvedContentHash: approvedHash })
      .where(eq(customTools.id, row.id));

    // 6. Notify registry
    await ctx.onToolChanged({ type: "created", toolId: row.id });

    // 7. Auto-grant. Always to creator (existing behavior). Additionally, if
    //    the creator is a hired specialist (staffRole=custom with a specialty),
    //    auto-grant to every agent that has a delegation edge TO this creator
    //    — i.e., the parent agents who can delegate to them. That's the
    //    agents who trust the specialist to do the work and should trust
    //    the tools the specialist builds in service of that work. For v0.4
    //    with CoS→Dev, this means Carson gets publish_to_web the moment Dev
    //    creates it, no extra step.
    if (initialStatus === "active") {
      await ctx.toolRegistry.grant(ctx.agentId, name, ctx.agentId);

      if (ctx.canCreateActiveTools) {
        const parents = await ctx.db
          .select({ fromAgentId: delegationEdges.fromAgentId })
          .from(delegationEdges)
          .where(eq(delegationEdges.toAgentId, ctx.agentId));
        for (const p of parents) {
          try {
            await ctx.toolRegistry.grant(p.fromAgentId, name, ctx.agentId);
          } catch (err) {
            console.warn(`[custom-tools] propagation grant failed ${p.fromAgentId}→${name}:`, err);
          }
        }
      }
    }

    if (initialStatus === "pending_approval") {
      return {
        content:
          `Created '${name}' but it's awaiting Chief of Staff approval because script tools require review. ` +
          `Ask a parent to review and approve it in the admin UI at Settings → Custom Tools → Pending Approvals.`,
      };
    }

    return {
      content: `Created custom ${kind} tool '${name}'. ${
        kind === "prompt"
          ? "Invoke it like any other tool; the filled template will be returned to you."
          : "It's now available for use in this conversation (mid-session refresh)."
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
    let stagedHandlerCode: string | null = null;

    // Apply updates in memory first — do NOT touch disk until every piece of
    // input has been validated. Writing handler.ts before validating the full
    // update lets a bad-metadata submission swap in unapproved script code
    // while leaving the DB row in its old state; the next uncached invocation
    // would then compile and run the unapproved code.
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
        http.auth = input.auth as HttpConfig["auth"];
      }
      if (input.bodyTemplate !== undefined) http.bodyTemplate = String(input.bodyTemplate);
      if (input.responseExtract !== undefined) http.responseExtract = String(input.responseExtract);
      if (input.domainAllowlist !== undefined) {
        http.domainAllowlist = input.domainAllowlist as string[];
      }
      doc.frontmatter.http = http;
    } else if (row.kind === "prompt") {
      if (input.body !== undefined) doc.body = String(input.body);
    } else if (row.kind === "script") {
      if (input.handler_code !== undefined) {
        const code = String(input.handler_code);
        const handlerErr = await validateScriptHandler(code);
        if (handlerErr) return handlerErr;
        stagedHandlerCode = code;
      }
    }

    // Validate the fully-assembled doc BEFORE any writes hit disk. If this
    // rejects, nothing on disk changed.
    const validationErr = validateUpdatedToolDoc(row.kind as ToolKind, doc);
    if (validationErr) return validationErr;

    // All validation passed. Writes are atomic (temp + rename) so a crash
    // between them leaves either old or new content but never a partial file.
    // Write SKILL.md FIRST, then handler.ts. If we crash between the two for
    // a script tool, boot-reconciliation's content-hash check will detect
    // the mismatch and push the tool to pending_approval — safe degradation.
    // Reversing the order would make the handler.ts change live before the
    // frontmatter (input_schema, description) updated, which is a worse
    // mid-crash state.
    atomicWriteFile(skillPath, writeSkillMd(doc));
    if (stagedHandlerCode !== null) {
      atomicWriteFile(join(dir, "handler.ts"), stagedHandlerCode);
      affectsScript = true;
    }

    // Compute new hash
    const newHash = hashToolDir(dir);
    const newGeneration = row.generation + 1;
    const newSchemaVersion = row.schemaVersion + 1;

    // For script tools: if hash changed AND updater is not CoS, enter pending_approval
    let newStatus = row.status;
    let newApprovedHash = row.approvedContentHash;

    if (row.kind === "script" && newHash !== row.approvedContentHash) {
      if (ctx.isChiefOfStaff || ctx.canCreateActiveTools) {
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
  ctx: CustomToolHandlerContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const source = String(input.source ?? "").trim();
  if (!source) {
    return errResult("validation_error", "source is required. Example: 'skills.sh/youtube-transcript' or 'https://example.com/skill.tar.gz'.");
  }
  const rename = input.rename !== undefined ? String(input.rename).trim() : undefined;

  // Only CoS can install skills — they run as `active` immediately and
  // script tools inside skip the per-creation approval because the operator
  // chose to trust the source. Non-CoS would need a review queue we haven't
  // built yet.
  if (!ctx.isChiefOfStaff) {
    return errResult(
      "permission_denied",
      "Only the Chief of Staff can install skills. Ask a parent to run install_skill, then request a grant.",
    );
  }

  let result;
  try {
    result = await prepareInstall(source);
  } catch (err) {
    if (err instanceof InstallError) {
      return errResult(err.code, err.message);
    }
    return errResult("http_error", `install_skill failed: ${(err as Error).message}`);
  }

  // If the caller passed `rename` but the archive contains multiple tools,
  // that's ambiguous — refuse rather than silently rename the first one.
  if (rename && result.entries.length > 1) {
    cleanupStaging(result.stagingRoot);
    return errResult(
      "validation_error",
      `Archive contains ${result.entries.length} tools; 'rename' can only be used when installing a single tool.`,
    );
  }

  // Check for collisions against existing custom tools in this household.
  const names = result.entries.map((e) => (rename && result.entries.length === 1 ? rename : e.toolName));
  const collisions = ctx.db
    .select({ name: customTools.name })
    .from(customTools)
    .where(and(eq(customTools.householdId, ctx.householdId), inArray(customTools.name, names)))
    .all();
  if (collisions.length > 0) {
    cleanupStaging(result.stagingRoot);
    return errResult(
      "validation_error",
      `Tool name(s) already exist: ${collisions.map((c) => c.name).join(", ")}. Use 'rename' (single-tool archives) or delete the existing tool first.`,
    );
  }

  // Also reject names that would shadow system tools. Without this check, a
  // third-party skill could ship a SKILL.md whose frontmatter.name is
  // `store_secret` or `install_skill` and hijack the reserved routing.
  for (const entry of result.entries) {
    const candidateName = rename && result.entries.length === 1 ? rename : entry.toolName;
    if (CUSTOM_TOOL_NAMES.has(candidateName)) {
      cleanupStaging(result.stagingRoot);
      return errResult(
        "validation_error",
        `Skill declares reserved tool name '${candidateName}'. Use 'rename' (single-tool archive) or pick a different skill.`,
      );
    }
    // The hyphen-variant of a reserved snake_case name would bypass the check
    // above. Normalize and re-check.
    if (CUSTOM_TOOL_NAMES.has(candidateName.replace(/-/g, "_"))) {
      cleanupStaging(result.stagingRoot);
      return errResult(
        "validation_error",
        `Skill name '${candidateName}' collides with a reserved system tool after normalization.`,
      );
    }
  }

  // Promote each tool. Track every side effect (filesystem dir, DB row,
  // registry registration, grant) so we can compensate if any step fails.
  // The previous implementation only rolled back DB rows — files promoted
  // into the live tools dir were left behind as orphans, and already-
  // registered tools stayed callable until the next server restart.
  const promoted: Array<{ destDir: string; name: string; rowId?: string; registered?: boolean; granted?: boolean }> = [];
  try {
    for (const entry of result.entries) {
      const finalName = rename && result.entries.length === 1 ? rename : entry.toolName;
      const relPath = toolRelPath(entry.bundle, finalName);
      const destDir = toolDirPath(ctx.householdId, entry.bundle, finalName);
      ensureToolsDir(ctx.householdId);

      const tracker: typeof promoted[number] = { destDir, name: finalName };
      promoted.push(tracker);

      promoteTool(entry, destDir);

      const [row] = await ctx.db
        .insert(customTools)
        .values({
          householdId: ctx.householdId,
          name: finalName,
          kind: entry.kind,
          path: relPath,
          createdByAgentId: ctx.agentId,
          // Schema documents legal values as 'agent' | 'installed-skill' | 'imported'.
          // Earlier versions wrote "skill_install" here, which never matched the
          // UI check (`source === "installed-skill"`) so the install card and
          // future update-check button stayed hidden. Standardized now.
          source: "installed-skill",
          sourceUrl: result.sourceUrl,
          status: "active",
          approvedContentHash: entry.contentHash,
          schemaVersion: 1,
          generation: 1,
        })
        .returning({ id: customTools.id, name: customTools.name });
      tracker.rowId = row.id;

      await ctx.onToolChanged({ type: "created", toolId: row.id });
      tracker.registered = true;

      await ctx.toolRegistry.grant(ctx.agentId, finalName, ctx.agentId);
      tracker.granted = true;
    }
  } catch (err) {
    // Compensate in reverse order — for each partially-succeeded tool, undo
    // whatever side effects reached disk or state.
    for (const t of promoted.reverse()) {
      if (t.granted) {
        try { await ctx.toolRegistry.revoke(ctx.agentId, t.name); } catch { /* best effort */ }
      }
      if (t.registered) {
        try { ctx.toolRegistry.unregisterCustom(ctx.householdId, t.name); } catch { /* best effort */ }
      }
      if (t.rowId) {
        try { await ctx.db.delete(customTools).where(eq(customTools.id, t.rowId)); } catch { /* best effort */ }
      }
      // Always try to remove the promoted directory, even if DB/registry
      // work never happened — the file move is the first side effect in
      // the loop, so it's the one most likely to exist on a partial install.
      try { removeToolDir(t.destDir); } catch { /* best effort */ }
    }
    cleanupStaging(result.stagingRoot);
    return errResult(
      "validation_error",
      `install_skill failed partway through: ${(err as Error).message}. Partial install rolled back.`,
    );
  }

  const installedRows = promoted.filter((t) => t.rowId).map((t) => ({ id: t.rowId!, name: t.name }));
  cleanupStaging(result.stagingRoot);

  return {
    content:
      `Installed ${installedRows.length} tool(s) from ${result.sourceUrl}: ${installedRows.map((r) => r.name).join(", ")}. ` +
      `They're granted to you and available in subsequent messages. Grant to others via the admin UI.`,
  };
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

function validatePromptBody(body: string): ToolResult | null {
  if (!body.trim()) {
    return errResult("validation_error", "body must be a non-empty markdown template. Example: 'Steps: 1. Do X. 2. Do Y.'");
  }
  return null;
}

function validateHttpConfig(http: HttpConfig): ToolResult | null {
  if (!http.method || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(http.method)) {
    return errResult("validation_error", `method must be one of GET, POST, PUT, PATCH, DELETE. Got '${http.method ?? ""}'.`);
  }
  if (!http.urlTemplate || !http.urlTemplate.startsWith("https://")) {
    return errResult(
      "validation_error",
      `urlTemplate must be an HTTPS URL. Got '${http.urlTemplate ?? ""}'. Retry with a URL starting with 'https://'.`,
    );
  }
  if (http.auth) {
    const authErr = validateAuth(http.auth);
    if (authErr) return authErr;
  }
  if (http.domainAllowlist !== undefined) {
    if (!Array.isArray(http.domainAllowlist)) {
      return errResult("validation_error", "domainAllowlist must be an array. Omit to allow only urlTemplate's domain.");
    }
    if (http.domainAllowlist.length === 0) {
      return errResult(
        "validation_error",
        "domainAllowlist cannot be empty []. Omit the field entirely to allow only urlTemplate's domain.",
      );
    }
  }
  return null;
}

async function validateScriptHandler(handlerCode: string): Promise<ToolResult | null> {
  if (!handlerCode.trim()) {
    return errResult("validation_error", "handler_code must be non-empty TypeScript. Include an 'export async function handler(input, ctx)' definition.");
  }

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
  return null;
}

function validateUpdatedToolDoc(kind: ToolKind, doc: SkillDoc): ToolResult | null {
  const basic = validateBasic(
    String(doc.frontmatter.name ?? "").trim(),
    String(doc.frontmatter.description ?? "").trim(),
    doc.frontmatter.input_schema,
  );
  if (basic) return basic;

  if (kind === "http") {
    return validateHttpConfig((doc.frontmatter.http ?? {}) as HttpConfig);
  }
  if (kind === "prompt") {
    return validatePromptBody(doc.body);
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
