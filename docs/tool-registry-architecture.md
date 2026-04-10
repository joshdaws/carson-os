# CarsonOS Tool Registry Architecture

Status: Proposed

Author: Claude Code (with input from Codex)

Date: 2026-04-09

## Summary

CarsonOS needs a tool registry: a metadata-first system that defines what tools exist,
which agents can use them, what side effects they carry, and how they integrate with
the existing governance pipeline (ConstitutionEngine, CarsonOversight, Dispatcher).

This document describes the unified tool type system, the registry design, how it
wires into the existing server architecture, and the phased build plan. It supersedes
the tool-related sections of `tool-extension-architecture.md` and
`tanstack-code-mode-for-carsonos.md`, which remain valid as long-term vision docs
but proposed overlapping type systems that need to converge.

## Background

### Current State

CarsonOS has five core services that form the execution pipeline:

1. **ConstitutionEngine** (`server/src/services/constitution-engine.ts`)
   Processes messages through hard/soft clause evaluation, compiles system prompts,
   executes via the adapter, scans responses, records conversations.

2. **TaskEngine** (`server/src/services/task-engine.ts`)
   Creates, approves, rejects, and executes tasks. Builds system prompts from
   agent soul + constitution clauses.

3. **CarsonOversight** (`server/src/services/carson-oversight.ts`)
   Decides whether a task should be auto-approved, escalated, or blocked based
   on constitution clauses and agent autonomy level (autonomous/trusted/supervised).

4. **Dispatcher** (`server/src/services/dispatcher.ts`)
   Execution orchestrator for internal agent tasks. Loads task and agent, enforces
   visibility and delegation depth, builds system prompt, calls `adapter.execute()`,
   parses progress/result, manages per-project queuing.

5. **DelegationOrchestrator** (`server/src/services/delegation-orchestrator.ts`)
   Coordinates delegation lifecycle: parses delegate blocks from agent responses,
   creates project/subtask trees, triggers dispatcher, synthesizes results.

Today, none of these services know about tools. The adapter interface
(`AdapterExecuteParams`) accepts `systemPrompt` and `messages` and returns
`content`. There is no tool registry, no tool definitions, no scope resolution,
and no tool-aware governance.

### Why This Matters Now

Without a tool registry:
- Agents cannot call structured operations (calendar, budget, profiles).
- The Dispatcher cannot filter tool access by agent role.
- CarsonOversight cannot gate approval based on tool side effects.
- There is no metadata-first foundation for future Code Mode execution.
- There is no path to the extension/package system described in the vision docs.

The tool registry is the prerequisite for every downstream capability.

### Design Influences

**Nate Jones: 12 Primitives from Claude Code Leak**
Claude Code uses two parallel registries (207 command entries user-facing, 184 tool
entries model-facing). Every entry carries name, source hint, and responsibility
description. Implementations load on demand. Tools are filtered into context-specific
pools per session. Three permission tiers: built-in (always available), plugin
(medium trust, can be disabled), skills (user-defined, lowest trust).

Key takeaway: metadata-first design. Define capabilities as data before any
implementation. The registry answers "what exists and what does it do" without
executing anything.

**Codex Extension Architecture (`docs/tool-extension-architecture.md`)**
Proposes four concepts: Connector, Tool, Skill, Extension. Tools defined via
`ToolManifest` with `runtime`, `grantedTo`, and `connectorId`. Extensions are
the install and distribution unit. Valid long-term model, but the `ToolManifest`
type is too weak for runtime governance (no side effect levels, no approval
policy, no audit config).

**Codex Code Mode Architecture (`docs/tanstack-code-mode-for-carsonos.md`)**
Proposes `CarsonToolDefinition` with `sideEffectLevel`, `approvalPolicy`,
`codeModeEnabled`, `auditEnabled`, `buildAuditPayload`, and `execute()`.
Strong runtime type, but embeds implementation (`execute()`) in the spec,
making it unsuitable as a distributable manifest.

**Convergence decision:** One canonical tool spec that serves both packaging
and runtime needs. The extension manifest wraps tool specs; it does not define
a competing tool type.

## Core Types

### CarsonToolSpec

The canonical definition for any tool in CarsonOS. Contains identity, schemas,
governance metadata, and audit configuration. Does not contain the implementation.

