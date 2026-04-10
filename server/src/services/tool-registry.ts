/**
 * Tool Registry — central registry of all tools available in CarsonOS.
 *
 * Tools are registered at boot time (built-ins like memory) or dynamically
 * (installed skills, generated scripts). Each agent gets a subset of tools
 * based on their grants in the tool_grants table.
 *
 * This is the same pattern as mr-carson's allowedTools + tool policies.
 */

import { eq } from "drizzle-orm";
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
  ],
  personal: [
    "search_memory", "save_memory", "delete_memory", "update_instructions",
  ],
  tutor: [
    "search_memory", "save_memory", "update_instructions",
  ],
  coach: [
    "search_memory", "save_memory", "update_instructions",
  ],
  scheduler: [
    "search_memory", "save_memory", "update_instructions",
  ],
  custom: [
    "search_memory", "update_instructions",
  ],
};

// ── Registry ───────────────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
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

  /** Register a custom tool (for future: installed skills, generated scripts). */
  register(tool: RegisteredTool): void {
    this.tools.set(tool.definition.name, tool);
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
      // Explicit grants exist — use them
      grantedNames = grants.map((g) => g.toolName);
    } else {
      // No explicit grants — use role defaults
      const [agent] = await this.db
        .select({ staffRole: staffAgents.staffRole })
        .from(staffAgents)
        .where(eq(staffAgents.id, agentId))
        .limit(1);

      const role = agent?.staffRole ?? "custom";
      grantedNames = DEFAULT_GRANTS[role] ?? DEFAULT_GRANTS.custom;
    }

    // Resolve to registered tool definitions
    return grantedNames
      .map((name) => this.tools.get(name)?.definition)
      .filter((d): d is ToolDefinition => d !== undefined);
  }

  /**
   * Build a tool executor for an agent's granted tools.
   * Returns the executor function + a log array for activity tracking.
   */
  async buildExecutor(
    ctx: ToolExecutionContext,
  ): Promise<{
    tools: ToolDefinition[];
    executor: ToolExecutor;
    calls: Array<{ name: string; input: Record<string, unknown>; result: ToolResult }>;
  } | null> {
    if (!ctx.memoryProvider) return null;

    const tools = await this.getAgentTools(ctx.agentId);
    if (tools.length === 0) return null;

    // Build the memory tool executor (handles all current tools)
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

    return {
      tools,
      executor: built.executor,
      calls: built.calls,
    };
  }

  // ── Grant management ──────────────────────────────────────────────

  /** Grant a tool to an agent. */
  async grant(agentId: string, toolName: string, grantedBy?: string): Promise<void> {
    if (!this.tools.has(toolName)) {
      throw new Error(`Tool "${toolName}" is not registered`);
    }

    await this.db
      .insert(toolGrants)
      .values({
        agentId,
        toolName,
        grantedBy: grantedBy ?? null,
      })
      .onConflictDoNothing();
  }

  /** Revoke a tool from an agent. */
  async revoke(agentId: string, toolName: string): Promise<void> {
    const { and } = await import("drizzle-orm");
    await this.db
      .delete(toolGrants)
      .where(
        and(
          eq(toolGrants.agentId, agentId),
          eq(toolGrants.toolName, toolName),
        ),
      );
  }

  /** List an agent's granted tools (explicit or default). */
  async listAgentGrants(agentId: string): Promise<string[]> {
    const tools = await this.getAgentTools(agentId);
    return tools.map((t) => t.name);
  }
}
