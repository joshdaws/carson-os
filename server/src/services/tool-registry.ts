/**
 * Tool Registry — central registry of all tools available in CarsonOS.
 *
 * Tools are registered at boot time (built-ins like memory, calendar) or
 * dynamically (installed skills, generated scripts). Each agent gets a
 * subset of tools based on their grants in the tool_grants table.
 *
 * Each tool has a handler function. The registry composes a single
 * executor that routes tool calls to the right handler.
 */

import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { eq, and } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { toolGrants, staffAgents, instanceSettings } from "@carsonos/db";
import type {
  ToolDefinition,
  ToolExecutor,
  ToolResult,
  MemoryProvider,
} from "@carsonos/shared";
import {
  MEMORY_TOOLS,
  type ToolContext,
  buildToolExecutor,
} from "./memory/index.js";
import { SCHEDULING_TOOLS, handleSchedulingTool } from "./scheduling-tools.js";
import { SELF_TOOLS, STAFF_TOOLS, handleAgentTool } from "./agent-tools.js";
import { AGENT_GUIDE_TOOLS, handleAgentGuideTool } from "./agent-guides.js";
import { REDACTION_TOOLS, REDACTION_TOOL_NAMES, handleRedactionTool } from "./redaction-tools.js";
import {
  CUSTOM_TOOL_SYSTEM_TOOLS,
  CUSTOM_TOOL_NAMES,
  handleCustomToolSystemTool,
  buildRegistrationFromRow,
  executeHttpTool,
  executePromptTool,
  executeScriptTool,
} from "./custom-tools/index.js";
import type { CustomRegistration } from "./custom-tools/index.js";
import {
  DELEGATION_TOOLS,
  DELEGATION_TOOL_NAMES,
  handleDelegationTool,
} from "./delegation/delegation-tools.js";

// ── Types ──────────────────────────────────────────────────────────

/** A tool handler takes (name, input) and returns a ToolResult. */
export type ToolHandler = (
  name: string,
  input: Record<string, unknown>,
) => Promise<ToolResult>;

/** Registry key helper for custom tools — household-scoped to prevent collisions. */
export function customKey(householdId: string, toolName: string): string {
  return `custom:${householdId}:${toolName}`;
}

/**
 * Tool tiers:
 *   - system:     Every agent gets these automatically, not toggleable (search_memory, update_instructions)
 *   - builtin:    Ships with CarsonOS, toggleable per-agent (calendar, gmail, drive)
 *   - custom:     Created by agents, imported from skills.sh, or user-installed
 *   - discovered: Found in ~/.claude/skills/, off by default, labeled in UI as global Claude skills
 */
export type ToolTier = "system" | "system-chief" | "builtin" | "custom" | "discovered";

export interface RegisteredTool {
  definition: ToolDefinition;
  /** Category for grouping in UI (memory, calendar, gmail, drive, etc.) */
  category: string;
  /** Tool tier determines visibility and default behavior */
  tier: ToolTier;
}

/** Context needed to build tool executors for a specific conversation */
export interface ToolExecutionContext {
  db: Db;
  memoryProvider: MemoryProvider | null;
  agentId: string;
  memberId: string;
  memberName: string;
  householdId: string;
  memberCollection: string;
  householdCollection: string;
  /** Whether this agent is the Chief of Staff (can search all collections) */
  isChiefOfStaff?: boolean;
  /** All member collection names in the household (for Chief of Staff "all" scope) */
  allMemberCollections?: string[];
  /** Collections this agent is allowed to read/write */
  allowedCollections?: string[];
  /** Multi-relay manager for bot control (pause/resume agents) */
  multiRelay?: import("./multi-relay-manager.js").MultiRelayManager;
  /** v0.4 delegation: service that creates + dispatches child tasks via MCP tool calls. */
  delegationService?: import("./delegation-service.js").DelegationService;
  /** v0.4 delegation: oversight for hire proposal escalation. */
  oversight?: import("./carson-oversight.js").CarsonOversight;
  /** v0.4 delegation: the caller's current task row id, when this executor is
   * running inside a task (Dispatcher path). undefined for normal agent turns. */
  callerTaskId?: string;
}

// ── Trust level → Claude Code built-in tools ────────────────────────

import type { TrustLevel } from "@carsonos/shared";