```ts
import { z } from "zod";

/**
 * Where the tool runs.
 *   host       -- TypeScript function in the server process
 *   mcp        -- MCP server tool call
 *   http       -- external HTTP API call
 *   shell      -- shell command execution (highest trust required)
 */
type ToolRuntime = "host" | "mcp" | "http" | "shell";

/**
 * Who can see the tool's existence.
 *   internal   -- only internal staff agents (tutor, coach, scheduler)
 *   family     -- visible to family-facing personal agents
 */
type ToolVisibility = "internal" | "family";

/**
 * What the tool does to the world.
 *   read             -- no mutations, no external calls
 *   write            -- mutates local state (DB, files)
 *   external_action  -- sends data outside the system (email, Telegram, API)
 */
type ToolSideEffectLevel = "read" | "write" | "external_action";

/**
 * When approval is required.
 *   never         -- always auto-approved (read-only tools)
 *   inherit_task  -- follows the task's approval state
 *   always        -- requires explicit parent approval every time
 */
type ApprovalPolicy = "never" | "inherit_task" | "always";

/**
 * How this tool behaves when a task is delegated to a subagent.
 *   inherit      -- subagent gets this tool if parent had it
 *   blocked      -- subagent never gets this tool (e.g., send_message, memory writes)
 *   root_only    -- only the root-level agent can use this tool (no delegation at any depth)
 */
type DelegationPolicy = "inherit" | "blocked" | "root_only";

/**
 * Trust level, independent of source/provenance.
 *   verified     -- reviewed and approved (core tools, manually vetted extensions)
 *   reviewed     -- scanned, no known issues (trusted community sources)
 *   unreviewed   -- not yet reviewed (new imports, agent-generated)
 */
type ToolTrustLevel = "verified" | "reviewed" | "unreviewed";

interface CarsonToolSpec<TInput = unknown, TOutput = unknown> {
  /** Stable dotted ID: "calendar.listEvents", "members.getProfile" */
  id: string;

  /** Model-facing name (may differ from id for readability) */
  name: string;

  /** Semver for tracking tool contract changes */
  version: string;

  /** One-line description included in model context */
  description: string;

  /** Zod schema for input validation */
  inputSchema: z.ZodType<TInput>;

  /** Zod schema for output validation (optional, useful for Code Mode) */
  outputSchema?: z.ZodType<TOutput>;

  // -- Governance metadata --

  visibility: ToolVisibility;
  sideEffectLevel: ToolSideEffectLevel;
  approvalPolicy: ApprovalPolicy;

  /** Staff roles that may use this tool (empty = all roles) */
  allowedStaffRoles?: StaffRole[];

  /** Specific agent IDs that may use this tool (empty = all agents) */
  allowedAgentIds?: string[];

  /** Member roles that may trigger this tool (empty = all members) */
  allowedMemberRoles?: MemberRole[];

  /** How this tool behaves in delegated subtasks (default: "inherit") */
  delegationPolicy?: DelegationPolicy;

  // -- Execution metadata --

  runtime: ToolRuntime;

  /** Whether this tool may be exposed inside sandboxed Code Mode execution */
  codeModeEnabled: boolean;

  // -- Audit metadata --

  /** Whether tool invocations should be recorded in task_events */
  auditEnabled: boolean;

  /**
   * Produces a safe audit payload from input/output.
   * Strips sensitive fields (tokens, passwords) before logging.
   */
  buildAuditPayload?: (args: TInput, result: TOutput) => unknown;

  // -- Provenance metadata (populated when tool comes from an extension) --

  /** Extension that owns this tool (e.g. "core/google-calendar") */
  extensionId?: string;

  /** Where the tool came from (provenance) */
  source?: "core" | "community" | "generated" | "imported";

  /**
   * Trust level, independent of source. A community tool can be "verified"
   * after manual review. A generated tool starts "unreviewed" until approved.
   * Influences approval thresholds and code-mode exposure.
   */
  trustLevel?: ToolTrustLevel;

  /** Connector this tool depends on (e.g. "google-calendar") */
  connectorId?: string;

  /** Tags for filtering in UI and scope resolution */
  tags?: string[];
}
```

### RegisteredTool

A `CarsonToolSpec` bound to an implementation. This is what lives in the registry
at runtime.

```ts
interface RegisteredTool<TInput = unknown, TOutput = unknown>
  extends CarsonToolSpec<TInput, TOutput> {
  /**
   * The actual implementation. Receives validated input and a context
   * object with household, task, agent, and execution mode info.
   */
  execute: (args: TInput, ctx: ToolExecutionContext) => Promise<TOutput>;
}
```

### ToolExecutionContext

Runtime context passed to every tool execution.

```ts
interface ToolExecutionContext {
  householdId: string;
  taskId: string;
  agentId: string;
  requestedBy?: string;
  assignedMemberIds?: string[];
  executionMode: "text_only" | "code_mode";
}
```

### ExecutionToolScope

The resolved set of tools available for a specific task execution. Computed
once before the task runs.

```ts
interface ExecutionToolScope {
  taskId: string;
  householdId: string;
  agentId: string;
  allowedTools: string[];           // tool IDs
  deniedTools: DeniedTool[];
  executionMode: "text_only" | "code_mode";
}

interface DeniedTool {
  id: string;
  reason: string;   // "role_mismatch", "visibility_mismatch", "approval_required", etc.
}
```

