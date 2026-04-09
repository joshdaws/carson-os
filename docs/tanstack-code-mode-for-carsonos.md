# TanStack AI Code Mode for CarsonOS

Status: Proposed

Author: Codex

Date: 2026-04-09

## Summary

CarsonOS should adopt a Code Mode style runtime for approved internal agent work, not for the entire product.

The core idea is:

- CarsonOS remains the governance system.
- The constitution still decides what is allowed.
- Carson oversight still decides what requires approval.
- A Code Mode runtime executes approved multi-step tool work inside a sandbox.

This lets internal staff agents write short TypeScript programs that compose tools, batch calls, transform results, and perform correct arithmetic without turning CarsonOS into a general-purpose agent shell.

## Why This Is Worth Considering

TanStack AI Code Mode packages a useful pattern: instead of having a model call many tools one by one, the model writes a short TypeScript program and runs it in a sandbox through a single `execute_typescript` tool. The runtime handles loops, `Promise.all`, filtering, reduction, and math more reliably than the model can in-token.

That is attractive for CarsonOS because the product already has a clean separation between:

- chat/policy ingress
- task creation and approval
- internal staff task execution

CarsonOS does not need Code Mode to become "more agentic." It needs it to make internal task execution more capable and more reliable.

## Product Fit

### Good fit

- Internal specialist work where multiple tools must be composed.
- Read-heavy planning and analysis tasks.
- Work that needs batching, ranking, aggregation, date math, or structured transformations.
- Future staff tools such as calendar analysis, study plan generation, household schedule construction, or task triage.

### Bad fit

- Constitution enforcement.
- Parent/kid chat ingress.
- The rule evaluation pipeline.
- Open-ended family-visible tool use.
- Any execution path that bypasses approval rules or audit logging.

The product promise of CarsonOS is governed household staff. Code Mode should make staff better at work, not weaken governance.

## Decision

Adopt a CarsonOS tool runtime that can support TanStack AI Code Mode or an equivalent "execute typed sandboxed code" backend.

Do not make TanStack AI the center of the system.

The center of the system remains:

- `ConstitutionEngine`
- `TaskEngine`
- `CarsonOversight`
- `Dispatcher`
- `DelegationOrchestrator`

Code Mode becomes an execution strategy for internal tasks after CarsonOS has already decided that the work is allowed.

## Architectural Position

### Current CarsonOS execution model

Today, CarsonOS roughly does this:

1. A family-visible or internal agent receives a message or task.
2. `ConstitutionEngine` enforces hard rules and compiles soft rules.
3. `TaskEngine` creates and tracks work.
4. `CarsonOversight` approves or blocks governed actions.
5. `Dispatcher` executes internal work through the current adapter interface.
6. `DelegationOrchestrator` handles parent/child task relationships and synthesis.

This is the correct control flow.

### Proposed execution model

Add a new internal execution layer between `Dispatcher` and the current adapter runtime:

1. `Dispatcher` loads the task and its approved tool scope.
2. `Dispatcher` chooses an execution strategy:
   - `text_only`
   - `code_mode`
3. For `code_mode`, CarsonOS creates a sandbox with a governed set of tools.
4. The model writes TypeScript against those typed tools.
5. The runtime executes the program in isolation.
6. CarsonOS captures:
   - tool invocations
   - execution result
   - execution timing
   - any writes or external actions
7. CarsonOS stores those records in task and activity events.

Code Mode is therefore an execution backend, not a new policy layer.

## Core Principle

Tool availability in CarsonOS must be a governance decision first and a runtime convenience second.

TanStack's `toolDefinition()` shape is useful, but CarsonOS needs a richer manifest that includes policy metadata. The manifest should be the source of truth, and TanStack tool definitions should be generated from it.

## Proposed Tool Manifest

Each tool should have two layers:

- execution contract
- governance contract

### Type shape

```ts
import { z } from "zod";

type ToolVisibility = "family" | "internal";
type ToolSideEffectLevel = "read" | "write" | "external_action";
type ApprovalPolicy = "never" | "task_level" | "always";

interface CarsonToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  version: string;

  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;

  visibility: ToolVisibility;
  sideEffectLevel: ToolSideEffectLevel;
  approvalPolicy: ApprovalPolicy;

  allowedStaffRoles?: string[];
  allowedAgentIds?: string[];
  allowedMemberRoles?: string[];

  // Whether this tool may be exposed to TypeScript code execution.
  codeModeEnabled: boolean;

  // Whether tool calls should be recorded in task_events/activity_log.
  auditEnabled: boolean;

  // Produces a safe audit payload from input/output.
  buildAuditPayload?: (args: TInput, result: TOutput) => unknown;

  // Final runtime implementation.
  execute: (args: TInput, ctx: CarsonToolContext) => Promise<TOutput>;
}

interface CarsonToolContext {
  householdId: string;
  taskId: string;
  agentId: string;
  requestedBy?: string;
  assignedMemberIds?: string[];
  executionMode: "text_only" | "code_mode";
}
```

