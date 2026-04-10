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

export interface RegisteredTool {
  definition: ToolDefinition;
  /** Category for grouping in UI / access control */
  category: string;
  /** Whether this tool is a built-in (always available) or installed */
  builtin: boolean;
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
    for (const def of MEMORY_TOOLS) {
      this.tools.set(def.name, {
        definition: def,
        category: def.name === "update_instructions" ? "system" : "memory",
        builtin: true,
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

  /** List tool names by category. */
  listByCategory(category: string): RegisteredTool[] {
    return [...this.tools.values()].filter((t) => t.category === category);
  }

  // ── Per-agent resolution ──────────────────────────────────────────

  /**
   * Get the tool definitions an agent is granted access to.
   * Checks tool_grants table first; falls back to role defaults
   * if no explicit grants exist.
   */
  async getAgentTools(agentId: string): Promise<ToolDefinition[]> {
    // Check for explicit grants
    const grants = await this.db
      .select({ toolName: toolGrants.toolName })
      .from(toolGrants)
      .where(eq(toolGrants.agentId, agentId));

    let grantedNames: string[];

    if (grants.length > 0) {
      grantedNames = grants.map((g) => g.toolName);
    } else {
      const [agent] = await this.db
        .select({ staffRole: staffAgents.staffRole })
        .from(staffAgents)
        .where(eq(staffAgents.id, agentId))
        .limit(1);

      const role = agent?.staffRole ?? "custom";
      grantedNames = DEFAULT_GRANTS[role] ?? DEFAULT_GRANTS.custom;
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

  async grant(agentId: string, toolName: string, grantedBy?: string): Promise<void> {
    if (!this.tools.has(toolName)) {
      throw new Error(`Tool "${toolName}" is not registered`);
    }
    await this.db
      .insert(toolGrants)
      .values({ agentId, toolName, grantedBy: grantedBy ?? null })
      .onConflictDoNothing();
  }

  async revoke(agentId: string, toolName: string): Promise<void> {
    await this.db
      .delete(toolGrants)
      .where(and(eq(toolGrants.agentId, agentId), eq(toolGrants.toolName, toolName)));
  }

  async listAgentGrants(agentId: string): Promise<string[]> {
    const tools = await this.getAgentTools(agentId);
    return tools.map((t) => t.name);
  }
}