### Relationship to Extension Types

The extension manifest from `tool-extension-architecture.md` wraps `CarsonToolSpec[]`.
It does not define a competing tool type.

```ts
interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  source: "core" | "community" | "generated" | "imported";
  description?: string;
  connectors?: ConnectorManifest[];
  tools?: CarsonToolSpec[];         // <-- uses the canonical spec, not a separate type
  skills?: SkillManifest[];
}

interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  /**
   * Tools this skill depends on (advisory, NOT capability-granting).
   * Skills are prompt context that teaches the agent workflows.
   * They reference tools but never grant tool access.
   * Tool access comes only from scope resolution.
   */
  dependsOnToolIds?: string[];
  grantedTo: AgentRole[];
}
```

**Skills are prompt context, not tools.** This is a deliberate design decision
informed by OpenClaw (which separates skills as markdown documents from
executable tools) and Hermes (which uses progressive skill disclosure).
Skills teach agents how to use tools and compose workflows. They do not
grant tool access — that comes only from the scope resolution pipeline.

This means:
- Tools defined in code use `CarsonToolSpec` directly.
- Tools distributed via extensions use the same `CarsonToolSpec`.
- Skills reference tools but never grant them.
- The registry accepts both core and extension tools. No conversion layer needed.

## Registry Design

### Class: ToolRegistry

Injectable class instance, constructed at boot, passed to Dispatcher and
CarsonOversight. Follows the existing service pattern in `server/src/index.ts`.

```ts
class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  /** Register a tool. Throws on duplicate ID. Called at boot. */
  register(tool: RegisteredTool): void;

  /** Get a tool by ID. Returns undefined if not found. */
  getById(id: string): RegisteredTool | undefined;

  /** Get all registered tools. */
  getAll(): RegisteredTool[];

  /**
   * Resolve the tool scope for a task execution.
   *
   * Filters the full registry by:
   *   1. Agent staff role vs tool.allowedStaffRoles
   *   2. Agent ID vs tool.allowedAgentIds
   *   3. Agent visibility vs tool.visibility
   *   4. Tool approval policy vs task approval state
   *   5. Member role vs tool.allowedMemberRoles (if task has assignedToMembers)
   *
   * Returns an ExecutionToolScope with allowed/denied tool lists and reasons.
   */
  resolveScope(params: {
    agentId: string;
    agentStaffRole: StaffRole;
    agentVisibility: AgentVisibility;
    taskId: string;
    householdId: string;
    taskApproved: boolean;
    taskRequiresApproval: boolean;
    memberRoles?: MemberRole[];
    memberAges?: number[];
    executionMode?: "text_only" | "code_mode";
    /** For delegated subtasks: the parent task's persisted tool scope snapshot.
     *  Child scope is intersected with this ceiling. */
    parentScopeSnapshot?: string[];
    /** Delegation depth (0 = root task). Used for root_only delegation policy. */
    delegationDepth?: number;
  }): ExecutionToolScope;

  /**
   * Generate tool descriptions for inclusion in a system prompt.
   * Only includes tools from the resolved scope.
   */
  compileToolPrompt(scope: ExecutionToolScope): string;
}
```

### Why a Class Instance, Not a Module Singleton

The existing server boot sequence constructs services and injects dependencies:

```ts
// server/src/index.ts (current pattern)
const constitutionEngine = new ConstitutionEngine({ db, broadcast, adapter });
const taskEngine = new TaskEngine({ db, adapter, constitutionEngine, broadcast });
const oversight = new CarsonOversight({ db, constitutionEngine, broadcast });
const dispatcher = new Dispatcher({ db, adapter, broadcast });
```

The registry follows this pattern:

```ts
// Proposed addition to server/src/index.ts
const toolRegistry = new ToolRegistry();
registerCoreTools(toolRegistry, db);  // register built-in tools

const dispatcher = new Dispatcher({ db, adapter, broadcast, toolRegistry });
const oversight = new CarsonOversight({ db, constitutionEngine, broadcast, toolRegistry });
```

Benefits over a singleton:
- Tests can create isolated registries with controlled tool sets.
- Dev/test environments can register different tools.
- Future extension reload can swap registry contents without restarting.

### Registration Pattern

Tools register via a `defineTool()` helper that creates a `RegisteredTool` with
type inference from the Zod schemas.

```ts
// server/src/tools/define-tool.ts
function defineTool<TInput, TOutput>(
  spec: CarsonToolSpec<TInput, TOutput>,
  execute: (args: TInput, ctx: ToolExecutionContext) => Promise<TOutput>,
): RegisteredTool<TInput, TOutput> {
  return { ...spec, execute };
}
```

Tool files export their definitions and a `register()` function:

```ts
// server/src/tools/definitions/members.get-profile.ts
import { z } from "zod";
import { defineTool } from "../define-tool.js";

const inputSchema = z.object({
  memberId: z.string().uuid(),
});

const outputSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["parent", "kid"]),
  age: z.number(),
  profileContent: z.string().nullable(),
});

export const getMemberProfile = defineTool(
  {
    id: "members.getProfile",
    name: "get_member_profile",
    version: "1.0.0",
    description: "Get a family member's profile by ID. Returns name, role, age, and profile content.",
    inputSchema,
    outputSchema,
    visibility: "internal",
    sideEffectLevel: "read",
    approvalPolicy: "never",
    runtime: "host",
    codeModeEnabled: true,
    auditEnabled: false,
    allowedStaffRoles: ["personal", "tutor", "coach", "scheduler"],
  },
  async (args, ctx) => {
    const [member] = await ctx.db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, args.memberId));

    if (!member) throw new Error(`Member ${args.memberId} not found`);

    return {
      id: member.id,
      name: member.name,
      role: member.role as "parent" | "kid",
      age: member.age,
      profileContent: member.profileContent,
    };
  },
);
```

Note: the `ctx.db` access means `ToolExecutionContext` needs a `db` field, or tools
receive `db` via closure at registration time. The closure approach is cleaner
because it avoids leaking the database handle into every tool context:

```ts
// server/src/tools/definitions/members.get-profile.ts
export function register(registry: ToolRegistry, db: Db): void {
  registry.register(defineTool(
    { /* spec */ },
    async (args, ctx) => {
      // db is captured from the register() closure
      const [member] = await db.select()...
      return { ... };
    },
  ));
}
```

## Prerequisite: Single Execution Seam

Today there are **two** paths that call `adapter.execute()`:

1. **Dispatcher.executeTask()** (`dispatcher.ts:182`) -- for internal agent tasks
   dispatched via delegation or the task queue.
2. **TaskEngine.executeTask()** (`task-engine.ts:162`) -- for tasks executed via
   the REST API (manual trigger from the dashboard).

Both build their own system prompts and call the adapter directly. If the tool
registry only integrates with Dispatcher, manual task execution gets no scope
resolution, no tool descriptions in the prompt, and no tool audit trail.

**Resolution:** Before or during Phase 1, consolidate task execution into a
single path. Options:

a. **Route TaskEngine through Dispatcher.** `TaskEngine.executeTask()` calls
   `dispatcher.handleTaskAssignment()` instead of running its own adapter call.
   TaskEngine retains lifecycle management (create, approve, reject, list) but
   gives up execution.

b. **Extract a shared TaskExecutionRuntime.** Both Dispatcher and TaskEngine
   call through a shared runtime that handles scope resolution, prompt building,
   adapter execution, and audit logging.

Recommendation: Option (a). It is the smaller change. TaskEngine's `executeTask()`
already duplicates what Dispatcher does (load agent, build prompt, call adapter,
update status). Removing that duplication and routing through Dispatcher means
tool integration happens in exactly one place. TaskEngine becomes the lifecycle
service; Dispatcher becomes the execution service.

## Integration Points

### 1. Dispatcher (Sole Execution Path)

After the prerequisite consolidation, the tool registry fits into the
Dispatcher's `executeTask()` method at `dispatcher.ts:182-304`.

The current flow:
```
loadTask() -> loadAgent() -> buildSystemPrompt() -> adapter.execute()
```

The proposed flow adds scope resolution and tool prompt compilation:
```
loadTask() -> loadAgent() -> resolveToolScope() -> buildSystemPrompt(+tools) -> adapter.execute()
```

Specifically, between the agent load (`dispatcher.ts:187`) and the system prompt
build (`dispatcher.ts:198`):

```ts
private async executeTask(taskId, agent, slotKey) {
  const task = await this.loadTask(taskId);
  // ... existing null check, slot claim ...

  // NEW: Resolve tool scope for this task
  const toolScope = this.toolRegistry.resolveScope({
    agentId: agent.id,
    agentStaffRole: agent.staffRole,
    agentVisibility: agent.visibility,
    taskId,
    householdId: task.householdId,
    taskApproved: task.status === "approved",
    taskRequiresApproval: task.requiresApproval,
  });

  // NEW: Persist the approved scope snapshot on the task
  await this.db
    .update(tasks)
    .set({ toolScopeSnapshot: toolScope.allowedTools })
    .where(eq(tasks.id, taskId));

  // MODIFIED: Include tool descriptions in system prompt
  const systemPrompt = this.buildSystemPrompt(agent, task, toolScope);

  // ... rest unchanged (mark in_progress, adapter.execute(), parse result) ...
}
```

The `buildSystemPrompt()` method gains a new section:

```ts
private buildSystemPrompt(agent, task, toolScope: ExecutionToolScope): string {
  const parts: string[] = [];

  // ... existing: Agent Role, Agent Identity, Task Instructions ...

  // NEW: Available tools
  if (toolScope.allowedTools.length > 0) {
    parts.push("# Available Tools\n");
    parts.push(this.toolRegistry.compileToolPrompt(toolScope));
    parts.push("");
  }

  // ... existing: Output Format ...
  return parts.join("\n");
}
```

### 2. CarsonOversight (Governance Integration)

Today, CarsonOversight decides approval based on:
- Constitution hard clauses vs. task text (`oversight.ts:72-130`)
- Agent autonomy level (`oversight.ts:132-172`)

It does not consider what tools a task will use.

**Important design constraint:** Oversight must govern the *approved* tool
subset, not the agent's entire reachable set. If an agent has access to 15
tools and only 3 are relevant to a given task, the approval decision should
be based on those 3, not on the existence of a write tool somewhere in the
full registry that the task will never use.

**Scope snapshot model:** When Oversight approves a task, the resolved tool
scope is persisted as a snapshot on the task record. The Dispatcher executes
only against that snapshot. If the registry changes after approval, the task's
tool access does not silently widen.

For Phase 1 (read-only tools only), the scope snapshot is informational.
For Phase 2+ (write tools), it becomes a governance boundary.

```ts
async reviewTask(taskId: string): Promise<ReviewResult> {
  // ... existing: load task, load agent, check hard clauses ...

  // NEW: Resolve the tool scope for this task (pre-approval)
  const toolScope = this.toolRegistry.resolveScope({
    agentId: agent.id,
    agentStaffRole: agent.staffRole,
    agentVisibility: agent.visibility,
    taskId,
    householdId: task.householdId,
    taskApproved: false,
    taskRequiresApproval: task.requiresApproval,
  });

  // Check for tools that always require approval
  const alwaysApproveTools = toolScope.allowedTools
    .map((id) => this.toolRegistry.getById(id))
    .filter((t) => t && t.approvalPolicy === "always");

  if (alwaysApproveTools.length > 0) {
    return {
      approved: false,
      reason: `Task includes tools requiring explicit approval: ${alwaysApproveTools.map((t) => t!.name).join(", ")}`,
    };
  }

  // Check for write/external tools under trusted agents
  const writeTools = toolScope.allowedTools
    .map((id) => this.toolRegistry.getById(id))
    .filter((t) => t && t.sideEffectLevel !== "read");

  // ... existing: check agent autonomy level ...
  case "trusted":
    if (task.requiresApproval || writeTools.length > 0) {
      return {
        approved: false,
        reason: writeTools.length > 0
          ? `Task uses write tools: ${writeTools.map((t) => t!.name).join(", ")}`
          : "Task requires parental approval (trusted agent)",
      };
    }
    return { approved: true, reason: "Trusted agent, read-only tools" };
}
```

**Delegated subtask gap:** The DelegationOrchestrator creates subtasks with
`requiresApproval: false` (`delegation-orchestrator.ts:170`). This means
delegated work currently bypasses oversight entirely. With the tool registry,
delegated subtasks should have their scope resolved at dispatch time and
persisted as a snapshot. If any write/external_action tool enters the
delegated scope, the subtask should be flagged for review. This is a Phase 2
deliverable.

### 3. Adapter Interface

**Phase 1 (no adapter changes):** Tools are described in the system prompt as
text instructions, and tool calls are parsed from the model's text response
using XML tags. This follows the existing pattern of `<progress>` and
`<result>` tag parsing in the Dispatcher. The adapter interface is unchanged.

The Dispatcher gains a `parseToolCalls()` method:

```ts
private parseToolCalls(content: string): ParsedToolCall[] {
  // Parses: <tool_call name="get_member_profile">{"memberId": "abc"}</tool_call>
  // Returns: [{ name: "get_member_profile", args: { memberId: "abc" } }]
}
```

When a tool call is parsed, the Dispatcher:
1. Validates the tool exists in the scope snapshot.
2. Validates the input against the tool's Zod schema.
3. Executes the tool.
4. Injects the result back as a follow-up message and re-calls the adapter.

**Phase 3 (native tool-calling):** The `AdapterExecuteParams` interface extends
with an optional `tools` field:

```ts
interface AdapterExecuteParams {
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
  tools?: Array<{         // NEW, optional (Phase 3)
    name: string;
    description: string;
    input_schema: unknown;
  }>;
}
```

The Anthropic SDK adapter sends tools natively via the Messages API.
Claude Code and Codex adapters continue using text-based tool calls.

### 4. EventBus + Audit Trail

Tool invocations should produce `task_events` entries. The Dispatcher already
has `logEvent()` (`dispatcher.ts:502-522`). Tool calls add a new event type:

```ts
await this.logEvent(taskId, "tool_call", agentId, `Called ${tool.name}`, {
  toolId: tool.id,
  args: tool.auditEnabled && tool.buildAuditPayload
    ? tool.buildAuditPayload(args, result)
    : undefined,
  success: true,
  durationMs: elapsed,
});
```