### Why this matters

This lets CarsonOS answer four different questions cleanly:

1. Can this tool exist?
2. Can this agent use it?
3. Can this task use it right now?
4. Can this tool be exposed inside sandboxed TypeScript?

TanStack handles execution ergonomics. CarsonOS still owns permissioning and policy.

## How Tools Should Be Added

Tool registration should happen in a dedicated server module, not inside arbitrary services.

Proposed shape:

```text
server/src/tools/
  index.ts
  registry.ts
  manifest.ts
  scopes.ts
  adapters/
    tanstack-code-mode.ts
  implementations/
    calendar/
    tasks/
    household/
    profiles/
```

### Responsibilities

- `manifest.ts`
  - canonical list of tool definitions
- `registry.ts`
  - lookup by name
  - registration lifecycle
  - filtering by policy scope
- `scopes.ts`
  - resolves which tools are allowed for a task
- `adapters/tanstack-code-mode.ts`
  - converts Carson tool definitions into TanStack-compatible tools
- `implementations/*`
  - actual business logic

This keeps tool growth from leaking into `ConstitutionEngine` or `Dispatcher`.

## Tool Scope Resolution

Before any task runs in Code Mode, CarsonOS should compute an `ExecutionToolScope`.

```ts
interface ExecutionToolScope {
  taskId: string;
  householdId: string;
  agentId: string;
  allowedTools: string[];
  deniedTools: Array<{ name: string; reason: string }>;
  executionMode: "text_only" | "code_mode";
}
```

Scope resolution should consider:

- agent role
- agent visibility
- member role and age if applicable
- task type
- approval state
- clause-derived restrictions
- tool side effect level

Example:

- Tutor may use `getMemberProfile`, `listAssignments`, `readCalendar`, `createStudyPlanDraft`
- Tutor may not use `sendTelegramMessage`, `modifyHouseholdSettings`, `writeConstitutionClause`

## Execution Modes

### Mode 1: Text only

Current behavior.

The model receives a prompt and returns text.

Use for:

- ordinary family chat
- constitution drafting
- simple reasoning
- fallback when Code Mode is unavailable

### Mode 2: Code Mode

The model gets:

- system prompt
- task prompt
- typed tool stubs
- one sandbox execution tool

The model writes TypeScript that calls only approved tools.

Use for:

- internal staff work
- analysis and planning
- structured synthesis
- multi-source lookups

## Sandbox Requirements

Whether CarsonOS uses TanStack's runtime directly or builds a thin wrapper around it, the sandbox must guarantee:

- no host filesystem access
- no arbitrary network access
- no process spawning
- strict timeouts
- strict memory limits
- fresh runtime per execution

If a tool needs network or file access, that access must happen in the tool implementation on the host side, not inside the generated program itself.

That preserves the boundary:

- generated code orchestrates
- Carson-owned tools perform privileged work

## How This Integrates With Existing CarsonOS Services

### `ConstitutionEngine`

No direct TanStack integration.

Responsibilities stay the same:

- load clauses
- evaluate hard rules
- compile soft rules
- log policy events
- produce the policy envelope for downstream work

### `TaskEngine`

Adds optional execution metadata:

- preferred execution mode
- approved tool scope snapshot
- execution backend used

Potential additions to `tasks` or `task_events`:

- `execution_mode`
- `execution_backend`
- `tool_scope_snapshot`

### `CarsonOversight`

Must remain the final gate for any task that can write or act externally.

If a task uses any tool with:

- `sideEffectLevel = "write"`
- `sideEffectLevel = "external_action"`

then oversight may require approval even if the high-level task looked benign.

### `Dispatcher`

This is where Code Mode belongs.

Today `Dispatcher` builds a prompt and calls the adapter directly.

Proposed change:

1. Build execution scope.
2. Choose `text_only` or `code_mode`.
3. For `code_mode`, call a new execution runtime:

```ts
await executionRuntime.runTask({
  task,
  agent,
  toolScope,
  systemPrompt,
});
```

### `DelegationOrchestrator`

No direct change in responsibility.

It should continue to:

- create project/child tasks
- dispatch specialist work
- synthesize results

Its child tasks may simply become better at doing real work once `Dispatcher` supports Code Mode.

## Proposed Execution Runtime Interface