/**
 * Maps trust level to the Claude Code built-in tools the agent gets.
 * These are passed as the `tools` option to the Agent SDK.
 * Empty array = no built-ins (conversation + MCP tools only).
 */
export const TRUST_LEVEL_BUILTINS: Record<TrustLevel, string[]> = {
  full: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Skill"],
  standard: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
  restricted: [],
};

// ── Default tool grants per role ────────────────────────────────────

// Custom tool management capabilities — granted by default to head_butler.
// Other agents can be granted them explicitly via the admin UI.
const CUSTOM_TOOL_MGMT_GRANTS = [
  "create_http_tool", "create_prompt_tool", "create_script_tool",
  "list_custom_tools", "update_custom_tool", "disable_custom_tool",
  "store_secret", "install_skill",
  "redact_recent_user_message",
];

// v0.4 delegation tools — granted to agents who can initiate delegation.
// Head butler (CoS) gets the full set including register_project. Personal
// agents get the shorter set; the hire flow routes through CoS anyway.
const DELEGATION_GRANTS_FULL = [
  "delegate_task", "propose_hire", "cancel_task", "list_active_tasks", "register_project",
  // v0.4 N:M grants — CoS-only so kids can't self-authorize specialist access.
  "grant_delegation", "revoke_delegation",
  // v0.4 back-channel — everyone who can delegate needs to be able to read
  // the result on demand when the user follows up.
  "read_task_result",
];
const DELEGATION_GRANTS_PERSONAL = ["delegate_task", "cancel_task", "list_active_tasks", "read_task_result"];

const DEFAULT_GRANTS: Record<string, string[]> = {
  head_butler: [
    "search_memory", "read_memory", "save_memory", "delete_memory", "update_instructions",
    "list_calendar_events", "create_calendar_event", "get_calendar_event",
    "gmail_triage", "gmail_read", "gmail_compose", "gmail_reply", "gmail_update_draft", "gmail_send_draft", "gmail_search",
    "drive_search", "drive_list",
    ...CUSTOM_TOOL_MGMT_GRANTS,
    ...DELEGATION_GRANTS_FULL,
  ],
  personal: [
    "search_memory", "read_memory", "save_memory", "delete_memory", "update_instructions",
    "list_calendar_events", "create_calendar_event", "get_calendar_event",
    "gmail_triage", "gmail_read", "gmail_compose", "gmail_reply", "gmail_update_draft", "gmail_send_draft", "gmail_search",
    "drive_search", "drive_list",
    ...DELEGATION_GRANTS_PERSONAL,
  ],
  tutor: [
    "search_memory", "read_memory", "save_memory", "update_instructions",
    "list_calendar_events",
    "drive_search",
  ],
  coach: [
    "search_memory", "read_memory", "save_memory", "update_instructions",
    "list_calendar_events",
  ],
  scheduler: [
    "search_memory", "read_memory", "save_memory", "update_instructions",
    "list_calendar_events", "create_calendar_event", "get_calendar_event",
    "gmail_triage", "gmail_read", "gmail_search",
  ],
  custom: [
    "search_memory", "read_memory", "update_instructions",
  ],
};