The existing `TaskEventType` union in `packages/shared/src/index.ts` gains
`"tool_call"` and `"tool_error"`.

## Scope Resolution Algorithm

The `resolveScope()` method applies filters in order. A tool is denied if it
fails any filter. The first failing filter determines the denial reason.

```
For each registered tool:
  1. VISIBILITY CHECK
     tool.visibility must be compatible with agent visibility.
     "internal" tools: agent.visibility must be "internal".
     "family" tools: available to both internal and family agents.
     Deny reason: "visibility_mismatch"

  2. STAFF ROLE CHECK
     If tool.allowedStaffRoles is non-empty,
     agent.staffRole must be in the list.
     Deny reason: "role_mismatch"

  3. AGENT ID CHECK
     If tool.allowedAgentIds is non-empty,
     agent.id must be in the list.
     Deny reason: "agent_not_allowed"

  4. MEMBER ROLE CHECK
     If tool.allowedMemberRoles is non-empty AND the task has assignedToMembers,
     ALL assigned members' roles must be in the list.
     (Strict: if one assigned member is a kid, kid-restricted tools are denied.)
     Deny reason: "member_role_mismatch"

  5. CODE MODE CHECK
     If executionMode is "code_mode" and tool.codeModeEnabled is false,
     deny the tool.
     Deny reason: "code_mode_disabled"

  6. CONNECTOR CHECK (Phase 5+, no-op until extensions exist)
     If tool.connectorId is set, verify the connector is installed and enabled.
     Deny reason: "connector_not_configured"

  7. DELEGATION POLICY CHECK (for subtasks only, when parentScopeSnapshot is provided)
     If tool.delegationPolicy is "blocked", deny with reason "delegation_blocked".
     If tool.delegationPolicy is "root_only" and delegationDepth > 0,
     deny with reason "root_only".
     If tool.id is not in parentScopeSnapshot,
     deny with reason "outside_parent_scope".

  8. TRUST LEVEL CHECK (for write/external_action tools from non-core sources)
     If tool.trustLevel is "unreviewed" and tool.sideEffectLevel is not "read",
     deny with reason "unreviewed_write_tool".
     (Unreviewed read-only tools are allowed. Unreviewed write tools
     require explicit review before they enter any scope.)

  9. APPROVAL POLICY CHECK
     If tool.approvalPolicy is "always" and task is not approved,
     deny with reason "approval_required".
     If tool.approvalPolicy is "inherit_task" and task.requiresApproval
     and task is not approved, deny with reason "task_approval_required".
     (tool.approvalPolicy "never" always passes this check.)

Result: { allowedTools: [...ids], deniedTools: [...{id, reason}] }
```

**Scope snapshot persistence:** After scope resolution, the resulting
`allowedTools` array is persisted on the task record as `toolScopeSnapshot`.
At execution time, the Dispatcher verifies that any tool call is present in
the snapshot. This prevents scope widening between approval and execution.

## File Layout

```
server/src/tools/
  types.ts              -- CarsonToolSpec, RegisteredTool, ToolExecutionContext,
                           ExecutionToolScope, DeniedTool
  define-tool.ts        -- defineTool() helper with type inference
  registry.ts           -- ToolRegistry class
  register-core.ts      -- registerCoreTools() function, imports all definitions
  definitions/
    members.get-profile.ts
    members.list.ts
    tasks.list.ts
    tasks.get.ts
    calendar.list-events.ts   (when calendar connector exists)
```

Why this layout:
- `types.ts` is importable by any service without pulling in implementations.
- `define-tool.ts` is a tiny helper, separate from the registry class.
- `registry.ts` is the registry class with no tool implementations.
- `register-core.ts` is the only file that imports all tool definitions.
  Adding a new tool means: create a definition file, add one import line.
- `definitions/` contains one file per tool. Files are self-contained.

## Data Model Additions

### Immediate (Phase 1)

Add `toolScopeSnapshot` column to `tasks` table in `packages/db/src/schema.ts`:

```ts
// New column on `tasks` table
toolScopeSnapshot: text("tool_scope_snapshot", { mode: "json" }),  // string[] of tool IDs
```

Add to `TaskEventType` in `packages/shared/src/index.ts`:

```ts
export type TaskEventType =
  | "created" | "assigned" | "approved" | "rejected"
  | "started" | "progress_update" | "delegated"
  | "completed" | "failed" | "synthesis_requested"
  | "tool_call" | "tool_error";  // NEW
```

### Phase 2 Additions

Add `executionMode` and `executionBackend` columns to `tasks` table:

```ts
executionMode: text("execution_mode"),      // "text_only" | "code_mode"
executionBackend: text("execution_backend"), // "claude-code" | "codex" | "anthropic-sdk"
```