```ts
interface TaskExecutionRuntime {
  runTask(params: {
    task: TaskRecord;
    agent: AgentRecord;
    toolScope: ExecutionToolScope;
    systemPrompt: string;
  }): Promise<{
    status: "completed" | "failed";
    result: string;
    toolCalls?: ToolCallRecord[];
    metadata?: Record<string, unknown>;
  }>;
}

interface ToolCallRecord {
  name: string;
  startedAt: string;
  finishedAt: string;
  argsSummary?: unknown;
  resultSummary?: unknown;
  success: boolean;
}
```

CarsonOS can then support multiple runtimes behind the same interface:

- current text adapter runtime
- TanStack Code Mode runtime
- future provider-specific runtimes if needed

## Data Model Additions

These can be staged. They are not all required on day one.

### Minimal additions

- `tasks.execution_mode`
- `tasks.execution_backend`

### Better additions

- `task_events.payload.tool_calls`
- `task_events.payload.tool_scope`
- `activity_log.details.tool_name`

### Optional future table

```text
task_tool_calls
  id
  task_id
  tool_name
  success
  args_summary
  result_summary
  started_at
  finished_at
```

This becomes valuable once parents need richer audit trails.

## User-Facing Value

The feature should be explained to users as:

"Carson's staff can now do more complex work reliably."

Not:

"We switched to a new agent framework."

Expected end-user improvements:

- better schedule construction
- fewer brittle one-shot staff responses
- better handling of multi-step planning tasks
- fewer arithmetic and aggregation errors
- better use of household context across tools

Expected parent trust improvements:

- clearer audit trails
- explicit records of which tools were used
- no reduction in approval gates
- no reduction in constitution enforcement

## Rollout Plan

### Phase 0: Tool manifest only

Build the CarsonOS tool manifest and registry without TanStack integration.

Deliverables:

- canonical tool definition type
- tool registry
- task tool scope resolution

This is required even if Code Mode is delayed.

### Phase 1: Read-only internal tools

Expose only read-safe tools to Code Mode:

- household/member reads
- task reads
- schedule reads
- profile reads

Use only for internal agents.

Success criteria:

- no sandbox escape
- no policy bypass
- task results better than text-only baseline

### Phase 2: Draft-producing tools

Allow tools that produce drafts but do not directly act:

- create study plan draft
- generate schedule proposal
- prepare parent summary draft

These still avoid direct external action.

### Phase 3: Approved write tools

Only after the audit trail is strong enough:

- write task updates
- persist structured drafts
- queue outbound actions behind approval

Do not allow arbitrary "send" or "write" tools in sandbox execution until event logging and approval semantics are proven.

## Non-Goals

- Replacing `ConstitutionEngine`
- Replacing the current adapter abstraction everywhere
- Turning CarsonOS into a plugin platform like Paperclip
- Turning CarsonOS into a broad channel gateway like OpenClaw
- Allowing family-visible agents arbitrary tools by default

## Risks

### 1. Framework gravity

TanStack AI is compelling, but CarsonOS should not become "TanStack-shaped" in domains where it already has the right structure.

Mitigation:

- isolate TanStack usage behind a Carson-owned runtime interface

### 2. Tool sprawl

If tools are added ad hoc, governance will weaken quickly.

Mitigation:

- manifest-first tool registration
- no implicit tools
- explicit scope resolution

### 3. Policy bypass through code execution

If the sandbox is treated as trusted, the product promise breaks.

Mitigation:

- no privileged host access in sandbox
- only approved external tool bridges
- approval gates remain outside the sandbox

### 4. Debuggability

Generated programs can be harder to reason about than normal tool calls.

Mitigation:

- store generated code for internal inspection
- record tool calls
- expose execution traces in task detail views

## Open Questions

1. Should CarsonOS use TanStack AI directly, or copy the Code Mode pattern behind a Carson-specific runtime?
2. Should generated TypeScript be stored with tasks for audit/debugging?
3. Which first internal agent should pilot this: Scheduler, Tutor, or Carson himself?
4. Should Code Mode be selected per staff role, per task type, or per task instance?
5. Do we want family-visible agents to ever use Code Mode directly, or should it remain internal-only?

## Recommendation

Proceed with a Carson-owned tool manifest and execution runtime abstraction.

Treat TanStack AI Code Mode as the preferred implementation strategy for internal task orchestration, not as the product architecture.

The implementation order should be:

1. manifest
2. scope resolution
3. runtime abstraction
4. read-only Code Mode pilot for one internal staff role

That gives CarsonOS the main benefit of Code Mode without losing the product's core architectural discipline.

## External References

- TanStack Blog: "Code Mode: Let Your AI Write Programs, Not Just Call Tools" (Apr 8, 2026)
  - https://tanstack.com/blog/tanstack-ai-code-mode
- Paperclip repo guidance on adapters/plugins
  - `/Users/joshdaws/projects/paperclip/AGENTS.md`
- OpenClaw project positioning as a broad personal assistant gateway
  - `/Users/joshdaws/projects/openclaw/README.md`
