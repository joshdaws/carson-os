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
import { toolGrants, staffAgents } from "@carsonos/db";
import type {
  ToolDefinition,
  ToolExecutor,
  ToolResult,
  MemoryProvider,
} from "@carsonos/shared";
import {
  MEMORY_TOOLS,
  buildToolExecutor,
  type ToolContext,
} from "./memory/index.js";

// ── Types ──────────────────────────────────────────────────────────

/** A tool handler takes (name, input) and returns a ToolResult. */
export type ToolHandler = (
  name: string,
  input: Record<string, unknown>,
) => Promise<ToolResult>;

/**
 * Tool tiers:
 *   - system:     Every agent gets these automatically, not toggleable (search_memory, update_instructions)
 *   - builtin:    Ships with CarsonOS, toggleable per-agent (calendar, gmail, drive)
 *   - custom:     Created by agents, imported from skills.sh, or user-installed
 *   - discovered: Found in ~/.claude/skills/, off by default, labeled in UI as global Claude skills
 */
export type ToolTier = "system" | "builtin" | "custom" | "discovered";

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

const DEFAULT_GRANTS: Record<string, string[]> = {
  head_butler: [
    "search_memory", "save_memory", "delete_memory", "update_instructions",
    "list_calendar_events", "create_calendar_event", "get_calendar_event",
    "gmail_triage", "gmail_read", "gmail_compose", "gmail_reply", "gmail_update_draft", "gmail_send_draft", "gmail_search",
    "drive_search", "drive_list",
  ],
  personal: [
    "search_memory", "save_memory", "delete_memory", "update_instructions",
    "list_calendar_events", "create_calendar_event", "get_calendar_event",
    "gmail_triage", "gmail_read", "gmail_compose", "gmail_reply", "gmail_update_draft", "gmail_send_draft", "gmail_search",
    "drive_search", "drive_list",
  ],
  tutor: [
    "search_memory", "save_memory", "update_instructions",
    "list_calendar_events",
    "drive_search",
  ],
  coach: [
    "search_memory", "save_memory", "update_instructions",
    "list_calendar_events",
  ],
  scheduler: [
    "search_memory", "save_memory", "update_instructions",
    "list_calendar_events", "create_calendar_event", "get_calendar_event",
    "gmail_triage", "gmail_read", "gmail_search",
  ],
  custom: [
    "search_memory", "update_instructions",
  ],
};

// ── Registry ───────────────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  handlers = new Map<string, ToolHandler>(); // toolName → handler (public for per-member binding)
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    this.registerBuiltins();
  }

  /** Register all built-in tools (memory, operating instructions). */
  private registerBuiltins(): void {
    // System tools — every agent gets these, not toggleable
    const systemTools = ["search_memory", "save_memory", "update_memory", "delete_memory", "update_instructions"];
    for (const def of MEMORY_TOOLS) {
      this.tools.set(def.name, {
        definition: def,
        category: "memory",
        tier: systemTools.includes(def.name) ? "system" : "builtin",
      });
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
    // System tools — every agent gets these, always
    const systemTools = [...this.tools.values()]
      .filter((t) => t.tier === "system")
      .map((t) => t.definition.name);

    // Check for explicit grants (builtin + custom tools)
    const grants = await this.db
      .select({ toolName: toolGrants.toolName })
      .from(toolGrants)
      .where(eq(toolGrants.agentId, agentId));

    let grantedNames: string[];

    if (grants.length > 0) {
      // Explicit grants exist — use them + system tools
      grantedNames = [...new Set([...systemTools, ...grants.map((g) => g.toolName)])];
    } else {
      // No explicit grants — use role defaults (which already include system tools)
      const [agent] = await this.db
        .select({ staffRole: staffAgents.staffRole })
        .from(staffAgents)
        .where(eq(staffAgents.id, agentId))
        .limit(1);

      const role = agent?.staffRole ?? "custom";
      grantedNames = [...new Set([...systemTools, ...(DEFAULT_GRANTS[role] ?? DEFAULT_GRANTS.custom)])];
    }

    // Only return tools that are actually registered
    return grantedNames
      .map((name) => this.tools.get(name)?.definition)
      .filter((d): d is ToolDefinition => d !== undefined);
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

      // Fall back to memory executor for memory + system tools
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
    if (!this.tools.has(toolName)) {
      throw new Error(`Tool "${toolName}" is not registered`);
    }
    await this.materializeDefaults(agentId);
    await this.db
      .insert(toolGrants)
      .values({ agentId, toolName, grantedBy: grantedBy ?? null })
      .onConflictDoNothing();
  }

  async revoke(agentId: string, toolName: string): Promise<void> {
    await this.materializeDefaults(agentId);
    await this.db
      .delete(toolGrants)
      .where(and(eq(toolGrants.agentId, agentId), eq(toolGrants.toolName, toolName)));
  }

  async listAgentGrants(agentId: string): Promise<string[]> {
    const tools = await this.getAgentTools(agentId);
    return tools.map((t) => t.name);
  }
}