The `task_events.payload` column (JSON) already supports arbitrary data.
Tool call records use the existing column:

```ts
// task_events.payload for tool_call events
{
  toolId: "members.getProfile",
  toolName: "get_member_profile",
  args: { memberId: "abc-123" },   // from buildAuditPayload, may be redacted
  success: true,
  durationMs: 45,
}
```

### Deferred (Phase 3+)

When audit trails need richer querying:

```sql
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  tool_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  args_summary TEXT,        -- JSON, redacted
  result_summary TEXT,      -- JSON, redacted
  success INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
```

## Build Phases

### Phase 1: Registry + Single Execution Seam + First Tools

**Goal:** A working tool registry with 3-5 read-only tools, a single execution
path through Dispatcher, and scope resolution.

Deliverables:
- Consolidate execution: remove `TaskEngine.executeTask()`, route through Dispatcher
- `server/src/tools/types.ts`
- `server/src/tools/define-tool.ts`
- `server/src/tools/registry.ts`
- `server/src/tools/register-core.ts`
- 3-5 tool definitions in `server/src/tools/definitions/`
- Registry injected into Dispatcher
- Scope resolution in `Dispatcher.executeTask()`
- Tool descriptions compiled into system prompts
- `tool_call` and `tool_error` event types in shared types
- `toolScopeSnapshot` field on tasks table

First tools (all read-only, internal, `approvalPolicy: "never"`):
1. `members.getProfile` -- get a member's profile
2. `members.list` -- list all family members
3. `tasks.list` -- list tasks for a household
4. `tasks.get` -- get a single task's details
5. `household.getInfo` -- get household name, timezone, member count

Tool invocation in Phase 1: text-based via XML tags in the system prompt
instructions. The model emits `<tool_call>` tags, the Dispatcher parses
them, executes the tool, and injects the result back into the conversation.
This works across all three adapter types (claude-code, codex, anthropic-sdk)
and avoids coupling to any specific adapter's native tool-use API.

### Phase 2: Oversight Integration + Scope Snapshots + Audit

**Goal:** CarsonOversight considers tool side effects in approval decisions.
Approved scope is persisted and enforced at execution time.

Deliverables:
- Oversight.reviewTask() checks tool scope for write/external_action tools
- Oversight.reviewTask() enforces `approvalPolicy: "always"` tools
- Scope snapshot persisted on task approval, enforced at execution time
- Delegated subtask tool scope review (flag write tools for review)
- First write tool (e.g., `tasks.updateStatus`)
- Audit trail logging for tool calls in task_events
- `execution_mode` and `execution_backend` fields on tasks table

### Phase 3: Native Adapter Tool-Calling

**Goal:** Native tool use through the Anthropic SDK adapter for better
reliability and structured tool call/result handling.

Deliverables:
- `AdapterExecuteParams.tools` optional field
- AnthropicSdkAdapter sends tools to the Messages API
- Tool call/result message handling in the conversation loop
- Tool execution inside the adapter response handler
- Claude Code and Codex adapters continue using text-based tool calls

### Phase 4: Code Mode Execution Runtime

**Goal:** A sandboxed TypeScript execution mode as an alternative to text-only.

Deliverables:
- `TaskExecutionRuntime` interface (from the Code Mode doc)
- `text_only` runtime wrapping current adapter behavior
- `code_mode` runtime with sandboxed TypeScript execution
- Dispatcher selects execution mode per task
- Sandbox requirements: no host filesystem, no network, strict timeouts

### Phase 5: Extension Packaging

**Goal:** Tools can be packaged, installed, and loaded from disk.

Deliverables:
- `ExtensionManifest` type (wraps `CarsonToolSpec[]`)
- Extension loader (scans `~/.carson/extensions/`)
- Extension installer with enabled/disabled state
- Settings UI for installed extensions
- Generated extension flow (head agent creates tools)
- Extension-level trust tiers (core, community, generated, imported)

### Phase 6: External Imports

**Goal:** Import tools from `skills.sh` and other ecosystems.

Deliverables:
- Import pipeline (fetch, parse, normalize, install)
- `skills.sh` importer
- Import trust levels (skill-only, tool wrapper, raw runtime)
- Install review UX

## What This Document Does NOT Cover

- **Constitution enforcement changes.** The ConstitutionEngine's clause evaluation
  pipeline is orthogonal to tool registration. Tools are governed at the Dispatcher
  and Oversight level, not at the clause evaluation level.

- **Connector configuration.** How users configure OAuth tokens, API keys, or
  service accounts for connectors. That is an extension-layer concern (Phase 5+).

- **TanStack AI specifics.** Whether Code Mode uses TanStack AI directly or a
  custom sandbox. That is an implementation detail of Phase 4.

- **UI design.** How tools appear in the Settings dashboard or activity feed.