// ── Registry ───────────────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  handlers = new Map<string, ToolHandler>(); // toolName → handler (public for per-member binding)
  private db: Db;

  /** Namespaced custom tool entries: key is `custom:{householdId}:{toolName}`. */
  private customByKey = new Map<string, CustomRegistration>();
  /** Per-household quick lookup: `householdId` → Set of tool names. */
  private customByHousehold = new Map<string, Set<string>>();
  /** Data dir for secret key lookups. Wired at boot. */
  private dataDir: string | undefined;

  constructor(db: Db) {
    this.db = db;
    this.registerBuiltins();
  }

  setDataDir(dataDir: string): void {
    this.dataDir = dataDir;
  }

  getDataDir(): string | undefined {
    return this.dataDir;
  }

  /** Register all built-in tools (memory, operating instructions). */
  private registerBuiltins(): void {
    // System tools — every agent gets these, not toggleable
    // Memory tools
    for (const def of MEMORY_TOOLS) {
      this.tools.set(def.name, {
        definition: def,
        category: "memory",
        tier: "system",
      });
    }

    // Agent self-management tools (every agent)
    for (const def of SELF_TOOLS) {
      this.tools.set(def.name, {
        definition: def,
        category: "agent",
        tier: "system",
      });
    }

    // Staff management tools (Chief of Staff only — conditionally included)
    for (const def of STAFF_TOOLS) {
      this.tools.set(def.name, {
        definition: def,
        category: "agent-staff",
        tier: "system-chief",
      });
    }

    // Scheduling tools
    for (const def of SCHEDULING_TOOLS) {
      this.tools.set(def.name, {
        definition: def,
        category: "scheduling",
        tier: "system",
      });
    }

    // Custom tool management tools — builtin tier, toggleable per agent
    for (const def of CUSTOM_TOOL_SYSTEM_TOOLS) {
      this.tools.set(def.name, {
        definition: def,
        category: "custom-tools",
        tier: "builtin",
      });
    }

    // Agent guides — system tier, always available. Cheap markdown loader.
    for (const def of AGENT_GUIDE_TOOLS) {
      this.tools.set(def.name, {
        definition: def,
        category: "agent-guides",
        tier: "system",
      });
    }

    // Redaction tools — builtin tier, default-granted to roles that also have
    // custom tool creation (so agents can scrub secrets after store_secret).
    for (const def of REDACTION_TOOLS) {
      this.tools.set(def.name, {
        definition: def,
        category: "redaction",
        tier: "builtin",
      });
    }

    // v0.4 delegation tools — registered in the `builtin` tier, role-gated via
    // DEFAULT_GRANTS so only head_butler + personal see them unless explicitly
    // granted. The registry already special-cases routing via
    // DELEGATION_TOOL_NAMES in buildExecutor().
    for (const def of DELEGATION_TOOLS) {
      this.tools.set(def.name, {
        definition: def,
        category: "delegation",
        tier: "builtin",
      });
    }
  }

  // ── Custom tool registry (namespaced per-household) ──────────────

  /** Register a custom tool (from boot loader or runtime create). */
  registerCustom(householdId: string, reg: CustomRegistration): void {
    const key = customKey(householdId, reg.name);
    this.customByKey.set(key, reg);
    let set = this.customByHousehold.get(householdId);
    if (!set) {
      set = new Set();
      this.customByHousehold.set(householdId, set);
    }
    set.add(reg.name);
    // Also place a thin entry in the main registry so listAll/UI show it
    this.tools.set(key, reg.registered);
  }

  /** Remove a custom tool from the in-memory registry (on disable). */
  unregisterCustom(householdId: string, toolName: string): void {
    const key = customKey(householdId, toolName);
    this.customByKey.delete(key);
    this.customByHousehold.get(householdId)?.delete(toolName);
    this.tools.delete(key);
  }

  getCustom(householdId: string, toolName: string): CustomRegistration | undefined {
    return this.customByKey.get(customKey(householdId, toolName));
  }

  listCustom(householdId: string): CustomRegistration[] {
    const names = this.customByHousehold.get(householdId);
    if (!names) return [];
    const out: CustomRegistration[] = [];
    for (const name of names) {
      const reg = this.customByKey.get(customKey(householdId, name));
      if (reg) out.push(reg);
    }
    return out;
  }

  /** Callback from handlers.ts when a tool's lifecycle event fires. */
  private async handleToolChange(
    householdId: string,
    event: { type: string; toolId: string; affectsScript?: boolean },
  ): Promise<void> {
    const { customTools } = await import("@carsonos/db");
    const row = await this.db
      .select()
      .from(customTools)
      .where(eq(customTools.id, event.toolId))
      .limit(1);
    if (!row[0]) return;
    const tool = row[0];

    if (event.type === "disabled" || tool.status !== "active") {
      this.unregisterCustom(householdId, tool.name);
      return;
    }

    // For created/updated: re-read the SKILL.md and re-register
    const { loadCustomTools } = await import("./custom-tools/index.js");
    // Simple approach: re-run the loader for this household. Cheap enough.
    // For M1 we can re-register the single tool by reading its file.
    try {
      const { parseSkillMd } = await import("./custom-tools/skill-md.js");
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { TOOLS_ROOT } = await import("./custom-tools/fs-helpers.js");
      const dir = join(TOOLS_ROOT, householdId, tool.path);
      const doc = parseSkillMd(readFileSync(join(dir, "SKILL.md"), "utf8"));
      this.registerCustom(householdId, buildRegistrationFromRow(tool, doc.frontmatter, doc.body, dir));
    } catch (err) {
      console.error(`[tool-registry] Failed to reload custom tool ${tool.name}:`, err);
      // Fall back to loading everything
      void loadCustomTools(this.db, this).catch(() => {});
    }
  }

  /** Increment usage_count + last_used_at for a custom tool. Fire-and-forget. */
  private async bumpUsage(toolId: string): Promise<void> {
    try {
      const { customTools } = await import("@carsonos/db");
      await this.db
        .update(customTools)
        .set({ lastUsedAt: new Date() })
        .where(eq(customTools.id, toolId));
      // Raw SQL for atomic increment
      (this.db as unknown as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).$client
        .prepare("UPDATE custom_tools SET usage_count = usage_count + 1 WHERE id = ?")
        .run(toolId);
    } catch {
      /* non-critical */
    }
  }

  /** Register a tool with its handler. */
  register(tool: RegisteredTool, handler?: ToolHandler): void {
    this.tools.set(tool.definition.name, tool);
    if (handler) {
      this.handlers.set(tool.definition.name, handler);
    }
  }

  /** Register multiple tools that share a handler (e.g., all calendar tools). */
  registerAll(tools: RegisteredTool[], handler: ToolHandler): void {
    for (const tool of tools) {
      this.tools.set(tool.definition.name, tool);
      this.handlers.set(tool.definition.name, handler);
    }
  }

  /** Get a registered tool by name. */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** List all registered tools. */
  listAll(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  /** List tools by category. */
  listByCategory(category: string): RegisteredTool[] {
    return [...this.tools.values()].filter((t) => t.category === category);
  }

  /** List tools by tier. */
  listByTier(tier: ToolTier): RegisteredTool[] {
    return [...this.tools.values()].filter((t) => t.tier === tier);
  }

  /**
   * Read the description from a skill's SKILL.md frontmatter.
   * Falls back to a generic description if the file is missing or unparseable.
   */
  private readSkillDescription(skillDir: string, skillName: string): string {
    const skillMdPath = join(skillDir, "SKILL.md");
    try {
      if (!existsSync(skillMdPath)) return `Claude Code skill: ${skillName}`;
      const content = readFileSync(skillMdPath, "utf8");
      // Extract YAML frontmatter between --- delimiters
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match) return `Claude Code skill: ${skillName}`;
      // Parse description field (may be multi-line with | indicator)
      const descMatch = match[1].match(/description:\s*\|?\n?((?:[ \t]+.+\n?)+)/);
      if (!descMatch) return `Claude Code skill: ${skillName}`;
      return descMatch[1]
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ");
    } catch {
      return `Claude Code skill: ${skillName}`;
    }
  }

  /**
   * Discover installed Claude Code skills from ~/.claude/skills/
   * and register them as toggleable builtin tools.
   */
  discoverSkills(): void {
    const skillsDir = join(homedir(), ".claude", "skills");
    if (!existsSync(skillsDir)) return;

    try {
      const entries = readdirSync(skillsDir).filter((name) => {
        if (name.startsWith(".")) return false;
        try { return statSync(join(skillsDir, name)).isDirectory(); } catch { return false; }
      });
      for (const name of entries) {
        const skillToolName = `skill:${name}`;
        if (this.tools.has(skillToolName)) continue;

        const skillDir = join(skillsDir, name);
        const description = this.readSkillDescription(skillDir, name);

        this.tools.set(skillToolName, {
          definition: {
            name: skillToolName,
            description,
            input_schema: { type: "object", properties: {} },
          },
          category: "skill",
          tier: "discovered",
        });
      }

      const count = entries.length;
      if (count > 0) {
        console.log(`[tools] Discovered ${count} Claude Code skills`);
      }
    } catch {
      // Skills dir not readable — skip
    }
  }

  /**
   * Get the Claude Code skill names an agent is granted.
   * Returns just the skill names (without "skill:" prefix)
   * for passing to the adapter's enabledSkills param.
   */
  /**
   * Get the Claude Code built-in tools for an agent based on trust level.
   * Passed as the `tools` option to the Agent SDK.
   */
  async getAgentBuiltins(agentId: string): Promise<string[]> {
    const [agent] = await this.db
      .select({ trustLevel: staffAgents.trustLevel })
      .from(staffAgents)
      .where(eq(staffAgents.id, agentId))
      .limit(1);

    const level = (agent?.trustLevel ?? "restricted") as TrustLevel;
    return TRUST_LEVEL_BUILTINS[level] ?? TRUST_LEVEL_BUILTINS.restricted;
  }

  async getAgentSkills(agentId: string): Promise<string[]> {
    const tools = await this.getAgentTools(agentId);
    return tools
      .filter((t) => t.name.startsWith("skill:"))
      .map((t) => t.name.replace("skill:", ""));
  }

  // ── Per-agent resolution ──────────────────────────────────────────

  /**
   * Get the tool definitions an agent is granted access to.
   * Checks tool_grants table first; falls back to role defaults
   * if no explicit grants exist.
   */
  async getAgentTools(agentId: string): Promise<ToolDefinition[]> {
    // Load agent to check if Chief of Staff + get household for custom-tool resolution
    const [agent] = await this.db
      .select({
        staffRole: staffAgents.staffRole,
        isHeadButler: staffAgents.isHeadButler,
        householdId: staffAgents.householdId,
      })
      .from(staffAgents)
      .where(eq(staffAgents.id, agentId))
      .limit(1);

    const isChief = agent?.isHeadButler || agent?.staffRole === "head_butler";
    const householdId = agent?.householdId;

    // System tools — every agent gets these
    const systemTools = [...this.tools.values()]
      .filter((t) => t.tier === "system")
      .map((t) => t.definition.name);

    // Chief of Staff also gets staff management tools
    if (isChief) {
      const chiefTools = [...this.tools.values()]
        .filter((t) => t.tier === "system-chief")
        .map((t) => t.definition.name);
      systemTools.push(...chiefTools);
    }

    // Check for explicit grants (builtin + custom tools)
    const grants = await this.db
      .select({ toolName: toolGrants.toolName })
      .from(toolGrants)
      .where(eq(toolGrants.agentId, agentId));

    let grantedNames: string[];

    if (grants.length > 0) {
      grantedNames = [...new Set([...systemTools, ...grants.map((g) => g.toolName)])];
    } else {
      const role = agent?.staffRole ?? "custom";
      grantedNames = [...new Set([...systemTools, ...(DEFAULT_GRANTS[role] ?? DEFAULT_GRANTS.custom)])];
    }

    // Resolve each granted name to a definition. Built-ins live in the Map
    // under their bare name. Custom tools live under `custom:{householdId}:{name}`
    // because the Map is process-global and has to prevent cross-household
    // collisions. Try bare first, then the household-scoped key.
    //
    // Dedupe by the final `definition.name` — different granted names can
    // resolve to the same tool (e.g., legacy bare grant `ynab_list_budgets`
    // and post-fix scoped grant `custom:{hh}:ynab_list_budgets` both map to
    // the same custom tool). Without this dedup, createSdkMcpServer throws
    // "Tool X is already registered" on the duplicate registration.
    const resolved: ToolDefinition[] = [];
    const seen = new Set<string>();
    for (const name of grantedNames) {
      const direct = this.tools.get(name);
      let def: ToolDefinition | undefined;
      if (direct) def = direct.definition;
      else if (householdId) {
        const scoped = this.tools.get(customKey(householdId, name));
        if (scoped) def = scoped.definition;
      }
      if (!def) continue;
      if (seen.has(def.name)) continue;
      seen.add(def.name);
      resolved.push(def);
    }
    return resolved;
  }

  /**
   * Build a composite tool executor for an agent's granted tools.
   * Routes each tool call to the right handler (memory, calendar, etc.).
   */
  async buildExecutor(
    ctx: ToolExecutionContext,
  ): Promise<{
    tools: ToolDefinition[];
    executor: ToolExecutor;
    calls: Array<{ name: string; input: Record<string, unknown>; result: ToolResult }>;
  } | null> {
    const tools = await this.getAgentTools(ctx.agentId);
    if (tools.length === 0) return null;

    const calls: Array<{ name: string; input: Record<string, unknown>; result: ToolResult }> = [];

    // Build the memory tool executor if memory provider is available
    let memoryExecutor: ToolExecutor | null = null;
    if (ctx.memoryProvider) {
      const toolCtx: ToolContext = {
        db: ctx.db,
        memoryProvider: ctx.memoryProvider,
        agentId: ctx.agentId,
        memberId: ctx.memberId,
        memberName: ctx.memberName,
        householdId: ctx.householdId,
        memberCollection: ctx.memberCollection,
        householdCollection: ctx.householdCollection,
        isChiefOfStaff: ctx.isChiefOfStaff,
        allMemberCollections: ctx.allMemberCollections,
        allowedCollections: ctx.allowedCollections,
      };
      const built = buildToolExecutor(toolCtx);
      memoryExecutor = built.executor;
      // Wire the memory executor's call log into our unified log
      const origExecutor = memoryExecutor;
      memoryExecutor = async (name, input) => {
        const result = await origExecutor(name, input);
        calls.push({ name, input, result });
        return result;
      };
    }

    // Composite executor: routes to the right handler per tool
    const executor: ToolExecutor = async (name, input) => {
      // Check for a registered handler first (calendar, etc.)
      const handler = this.handlers.get(name);
      if (handler) {
        const result = await handler(name, input);
        calls.push({ name, input, result });
        return result;
      }

      // Scheduling tools (create, list, pause, update, delete)
      const schedulingTools = ["schedule_task", "list_scheduled_tasks", "pause_scheduled_task", "update_scheduled_task", "delete_scheduled_task", "run_scheduled_task"];
      if (schedulingTools.includes(name)) {
        const result = await handleSchedulingTool(
          { db: ctx.db, agentId: ctx.agentId, memberId: ctx.memberId, householdId: ctx.householdId },
          name,
          input,
        );
        calls.push({ name, input, result });
        return result;
      }

      // Agent management tools (self + staff management for Chief of Staff)
      const agentToolNames = [
        "update_instructions", "update_personality", "update_role",
        "list_agents", "create_agent", "delete_agent", "pause_agent", "resume_agent", "update_agent_assignment",
        "list_agent_tools", "grant_tool_to_agent", "revoke_tool_from_agent",
      ];
      if (agentToolNames.includes(name)) {
        const result = await handleAgentTool(
          { db: ctx.db, agentId: ctx.agentId, memberId: ctx.memberId, memberName: ctx.memberName, householdId: ctx.householdId, isChiefOfStaff: ctx.isChiefOfStaff, multiRelay: ctx.multiRelay, toolRegistry: this },
          name,
          input,
        );
        calls.push({ name, input, result });
        return result;
      }

      // Agent guide loader
      if (name === "get_agent_guide") {
        const result = await handleAgentGuideTool(name, input);
        calls.push({ name, input, result });
        return result;
      }

      // v0.4 delegation tools (delegate_task, propose_hire, cancel_task,
      // list_active_tasks, register_project) — routed to the delegation service.
      if (DELEGATION_TOOL_NAMES.has(name)) {
        if (!ctx.delegationService || !ctx.oversight) {
          const result: ToolResult = {
            content: `Delegation tool '${name}' called but delegationService/oversight not wired into context.`,
            is_error: true,
          };
          calls.push({ name, input, result });
          return result;
        }
        const result = await handleDelegationTool(name, input, {
          db: ctx.db,
          agentId: ctx.agentId,
          householdId: ctx.householdId,
          memberId: ctx.memberId,
          callerTaskId: ctx.callerTaskId,
          delegationService: ctx.delegationService,
          oversight: ctx.oversight,
        });
        calls.push({ name, input, result });
        return result;
      }

      // Redaction tools (scrub sensitive content from the DB post-processing)
      if (REDACTION_TOOL_NAMES.has(name)) {
        const result = await handleRedactionTool(
          { db: ctx.db, agentId: ctx.agentId, memberId: ctx.memberId, householdId: ctx.householdId },
          name,
          input,
        );
        calls.push({ name, input, result });
        return result;
      }

      // Custom tool system tools (create_http_tool, store_secret, etc.)
      if (CUSTOM_TOOL_NAMES.has(name)) {
        // Developer agents with specialty=tools are trusted to create active
        // script tools without a review gate (v0.4 premise: tool-building
        // Devs exist precisely so average users don't have to approve every
        // tool). Chief of Staff keeps the legacy bypass too.
        const [callerAgent] = await this.db
          .select({ specialty: staffAgents.specialty, staffRole: staffAgents.staffRole })
          .from(staffAgents)
          .where(eq(staffAgents.id, ctx.agentId))
          .limit(1);
        const isToolsDeveloper =
          callerAgent?.staffRole === "custom" && callerAgent?.specialty === "tools";
        const result = await handleCustomToolSystemTool(
          {
            db: ctx.db,
            agentId: ctx.agentId,
            householdId: ctx.householdId,
            toolRegistry: this,
            dataDir: this.dataDir,
            isChiefOfStaff: ctx.isChiefOfStaff ?? false,
            canCreateActiveTools: isToolsDeveloper,
            onToolChanged: async (event) => this.handleToolChange(ctx.householdId, event),
          },
          name,
          input,
        );
        calls.push({ name, input, result });
        return result;
      }

      // Household-scoped custom tool invocation
      const customReg = this.getCustom(ctx.householdId, name);
      if (customReg) {
        const execCtx = {
          db: ctx.db,
          householdId: ctx.householdId,
          memberId: ctx.memberId,
          memberName: ctx.memberName,
          memoryProvider: ctx.memoryProvider,
          dataDir: this.dataDir,
        };
        let result: ToolResult;
        if (customReg.kind === "http" && customReg.httpConfig) {
          result = await executeHttpTool(customReg.httpConfig, input, execCtx);
        } else if (customReg.kind === "prompt") {
          result = executePromptTool(customReg.body, input);
        } else if (customReg.kind === "script") {
          const handlerPath = `${customReg.absDir}/handler.ts`;
          result = await executeScriptTool(handlerPath, customReg.generation, input, execCtx);
        } else {
          result = { content: `Custom tool '${name}' has unknown kind`, is_error: true };
        }
        // Update usage stats asynchronously (non-blocking)
        void this.bumpUsage(customReg.toolId);
        calls.push({ name, input, result });
        return result;
      }

      // Fall back to memory executor for memory tools
      if (memoryExecutor) {
        return memoryExecutor(name, input);
      }

      const result: ToolResult = { content: `Tool "${name}" has no handler`, is_error: true };
      calls.push({ name, input, result });
      return result;
    };

    return { tools, executor, calls };
  }

  // ── Grant management ──────────────────────────────────────────────

  /**
   * Boot-time reconciliation: seed agents with any role-default tools they
   * haven't seen yet. Protects future DEFAULT_GRANTS changes — e.g., v0.4
   * adds delegation tools, v0.5 adds whatever next — from the silent bug
   * where existing agents with explicit grants miss the new defaults.
   *
   * Per-agent marker in instance_settings (`grants_seeded:<agentId>` →
   * JSON array of tool names already seeded for that agent). User
   * revocations after seeding persist — a revoked tool stays in the seeded
   * list, so the reconciler never re-adds it. Only genuinely new defaults
   * get seeded.
   *
   * Head-butler-via-flag: if `is_head_butler=1` we use head_butler defaults
   * regardless of staff_role (legacy head-butler rows often have role=
   * "personal"). Matches the authoritative "this is the CoS" semantic.
   */
  async seedMissingDefaults(): Promise<void> {
    const agents = await this.db
      .select({
        id: staffAgents.id,
        staffRole: staffAgents.staffRole,
        isHeadButler: staffAgents.isHeadButler,
      })
      .from(staffAgents);

    for (const agent of agents) {
      const effectiveRole = agent.isHeadButler ? "head_butler" : agent.staffRole;
      const defaults = DEFAULT_GRANTS[effectiveRole] ?? DEFAULT_GRANTS.custom;
      if (defaults.length === 0) continue;

      const settingKey = `grants_seeded:${agent.id}`;
      const [setting] = await this.db
        .select()
        .from(instanceSettings)
        .where(eq(instanceSettings.key, settingKey))
        .limit(1);
      const alreadySeeded: string[] = Array.isArray(setting?.value)
        ? (setting!.value as string[])
        : [];

      // Only seed tools this agent has never seen before. User-revoked
      // tools are in `alreadySeeded` so they don't get re-added.
      const toSeed = defaults.filter(
        (name) => !alreadySeeded.includes(name) && this.tools.has(name),
      );
      if (toSeed.length === 0) continue;

      // Insert grants idempotently — agent may already have some of these via
      // an earlier materializeDefaults pass; the unique index on
      // (agentId, toolName) makes the conflict a no-op.
      await this.db
        .insert(toolGrants)
        .values(
          toSeed.map((toolName) => ({
            agentId: agent.id,
            toolName,
            grantedBy: "system-seed",
          })),
        )
        .onConflictDoNothing();

      // Mark the FULL current defaults set as seeded, not just what we
      // inserted. That way a revocation of toSeed[k] between v0.4 and v0.5
      // doesn't get re-seeded at v0.5 — it stays in alreadySeeded forever.
      const newSeeded = [...new Set([...alreadySeeded, ...defaults])];
      if (setting) {
        await this.db
          .update(instanceSettings)
          .set({ value: newSeeded })
          .where(eq(instanceSettings.key, settingKey));
      } else {
        await this.db.insert(instanceSettings).values({
          id: crypto.randomUUID(),
          key: settingKey,
          value: newSeeded,
        });
      }

      console.log(
        `[tools] Seeded ${toSeed.length} default grant(s) for ${effectiveRole} agent ${agent.id}: ${toSeed.join(", ")}`,
      );
    }
  }

  /**
   * Materialize role defaults into tool_grants table.
   * Called on first explicit grant/revoke so toggling one tool
   * doesn't wipe out all the implicit role defaults.
   */
  private async materializeDefaults(agentId: string): Promise<void> {
    const existing = await this.db
      .select({ toolName: toolGrants.toolName })
      .from(toolGrants)
      .where(eq(toolGrants.agentId, agentId));

    if (existing.length > 0) return; // already materialized

    const [agent] = await this.db
      .select({ staffRole: staffAgents.staffRole })
      .from(staffAgents)
      .where(eq(staffAgents.id, agentId))
      .limit(1);

    const role = agent?.staffRole ?? "custom";
    const defaults = DEFAULT_GRANTS[role] ?? DEFAULT_GRANTS.custom;

    // Filter to only tools that are actually registered (skip system tools — they're implicit)
    const systemNames = new Set(
      [...this.tools.values()].filter((t) => t.tier === "system").map((t) => t.definition.name),
    );
    const toInsert = defaults.filter((name) => !systemNames.has(name) && this.tools.has(name));

    if (toInsert.length > 0) {
      await this.db
        .insert(toolGrants)
        .values(toInsert.map((toolName) => ({ agentId, toolName, grantedBy: null })))
        .onConflictDoNothing();
    }
  }

  async grant(agentId: string, toolName: string, grantedBy?: string): Promise<void> {
    const resolvedToolName = await this.resolveGrantToolName(agentId, toolName);
    if (!resolvedToolName) {
      throw new Error(`Tool "${toolName}" is not registered`);
    }
    await this.materializeDefaults(agentId);
    await this.db
      .insert(toolGrants)
      .values({ agentId, toolName: resolvedToolName, grantedBy: grantedBy ?? null })
      .onConflictDoNothing();
  }

  async revoke(agentId: string, toolName: string): Promise<void> {
    const resolvedToolName = await this.resolveGrantToolName(agentId, toolName);
    if (!resolvedToolName) {
      throw new Error(`Tool "${toolName}" is not registered`);
    }
    await this.materializeDefaults(agentId);
    await this.db
      .delete(toolGrants)
      .where(and(eq(toolGrants.agentId, agentId), eq(toolGrants.toolName, resolvedToolName)));
  }

  async listAgentGrants(agentId: string): Promise<string[]> {
    const tools = await this.getAgentTools(agentId);
    return tools.map((t) => t.name);
  }

  private async resolveGrantToolName(agentId: string, toolName: string): Promise<string | null> {
    if (this.tools.has(toolName)) return toolName;

    const [agent] = await this.db
      .select({ householdId: staffAgents.householdId })
      .from(staffAgents)
      .where(eq(staffAgents.id, agentId))
      .limit(1);

    if (!agent?.householdId) return null;

    const scopedName = customKey(agent.householdId, toolName);
    return this.tools.has(scopedName) ? scopedName : null;
  }
}