## Open Questions

1. **Tool call parsing in text mode.** Before native adapter tool use (Phase 3),
   how should agents invoke tools? Options:
   a. XML tags in response: `<tool_call name="get_member_profile">{"memberId": "..."}</tool_call>`
   b. Function-call syntax in the system prompt instructions
   c. Skip text-mode tool calls entirely; go straight to Anthropic SDK tool use

   Recommendation: Option (a). XML tag parsing. This preserves adapter neutrality
   across all three adapters (claude-code, codex, anthropic-sdk) and follows the
   existing pattern of `<progress>` and `<result>` tag parsing already in the
   Dispatcher. The Dispatcher gains a `parseToolCalls()` method alongside
   `parseProgress()` and `parseResult()`. When Phase 3 adds native tool-calling
   to the Anthropic SDK adapter, the text-based path remains as a fallback for
   Claude Code and Codex adapters.

2. **Tool execution context: db access.** Should tools receive `db` in
   `ToolExecutionContext`, or capture it via closure at registration time?

   Recommendation: Closure. Tools capture `db` when `register()` is called.
   `ToolExecutionContext` stays focused on request-scoped data (householdId,
   taskId, agentId). This prevents tools from accessing arbitrary tables and
   makes the context interface stable.

3. **Per-tool vs. per-task approval.** The `approvalPolicy` field is per-tool,
   but approval currently happens per-task. If a task uses 10 tools and one
   requires approval, does the whole task require approval?

   Recommendation: Yes, but scoped to the resolved tool subset. If any tool
   in the task's resolved scope has `approvalPolicy: "always"`, the task
   requires approval. The approval decision is based on the tools the task
   will actually have access to (per scope resolution), not the agent's
   entire reachable set. Once approved, the scope is persisted as a snapshot
   and the task executes only against that snapshot. This prevents scope
   widening and matches the existing CarsonOversight design where approval
   is binary per-task.

4. **Tool versioning.** The `version` field exists on `CarsonToolSpec` but there
   is no versioning strategy. When should it bump? What breaks?

   Recommendation: Defer. Version the field, don't version the strategy. Useful
   metadata for future extension packaging but not load-bearing in Phase 1-3.

## Cross-System Analysis

This architecture was informed by analysis of three reference systems:
OpenClaw, Paperclip, and Hermes Agent. Each was reviewed at the source
code level and discussed with Codex. Key decisions and their origins:

### Adopted Patterns

| Pattern | Source | How it appears in CarsonOS |
|---|---|---|
| Metadata-first tool registry | Claude Code (via Nate Jones), Hermes | `CarsonToolSpec` defines capabilities as data before implementation |
| Skills are prompt context, not tools | OpenClaw | `SkillManifest.dependsOnToolIds` is advisory, never capability-granting |
| Parent-child toolset intersection | Hermes | `resolveScope()` accepts `parentScopeSnapshot` as ceiling for subtasks |
| Delegation-blocked tools | Hermes | `delegationPolicy: "blocked" \| "root_only"` on `CarsonToolSpec` |
| Trust level separate from source | Codex recommendation | `trustLevel` (verified/reviewed/unreviewed) independent of `source` |
| Injectable class registry | Codex recommendation | `ToolRegistry` class instance, not module singleton (contra Hermes) |
| Scope snapshots | Codex recommendation | Approved tool scope persisted on task, enforced at execution time |

### Deliberately Avoided Patterns

| Pattern | Source | Why avoided |
|---|---|---|
| 7-layer policy pipeline | OpenClaw | Too much machinery for current stage. 9-filter scope resolution is enough. |
| Global tool access for all agents | Paperclip | Per-task scope resolution is better for family governance. |
| Module-level singleton registry | Hermes | Injectable class is better for testing and future extension reload. |
| Out-of-process plugin isolation | Paperclip | Reserve for Phase 5-6 imported/community extensions. In-process is fine for core. |
| Agent-editable skills at runtime | Hermes | Should be head-of-household only, gated through CarsonOversight. |

### What CarsonOS Does Differently

None of these systems have a **constitution-governed** tool access layer.
OpenClaw has deny-lists. Paperclip has capability declarations. Hermes has
toolset composition and command approval. But none have a household
constitution that says "this family doesn't allow agents to send external
messages without parental approval" and a scope snapshot model that prevents
post-approval scope widening.

The `CarsonOversight` + `toolScopeSnapshot` + `delegationPolicy` combination
is the unique architectural contribution.

## Bottom Line

The tool registry is the foundation for every downstream capability: Code Mode,
extensions, imports, generated tools. Build it small, wire it into the existing
services, prove it with read-only tools, then layer on governance, native tool
calling, and packaging in that order.

One canonical type (`CarsonToolSpec`). One registry (`ToolRegistry`). One scope
resolver. Everything else derives from that.
