/**
 * Task Dispatcher -- execution orchestrator for internal agent tasks.
 *
 * v0.1 surface (preserved): tutor/coach/scheduler-style tasks using the
 * <progress>/<result> XML markers, no tools, same-project queuing.
 *
 * v0.4 addition: Developer tasks (custom specialty + `tools`/`project`/`core`).
 * These run with:
 *   - a provisioned workspace (tool sandbox or git worktree)
 *   - cwd + maxTurns=200 passed to the adapter
 *   - MCP tools (delegate_task, create_*_tool, etc.) with callerTaskId set
 *     so delegate_task depth-2 enforcement works
 *   - Claude Code builtin tools per trust level (full trust → Bash/Read/...)
 *   - on terminal state: notifier.prepare + notifier.deliver for two-phase
 *     exactly-once Telegram delivery
 *
 * Boot reconciliation (recoverStuckTasks extended): in addition to the existing
 * "mark stuck in_progress → failed" path, we now also drive Phase-2 notifier
 * replay for any terminal task with notify_payload set + notified_at null.
 * 100ms stagger between sends avoids Telegram rate-limit bursts.
 */

import { eq, and, ne, isNotNull, isNull, lt } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { tasks, taskEvents, staffAgents, projects } from "@carsonos/db";
import type { Adapter } from "./subprocess-adapter.js";
import type { BroadcastFn, AppEvent } from "./event-bus.js";
import { WorkspaceProvider, slugify, type ProvisionedWorkspace, type ProvisionInput } from "./delegation/workspace.js";
import { DelegationNotifier, type NotifyPayload } from "./delegation/notifier.js";
import { DelegatorReply } from "./delegation/delegator-reply.js";
import { composeSummaryCard, renderSummaryCardText, type DeveloperSpecialty } from "./delegation/summary-card.js";
import { templateForSpecialty } from "./delegation/specialty-templates/index.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { DelegationService } from "./delegation-service.js";
import type { CarsonOversight } from "./carson-oversight.js";

// -- Types -----------------------------------------------------------

interface DispatcherConfig {
  db: Db;
  adapter: Adapter;
  broadcast: BroadcastFn;
  /** v0.4: optional. Required for Developer tasks; non-Developer tasks still run. */
  workspace?: WorkspaceProvider;
  notifier?: DelegationNotifier;
  toolRegistry?: ToolRegistry;
}

interface RunningSlot {
  taskId: string;
  queue: string[];
}

interface ParsedProgress {
  step: number;
  total: number;
  message: string;
}

interface ParsedResult {
  status: "completed" | "failed";
  content: string;
}

/**
 * v0.5.2 (TODO-2): captures the variation between Developer-task execution
 * (workspace provisioning, cwd + maxTurns=200) and specialist execution
 * (no workspace, default turn cap, no cwd). The unified `executeTask` path
 * consumes a strategy and runs adapter.execute + cancel re-read + finalize
 * once instead of forking by specialty.
 */
interface WorkspaceStrategy {
  readonly agentKind: "Developer" | "Specialist";
  /** Display string surfaced in events + summary cards. */
  readonly specialty: string;
  /** Working directory for adapter.execute. Null for no-workspace strategies. */
  readonly cwd: string | null;
  /** Turn cap override. Null falls back to the SDK env default. */
  readonly maxTurns: number | null;
  /** Pre-rendered system prompt — strategy decides whether to call the
   *  Developer- or specialist-flavored builder. */
  readonly systemPrompt: string;
  /** Workspace metadata that drives the summary card + finalize log
   *  payload. Null for no-workspace strategies. */
  readonly workspace: ProvisionedWorkspace | null;
  /** Extra structured fields for the "started" log event. */
  readonly startedLogPayload: Record<string, unknown>;
  /** Whether the adapter's textual result should be inlined into the
   *  Telegram notify body (specialist behavior — short reports). False
   *  for Developer (the user fetches via read_task_result). */
  readonly inlineAdapterContent: boolean;
  /** Drain the queue for this slot after execute completes. */
  drainQueue(): Promise<void>;
}

// -- Dispatcher -------------------------------------------------------

export class Dispatcher {
  private db: Db;
  private adapter: Adapter;
  private broadcast: BroadcastFn;
  private workspace: WorkspaceProvider | null;
  private notifier: DelegationNotifier | null;
  private toolRegistry: ToolRegistry | null;
  private delegationService: DelegationService | null = null;
  private oversight: CarsonOversight | null = null;
  private delegatorReply: DelegatorReply | null = null;

  /** Tracks provisioned workspaces for in-flight tasks so cancel can tear them down. */
  private workspaceByTaskId = new Map<string, ProvisionedWorkspace>();

  /** Tracks AbortControllers for in-flight Developer tasks so cancel can stop
   * the Agent SDK query (and the underlying CLI subprocess) instead of letting
   * compute run until it finishes and clobbers the `cancelled` status on the
   * way out. Populated in executeDeveloperTask, cleared when the task exits
   * any terminal state. */
  private inFlightAborts = new Map<string, AbortController>();

  /** Tracks running agents. Key = `${agentId}:${parentTaskId || 'standalone'}` */
  private running = new Map<string, RunningSlot>();

  constructor(config: DispatcherConfig) {
    this.db = config.db;
    this.adapter = config.adapter;
    this.broadcast = config.broadcast;
    this.workspace = config.workspace ?? null;
    this.notifier = config.notifier ?? null;
    this.toolRegistry = config.toolRegistry ?? null;
  }

  /** Late binding for v0.4 delegation context (oversight + service are created
   * after Dispatcher construction; setup via server/index.ts after boot). */
  setDelegationContext(
    delegationService: DelegationService,
    oversight: CarsonOversight,
  ): void {
    this.delegationService = delegationService;
    this.oversight = oversight;
    if (this.notifier) {
      const wake: (taskId: string) => Promise<{ delivered: boolean; reason?: string }> = (taskId) =>
        delegationService.wakeDelegator(taskId);
      this.delegatorReply = new DelegatorReply({
        notifier: this.notifier,
        wake,
      });
    }
  }

  // -- Public API -----------------------------------------------------

  /**
   * Handle a task assignment to an internal agent.
   * If the agent is already running a task for the same project, queue it.
   * If the agent is idle (for this project), execute immediately.
   */
  async handleTaskAssignment(taskId: string): Promise<void> {
    const task = await this.loadTask(taskId);
    if (!task) {
      console.error(`[dispatcher] Task ${taskId} not found`);
      return;
    }

    const agent = await this.loadAgent(task.agentId);
    if (!agent) {
      await this.failTask(taskId, task.agentId, "Agent not found");
      return;
    }

    // Accept: internal agents (tutor/coach/scheduler legacy path) and any
    // hired specialist (staffRole=custom with a specialty). Developer-kind
    // specialists (tools/project/core) get workspace provisioning; other
    // specialists (research/music/etc.) run without a workspace.
    const isHired = this.isHiredSpecialist(agent);
    const isDeveloper = isHired && this.isDeveloperAgent(agent);
    if (agent.visibility !== "internal" && !isHired) {
      await this.failTask(taskId, agent.id, `Agent "${agent.name}" is not dispatchable (visibility: ${agent.visibility})`);
      return;
    }

    // Enforce delegation depth limit (max 2 levels counting the principal).
    if (task.delegationDepth > 1) {
      await this.failTask(taskId, agent.id, `Delegation depth ${task.delegationDepth} exceeds maximum of 1`);
      return;
    }

    const slotKey = this.slotKey(task.agentId, task.parentTaskId);
    const slot = this.running.get(slotKey);

    if (slot) {
      slot.queue.push(taskId);
      return;
    }

    if (isDeveloper) {
      await this.executeDeveloperTask(taskId, agent, slotKey);
    } else if (isHired) {
      await this.executeSpecialistTask(taskId, agent, slotKey);
    } else {
      await this.executeTask(taskId, agent, slotKey);
    }
  }

  private isHiredSpecialist(agent: { staffRole: string; specialty: string | null }): boolean {
    return agent.staffRole === "custom" && !!agent.specialty;
  }

  private isDeveloperAgent(agent: { staffRole: string; specialty: string | null }): boolean {
    return (
      agent.staffRole === "custom" &&
      (agent.specialty === "tools" ||
        agent.specialty === "project" ||
        agent.specialty === "core")
    );
  }

  /**
   * Recover tasks that were in_progress when the server stopped, AND drive
   * Phase-2 notifier replay for terminal tasks whose notification didn't
   * land (design premise 14: the flip-invariant on tasks.notified_at is
   * the exactly-once gate; prepared-but-undelivered rows are replayed on
   * boot with a 100ms stagger to avoid Telegram rate-limit bursts).
   */
  async recoverStuckTasks(): Promise<void> {
    // --- 1. Stuck in_progress → failed (existing behavior) -----------
    const stuck = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.status, "in_progress"));

    if (stuck.length > 0) {
      console.log(`[dispatcher] Recovering ${stuck.length} stuck task(s)`);
    }

    for (const task of stuck) {
      const isDeveloper = task.workspaceKind != null;

      await this.db
        .update(tasks)
        .set({
          status: "failed",
          result: "host restart during run",
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));

      await this.logEvent(task.id, "failed", task.agentId, "host restart during run", { recovered: true });

      this.broadcast({
        type: "task.failed",
        data: {
          taskId: task.id,
          agentId: task.agentId,
          error: "host restart during run",
          recovered: true,
        },
      });

      // For Developer tasks, compose a failure notification so the parent
      // agent gets a "server restarted — task didn't finish" message. For
      // non-Developer tasks, preserve the v0.1 auto-re-queue.
      if (isDeveloper && this.notifier) {
        // Best-effort teardown using the persisted workspace metadata. With
        // TODO-5's DB-then-git ordering, the row was claimed BEFORE git ran,
        // so a crash during provision still leaves enough metadata here to
        // remove a partial worktree and free the carson/<slug> branch.
        // Without this, retrying a task with the same title hits
        // E_BRANCH_EXISTS forever.
        if (this.workspace && task.workspacePath) {
          let repoPath: string | undefined;
          if (task.workspaceKind === "worktree" && task.projectId) {
            const [proj] = await this.db
              .select({ path: projects.path })
              .from(projects)
              .where(eq(projects.id, task.projectId))
              .limit(1);
            repoPath = proj?.path;
          }
          const partial: ProvisionedWorkspace =
            task.workspaceKind === "worktree"
              ? {
                  kind: "worktree",
                  path: task.workspacePath,
                  branch: task.workspaceBranch ?? undefined,
                  repoPath,
                }
              : { kind: "tool_sandbox", path: task.workspacePath };
          await this.workspace.teardown(partial).catch((err) =>
            console.error(`[dispatcher] recovery teardown for ${task.id} failed:`, err),
          );
        }

        const specialty =
          task.workspaceKind === "tool_sandbox" ? "tools" : "project";
        const card = composeSummaryCard({
          kind: "failure",
          task: {
            id: task.id,
            title: task.title,
            workspaceKind: task.workspaceKind,
            workspaceBranch: task.workspaceBranch ?? null,
            workspacePath: task.workspacePath ?? undefined,
            createdAt: task.createdAt,
            completedAt: new Date(),
          },
          specialty,
          reason: "host restart during run",
        });
        await this.notifier.prepare(task.id, {
          terminalStatus: "failed",
          payload: {
            kind: "failure",
            text: renderSummaryCardText(card),
            householdId: task.householdId,
            memberId: task.requestedBy ?? task.agentId,
            agentId: task.notifyAgentId ?? task.agentId,
            summaryCard: card,
          },
        });
        continue;
      }

      // v0.1 non-Developer re-queue
      const [requeued] = await this.db
        .insert(tasks)
        .values({
          householdId: task.householdId,
          agentId: task.agentId,
          parentTaskId: task.parentTaskId,
          requestedBy: task.requestedBy,
          assignedToMembers: task.assignedToMembers as string[] | null,
          title: task.title,
          description: task.description,
          requiresApproval: false,
          delegationDepth: task.delegationDepth,
          status: "pending",
        })
        .returning();

      await this.logEvent(
        requeued.id,
        "created",
        task.agentId,
        `Re-queued after server restart (original: ${task.id})`,
        { originalTaskId: task.id },
      );

      this.broadcast({
        type: "task.requeued",
        data: { taskId: requeued.id, originalTaskId: task.id, agentId: task.agentId },
      });
    }

    // Expired approval cleanup runs here too — doesn't need multiRelay yet,
    // just the DB + notifier.prepare. Phase-2 delivery happens later.
    await this.sweepExpiredApprovals();

    // Phase-2 notifier replay is NOT run here. It has to happen after the
    // multiRelay is constructed + its notifier send target is bound,
    // otherwise every deliver attempt silently fails with "multiRelay not
    // ready yet" and the reconciler re-hits the same window on every boot.
    // Call replayPendingNotifications() explicitly after multiRelay is up.
  }

  /**
   * Cancel any pending-approval task whose approval_expires_at has passed.
   * Prepares a cancellation payload via the notifier (Phase 1 only; Phase 2
   * delivery happens on the next replayPendingNotifications call). Safe to
   * call from boot (as part of recoverStuckTasks) and periodically while
   * running — idempotent because the status gate filters out anything
   * already non-pending.
   *
   * Covers the design-doc success criterion "an approval card left
   * unclicked for 24h auto-cancels the pending action, emits a cancellation
   * message, and logs a task event" — without this, orphaned hire
   * proposals pile up forever in the /tasks UI.
   */
  async sweepExpiredApprovals(): Promise<void> {
    const now = new Date();
    const expired = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.status, "pending"),
          eq(tasks.requiresApproval, true),
          isNotNull(tasks.approvalExpiresAt),
          lt(tasks.approvalExpiresAt, now),
        ),
      );

    if (expired.length === 0) return;
    console.log(`[dispatcher] Expiring ${expired.length} unapproved proposal(s) past TTL`);

    for (const task of expired) {
      // Flip status first with a conditional UPDATE — if something else
      // (the Telegram callback_query handler, the UI fallback, a concurrent
      // sweep) already moved the task out of `pending`, we lose the race
      // and leave it alone.
      const updated = await this.db
        .update(tasks)
        .set({ status: "cancelled", updatedAt: now, completedAt: now })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, "pending")))
        .returning({ id: tasks.id });
      if (updated.length === 0) continue;

      // Parse proposal metadata to pick a human-friendly name for the card.
      let proposedName = "the specialist";
      let reason = "no reason recorded";
      try {
        if (task.description) {
          const meta = JSON.parse(task.description) as {
            proposedName?: string;
            reason?: string;
          };
          if (meta.proposedName) proposedName = meta.proposedName;
          if (meta.reason) reason = meta.reason;
        }
      } catch {
        /* fall through with defaults */
      }

      const ttlHours = task.approvalExpiresAt
        ? Math.round(
            (task.approvalExpiresAt.getTime() - task.createdAt.getTime()) /
              (60 * 60 * 1000),
          )
        : 24;
      const text =
        `⏱ Hire proposal for **${proposedName}** expired after ${ttlHours}h without approval.\n\n` +
        `_Reason was: ${reason}_\n\n` +
        `Re-propose any time if you still want it.`;

      await this.logEvent(
        task.id,
        "approval_expired",
        task.agentId,
        `Approval TTL passed (${ttlHours}h)`,
        { proposedName, reason },
      );

      if (this.notifier && task.requestedBy) {
        await this.notifier.prepare(task.id, {
          terminalStatus: "cancelled",
          payload: {
            kind: "cancellation",
            text,
            householdId: task.householdId,
            memberId: task.requestedBy,
            agentId: task.notifyAgentId ?? task.agentId,
          },
        });
        // Reset notifiedAt so the replay scan picks up the new cancellation
        // payload. Without this, if the original hire_proposal was delivered
        // (notifiedAt set), the cancellation would be written but never sent.
        await this.db
          .update(tasks)
          .set({ notifiedAt: null })
          .where(eq(tasks.id, task.id));
      }

      this.broadcast({
        type: "task.cancelled",
        data: {
          taskId: task.id,
          householdId: task.householdId,
          reason: "approval_expired",
        },
      });
    }
  }

  /**
   * Drive Phase-2 delivery for every terminal task whose notification was
   * prepared (Phase 1) but never successfully delivered. Call this AFTER
   * the multiRelay reference is bound in index.ts, so the notifier's send
   * closure can actually reach Telegram.
   *
   * Design premise 14: the flip-invariant on tasks.notified_at is the
   * exactly-once gate; prepared-but-undelivered rows are replayed on boot
   * with a 100ms stagger to avoid Telegram rate-limit bursts.
   */
  async replayPendingNotifications(): Promise<void> {
    if (!this.notifier) return;

    const pending = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(isNotNull(tasks.notifyPayload), isNull(tasks.notifiedAt)));

    if (pending.length === 0) return;

    console.log(`[dispatcher] Replaying ${pending.length} pending notification(s)`);
    for (let i = 0; i < pending.length; i++) {
      const { id } = pending[i];
      try {
        // Wake-first so host-restart-during-run failures (the recovery path
        // above primes the prepared payload as a safety net) get phrased in
        // the delegator's voice, matching live success/failure messaging.
        // DelegatorReply retries transient wake failures with backoff before
        // falling back to the templated notifier.
        await this.deliverDelegatorReply(id);
      } catch (err) {
        console.error(`[dispatcher] notifier replay for ${id} threw:`, err);
      }
      // Stagger to avoid Telegram rate-limit bursts on large queues.
      if (i < pending.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  /**
   * Subscribe to the task.cancelled broadcast so we can tear down the
   * workspace without the caller needing to know about it. Boot code in
   * index.ts wires eventBus.on("task.cancelled", (e) => dispatcher.handleCancelBroadcast(e)).
   */
  async handleCancelBroadcast(event: AppEvent): Promise<void> {
    const data = event.data as { taskId?: string } | undefined;
    const taskId = data?.taskId;
    if (!taskId) return;

    // Stop compute first. Aborting the controller causes the Agent SDK to
    // terminate its CLI subprocess and reject the query's async iterator;
    // executeDeveloperTask's catch branch then short-circuits the notify
    // path so it can't overwrite the `cancelled` status with `completed`.
    const abort = this.inFlightAborts.get(taskId);
    if (abort) {
      try {
        abort.abort();
      } catch (err) {
        console.error(`[dispatcher] abort on cancel failed for ${taskId}:`, err);
      }
    }

    const workspace = this.workspaceByTaskId.get(taskId);
    if (!workspace || !this.workspace) return;
    try {
      await this.workspace.teardown(workspace);
    } catch (err) {
      console.error(`[dispatcher] teardown on cancel failed for ${taskId}:`, err);
    }
    this.workspaceByTaskId.delete(taskId);
  }

  // -- v0.4 Developer task execution ---------------------------------

  /**
   * Run a Developer task end-to-end:
   *   1. Resolve project (for project/core specialties).
   *   2. Provision workspace (git worktree or tool sandbox).
   *   3. Persist workspace_kind/path/branch on the task row.
   *   4. Build MCP tool executor (with callerTaskId=taskId for depth-2).
   *   5. adapter.execute with cwd + maxTurns=200 + full trust builtins.
   *   6. Compose SummaryCard + deliver notification via the two-phase notifier.
   *   7. Tool sandbox: teardown on terminal. Worktree: leave for PR poller /
   *      cancel broadcast (review iterations reuse the worktree).
   */
  private async executeDeveloperTask(
    taskId: string,
    agent: {
      id: string;
      name: string;
      staffRole: string;
      specialty: string | null;
      roleContent: string;
      soulContent: string | null;
      operatingInstructions: string | null;
      trustLevel: string;
      model: string;
      householdId: string;
    },
    slotKey: string,
  ): Promise<void> {
    const task = await this.loadTask(taskId);
    if (!task) {
      this.running.delete(slotKey);
      return;
    }

    // Workspace selection: the calling agent's per-task choice (written to
    // task.workspaceKind by delegation-service) wins. Fall back to the
    // specialist's hired specialty for direct-creation paths and old rows
    // that pre-date per-task workspace selection.
    const requestedKind = task.workspaceKind === "tool_sandbox" || task.workspaceKind === "worktree"
      ? task.workspaceKind
      : null;
    const fallbackSpecialty = (agent.specialty ?? "tools") as DeveloperSpecialty;
    const workspaceKindResolved: "tool_sandbox" | "worktree" =
      requestedKind ?? (fallbackSpecialty === "tools" ? "tool_sandbox" : "worktree");

    // The card-rendering specialty is derived from the chosen workspace kind
    // and projectId so the user sees "Tool work" vs "Core update" vs "Project
    // work" based on what the task actually was, not the specialist's hire-
    // time tag. carson-os projectId → "core"; any other project → "project";
    // sandbox → "tools".
    const carsonOsProjectId = await this.findCarsonOsProjectId(agent.householdId);
    const specialty: DeveloperSpecialty =
      workspaceKindResolved === "tool_sandbox"
        ? "tools"
        : task.projectId && task.projectId === carsonOsProjectId
          ? "core"
          : "project";
    this.running.set(slotKey, { taskId, queue: this.running.get(slotKey)?.queue ?? [] });

    // -- 1. Resolve project (for worktree workspaces) ----------------
    let project: {
      id: string;
      name: string;
      path: string;
      defaultBranch: string;
      testCmd: string | null;
      repoUrl: string | null;
    } | null = null;
    if (workspaceKindResolved === "worktree" && task.projectId) {
      const [row] = await this.db
        .select()
        .from(projects)
        .where(eq(projects.id, task.projectId))
        .limit(1);
      if (row) project = row;
    }
    if (workspaceKindResolved === "worktree" && !project) {
      await this.failDeveloperTask(
        task,
        agent,
        specialty,
        `worktree workspace requires a registered project (task.projectId=${task.projectId ?? "null"}). Re-delegate with workspace='project' and a valid projectId.`,
        slotKey,
      );
      return;
    }

    // -- 2. Pre-claim row + provision workspace ----------------------
    // Order is DB-then-git (TODO-5 crash-safety): we predict the workspace
    // path/branch deterministically, write them to the row alongside
    // status='in_progress', AND ONLY THEN call git worktree add. If the host
    // dies between the DB write and provision succeeding, recoverStuckTasks
    // sees the in_progress row with workspace metadata and can teardown
    // whatever partial state git left behind, instead of orphaning a
    // carson/<slug> branch that permanently blocks retries with the same
    // title. If provision throws, we catch and call failDeveloperTask after
    // a best-effort teardown of the predicted path.
    if (!this.workspace) {
      await this.failDeveloperTask(
        task,
        agent,
        specialty,
        "Dispatcher is missing a WorkspaceProvider (boot wiring incomplete)",
        slotKey,
      );
      return;
    }

    const provisionInput: ProvisionInput =
      workspaceKindResolved === "tool_sandbox"
        ? { kind: "tool_sandbox", runId: taskId }
        : {
            kind: "worktree",
            projectName: project!.name,
            projectPath: project!.path,
            defaultBranch: project!.defaultBranch,
            runId: taskId,
            slug: slugify(task.title),
          };
    const predicted = this.workspace.predictMetadata(provisionInput);

    // Conditional UPDATE so if handleCancelTask already flipped the row to
    // `cancelled` before we claimed it (narrow race between the dispatcher
    // picking the task up and the user tapping Reject/Cancel), this write is
    // a no-op and we bail out instead of silently overwriting the cancel.
    const claimed = await this.db
      .update(tasks)
      .set({
        status: "in_progress",
        workspaceKind: workspaceKindResolved,
        workspacePath: predicted.path,
        workspaceBranch: predicted.branch ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, taskId), ne(tasks.status, "cancelled")))
      .returning({ id: tasks.id });

    if (claimed.length === 0) {
      // The cancel path won. Bail before provisioning — there's no workspace
      // yet to clean up.
      await this.logEvent(
        taskId,
        "cancelled",
        agent.id,
        "Developer task cancelled before start",
        { specialty, reason: "cancelled before in_progress" },
      );
      await this.drainDeveloperQueue(slotKey, agent);
      return;
    }

    // Register AbortController before provision so a cancel mid-`git
    // worktree add` has a handle to abort against (provision is awaited so
    // abort can't actually short-circuit it today, but registering here
    // keeps the bookkeeping consistent and ready for future async work).
    const abortController = new AbortController();
    this.inFlightAborts.set(taskId, abortController);

    let workspace: ProvisionedWorkspace;
    try {
      workspace = await this.workspace.provision(provisionInput);
    } catch (err) {
      // Best-effort teardown using the predicted metadata. If git left a
      // partial worktree dir, this cleans it up so the next retry isn't
      // blocked by E_WORKTREE_EXISTS.
      const partial: ProvisionedWorkspace =
        workspaceKindResolved === "worktree"
          ? {
              kind: "worktree",
              path: predicted.path,
              branch: predicted.branch,
              repoPath: project!.path,
            }
          : { kind: "tool_sandbox", path: predicted.path };
      await this.workspace.teardown(partial).catch((tdErr) =>
        console.error(`[dispatcher] teardown after provision failure for ${taskId}:`, tdErr),
      );
      this.inFlightAborts.delete(taskId);
      await this.failDeveloperTask(
        task,
        agent,
        specialty,
        `workspace provision failed: ${err instanceof Error ? err.message : String(err)}`,
        slotKey,
      );
      return;
    }

    this.workspaceByTaskId.set(taskId, workspace);

    // The pre-execute abort controller registered above gets re-registered
    // by runStrategy below. The earlier set was for the (rare) provision-
    // throws case so cancel during `git worktree add` had a handle; once
    // provision succeeded the controller's job is over until adapter.execute
    // starts. runStrategy drives its own abort lifecycle.
    this.inFlightAborts.delete(taskId);

    // Workspace teardown policy (unchanged):
    //   Do NOT tear down on success — tool_sandbox needs the built files
    //   visible for human review, worktree needs the branch + dir for PR
    //   review iteration. Teardown runs only on task.cancelled, v0.5+ PR
    //   merge/close, or explicit /api/tools/install|discard.
    //
    // The workspaceByTaskId entry stays so cancel can still find it.
    const strategy: WorkspaceStrategy = {
      agentKind: "Developer",
      specialty,
      cwd: workspace.path,
      // No turn cap for Developers per design premise 9a. 200 is the SDK
      // ceiling so we pass it explicitly rather than relying on the
      // env-driven 50-default.
      maxTurns: 200,
      systemPrompt: this.buildDeveloperSystemPrompt(agent, task, specialty, project),
      workspace,
      startedLogPayload: {
        workspaceKind: workspace.kind,
        workspacePath: workspace.path,
        projectId: project?.id ?? null,
      },
      inlineAdapterContent: false,
      drainQueue: () => this.drainDeveloperQueue(slotKey, agent),
    };
    await this.runStrategy(task, agent, strategy);
  }

  private async drainDeveloperQueue(
    slotKey: string,
    agent: Parameters<Dispatcher["executeDeveloperTask"]>[1],
  ): Promise<void> {
    const slot = this.running.get(slotKey);
    if (!slot) return;
    const nextTaskId = slot.queue.shift();
    if (!nextTaskId) {
      this.running.delete(slotKey);
      return;
    }
    await this.executeDeveloperTask(nextTaskId, agent, slotKey);
  }

  private buildDeveloperSystemPrompt(
    agent: {
      name: string;
      roleContent: string;
      soulContent: string | null;
      operatingInstructions: string | null;
    },
    task: { title: string; description: string | null },
    specialty: DeveloperSpecialty,
    project: {
      name: string;
      path: string;
      defaultBranch: string;
      testCmd: string | null;
      repoUrl: string | null;
    } | null,
  ): string {
    const parts: string[] = [];
    parts.push(`# You are ${agent.name}\n`);
    parts.push(agent.roleContent || `A Developer with the ${specialty} specialty.`);
    parts.push("");

    // Specialty operating contract — loaded at hire time into the agent's
    // operating_instructions. templateForSpecialty returns null for non-
    // Developer specialties (research/music/etc.); those agents always have
    // their operating_instructions populated via composeGenericSpecialistInstructions
    // or customInstructions at hire time, so the fallback here is only for
    // pre-v0.4 rows that legitimately don't have one.
    // Operating contract is per-task. The agent has stored operating_instructions
    // templated to its hired specialty (often "tools"), but the calling agent
    // can pick a different workspace per-task — e.g., a tools-Dev assigned a
    // "project" task to fix carson-os. In that case the hired-time instructions
    // would tell Dev to build a new tool in the sandbox, which is wrong. Always
    // load the template that matches THIS task's specialty; only fall back to
    // the stored instructions if no template exists.
    parts.push("# Operating Contract\n");
    parts.push(
      templateForSpecialty(specialty) ??
        agent.operatingInstructions ??
        `You are ${agent.name}, a ${specialty} specialist. Use your granted tools; keep responses self-contained.`,
    );
    parts.push("");

    if (project) {
      parts.push("# Project Context\n");
      parts.push(`- Name: ${project.name}`);
      parts.push(`- Path: ${project.path}`);
      parts.push(`- Default branch: ${project.defaultBranch}`);
      if (project.testCmd) parts.push(`- Test command: ${project.testCmd}`);
      if (project.repoUrl) parts.push(`- Repo: ${project.repoUrl}`);
      parts.push("");
    }

    parts.push("# Task\n");
    parts.push(task.title);
    if (task.description) {
      parts.push("");
      parts.push(task.description);
    }
    parts.push("");
    parts.push(
      "Work the problem. Use the provided tools. When you're done (or blocked), say so plainly — no XML markers required; the system will detect completion from your final response.",
    );

    return parts.join("\n");
  }

  private async failDeveloperTask(
    task: { id: string; title: string; createdAt: Date; notifyAgentId: string | null; requestedBy: string | null },
    agent: Parameters<Dispatcher["executeDeveloperTask"]>[1],
    specialty: DeveloperSpecialty,
    reason: string,
    slotKey?: string,
  ): Promise<void> {
    const card = composeSummaryCard({
      kind: "failure",
      task: {
        id: task.id,
        title: task.title,
        workspaceKind: null,
        workspaceBranch: null,
        createdAt: task.createdAt,
        completedAt: new Date(),
      },
      specialty,
      reason,
    });
    const text = renderSummaryCardText(card);

    if (this.notifier) {
      await this.notifier.prepare(task.id, {
        terminalStatus: "failed",
        payload: {
          kind: "failure",
          text,
          householdId: agent.householdId,
          memberId: task.requestedBy ?? agent.id,
          agentId: task.notifyAgentId ?? agent.id,
          summaryCard: card,
        },
      });
      this.notifier.deliver(task.id).catch(() => {});
    } else {
      await this.failTask(task.id, agent.id, reason);
    }

    await this.logEvent(task.id, "failed", agent.id, reason, { specialty, reason });

    // Slot hygiene: pre-execution failures (workspace provision errors, missing
    // project, etc.) used to leave the slot marked running, which silently
    // stranded any subsequent delegation attempt for the same agent on the
    // queue. Drain it so queued retries can move forward (and the queue empties
    // back to a clean slate when there's nothing left). Surfaced 2026-04-29:
    // a cancelled task left the carson/<slug> branch behind, the next attempt
    // failed E_BRANCH_EXISTS in failDeveloperTask, slot stayed dirty, the THIRD
    // attempt sat queued for 16 minutes until the user killed it.
    if (slotKey) {
      await this.drainDeveloperQueue(slotKey, agent);
    }
  }

  // -- Non-Developer specialist execution ----------------------------

  /**
   * Run a task for a non-Developer hired specialist (researcher, music
   * specialist, etc). No workspace, no cwd, no extra builtins beyond what
   * the agent's trust_level already grants. Just a query() with MCP tools,
   * then wrap the response in a completion card.
   *
   * The agent's `operating_instructions` (set at hire time from
   * customInstructions or the generic template) carries their "how I work"
   * contract — this method only adds the task-specific "# Task" section
   * to the system prompt.
   */
  private async executeSpecialistTask(
    taskId: string,
    agent: {
      id: string;
      name: string;
      staffRole: string;
      specialty: string | null;
      roleContent: string;
      soulContent: string | null;
      operatingInstructions: string | null;
      trustLevel: string;
      model: string;
      householdId: string;
    },
    slotKey: string,
  ): Promise<void> {
    const task = await this.loadTask(taskId);
    if (!task) {
      this.running.delete(slotKey);
      return;
    }
    const specialty = agent.specialty ?? "general";
    this.running.set(slotKey, { taskId, queue: this.running.get(slotKey)?.queue ?? [] });

    await this.db
      .update(tasks)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    const strategy: WorkspaceStrategy = {
      agentKind: "Specialist",
      specialty,
      cwd: null,
      // No maxTurns override — the env-driven 50 default is appropriate
      // for conversation-driven specialists.
      maxTurns: null,
      systemPrompt: this.buildSpecialistSystemPrompt(agent, task, specialty),
      workspace: null,
      startedLogPayload: { specialty },
      // Specialists return a short report. Inline it into the notify
      // body so the user gets the full response without having to ask;
      // long reports will exceed Telegram's 4096-char single-message
      // cap and chunk into multiple bubbles, which is fine.
      inlineAdapterContent: true,
      drainQueue: () => this.drainSpecialistQueue(slotKey, agent),
    };
    await this.runStrategy(task, agent, strategy);
  }

  /**
   * Unified task executor (v0.5.2 / TODO-2). Takes a fully-prepared
   * WorkspaceStrategy (workspace already provisioned for Developer; no
   * workspace for specialist) and runs the shared pipeline:
   *
   *   1. logEvent + broadcast started
   *   2. resolve tools/executor/builtins via toolRegistry
   *   3. adapter.execute with abortController, optional cwd/maxTurns
   *      from the strategy
   *   4. re-read DB status; if cancelled, log + drain and bail
   *   5. compose summary card (workspace fields driven by strategy)
   *   6. notify payload (text inlines adapter content for specialist
   *      strategies; Developer keeps the card alone)
   *   7. finalizeTerminalTask (notifier prepare + delegator-reply wake)
   *   8. drain queue
   *
   * Future refinements (canary hooks, budget gates, resume-after-restart)
   * touch this method once instead of two near-duplicates.
   */
  private async runStrategy(
    task: NonNullable<Awaited<ReturnType<Dispatcher["loadTask"]>>>,
    agent: Parameters<Dispatcher["executeDeveloperTask"]>[1],
    strategy: WorkspaceStrategy,
  ): Promise<void> {
    const taskId = task.id;

    await this.logEvent(
      taskId,
      "started",
      agent.id,
      `${strategy.agentKind} task started (${strategy.specialty})`,
      strategy.startedLogPayload,
    );
    this.broadcast({
      type: "task.started",
      data: { taskId, agentId: agent.id, specialty: strategy.specialty },
    });

    let toolsParam: ReturnType<typeof Array.of> | undefined;
    let executorParam:
      | ((name: string, input: Record<string, unknown>) => Promise<{
          content: string;
          is_error?: boolean;
        }>)
      | undefined;
    let builtins: string[] | undefined;
    if (this.toolRegistry) {
      builtins = await this.toolRegistry.getAgentBuiltins(agent.id).catch(() => []);
      const ctx = {
        db: this.db,
        memoryProvider: null,
        agentId: agent.id,
        memberId: task.requestedBy ?? agent.id,
        memberName: agent.name,
        householdId: agent.householdId,
        memberCollection: "household",
        householdCollection: "household",
        isChiefOfStaff: false,
        delegationService: this.delegationService ?? undefined,
        oversight: this.oversight ?? undefined,
        callerTaskId: taskId,
      };
      const built = await this.toolRegistry.buildExecutor(ctx);
      if (built) {
        toolsParam = built.tools as unknown as ReturnType<typeof Array.of>;
        executorParam = built.executor as typeof executorParam;
      }
    }

    const startedAt = new Date();
    const userMsg = task.description ? `${task.title}\n\n${task.description}` : task.title;

    const abortController = new AbortController();
    this.inFlightAborts.set(taskId, abortController);

    let adapterResult: { content: string } | null = null;
    let adapterError: string | null = null;
    try {
      adapterResult = await this.adapter.execute({
        systemPrompt: strategy.systemPrompt,
        messages: [{ role: "user", content: userMsg }],
        tools: toolsParam as never,
        toolExecutor: executorParam as never,
        builtinTools: builtins,
        model: agent.model,
        ...(strategy.cwd != null ? { cwd: strategy.cwd } : {}),
        ...(strategy.maxTurns != null ? { maxTurns: strategy.maxTurns } : {}),
        abortController,
      });
    } catch (err) {
      adapterError = err instanceof Error ? err.message : String(err);
    } finally {
      this.inFlightAborts.delete(taskId);
    }

    const [currentState] = await this.db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    const wasCancelled =
      currentState?.status === "cancelled" || abortController.signal.aborted;

    if (wasCancelled) {
      await this.logEvent(
        taskId,
        "cancelled",
        agent.id,
        `${strategy.agentKind} task cancelled by user`,
        { specialty: strategy.specialty, reason: "cancelled by user" },
      );
      await strategy.drainQueue();
      return;
    }

    const terminalStatus: "completed" | "failed" = adapterError ? "failed" : "completed";
    const summaryReason = adapterError ?? undefined;
    const ws = strategy.workspace;

    const card = composeSummaryCard({
      kind: terminalStatus === "completed" ? "completion" : "failure",
      task: {
        id: taskId,
        title: task.title,
        workspaceKind: ws?.kind ?? null,
        workspaceBranch: ws?.branch ?? null,
        workspacePath: ws?.path,
        createdAt: startedAt,
        completedAt: new Date(),
      },
      specialty: strategy.specialty as DeveloperSpecialty,
      artifacts: ws ? {} : undefined,
      reason: summaryReason,
    });

    const cardText = renderSummaryCardText(card);
    const text =
      strategy.inlineAdapterContent &&
      terminalStatus === "completed" &&
      adapterResult?.content
        ? `${cardText}\n\n${adapterResult.content}`
        : cardText;

    const payload: NotifyPayload = {
      kind: terminalStatus === "completed" ? "completion" : "failure",
      text,
      householdId: agent.householdId,
      memberId: task.requestedBy ?? agent.id,
      agentId: task.notifyAgentId ?? agent.id,
      summaryCard: card,
    };

    const finalized = await this.finalizeTerminalTask({
      taskId,
      agent,
      task,
      terminalStatus,
      resultText:
        terminalStatus === "completed"
          ? (adapterResult?.content ?? null)
          : adapterError
            ? `Error: ${adapterError}`
            : null,
      durationSec: card.durationSec,
      specialty: strategy.specialty,
      agentKind: strategy.agentKind,
      payload,
      adapterErrorForLog: adapterError,
    });

    // drain regardless of preparedUpdate (cancel-sticky guard already
    // handled the bail-on-refused-update side effects above).
    await strategy.drainQueue();
    void finalized;
  }

  /**
   * Shared post-execute finalize for both Developer and Specialist tasks.
   *
   *   1. Persist terminal status + notify payload + result text, with the
   *      cancel-sticky guard (WHERE status != 'cancelled') so a slow worker
   *      returning after cancel can't flip the row back to completed.
   *   2. If the guard refused the update, bail early and let the caller
   *      drain its queue. (Cancel path already logged + broadcast.)
   *   3. logEvent + broadcast task.completed / task.failed.
   *   4. Try v0.4 back-channel wake (delegator's agent replies in voice);
   *      on wake non-delivery fall back to notifier.deliver (templated
   *      card). A silent miss would be worse than a utilitarian message.
   *   5. On wake success, flip notified_at via markDeliveredByWake so the
   *      restart reconciler doesn't replay the templated card.
   */
  private async finalizeTerminalTask(ctx: {
    taskId: string;
    agent: { id: string };
    task: { notifyAgentId: string | null; requestedBy: string | null };
    terminalStatus: "completed" | "failed";
    resultText: string | null;
    durationSec: number;
    specialty: string;
    agentKind: "Developer" | "Specialist";
    payload: NotifyPayload;
    adapterErrorForLog: string | null;
  }): Promise<{ preparedUpdate: boolean }> {
    const {
      taskId,
      agent,
      terminalStatus,
      resultText,
      durationSec,
      specialty,
      agentKind,
      payload,
      adapterErrorForLog,
    } = ctx;

    let preparedUpdate = true;
    if (this.notifier) {
      const { updated } = await this.notifier.prepare(taskId, { terminalStatus, payload });
      preparedUpdate = updated;
      // notifier.prepare writes status + payload + completedAt; the full
      // specialist output lives on task.result so read_task_result can pull
      // it. Same cancel-sticky guard so a slow worker can't blow away a
      // cancelled row.
      if (preparedUpdate && resultText) {
        await this.db
          .update(tasks)
          .set({ result: resultText, updatedAt: new Date() })
          .where(and(eq(tasks.id, taskId), ne(tasks.status, "cancelled")));
      }
    } else {
      const result = await this.db
        .update(tasks)
        .set({
          status: terminalStatus,
          result: resultText,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, taskId), ne(tasks.status, "cancelled")))
        .returning({ id: tasks.id });
      preparedUpdate = result.length > 0;
    }

    if (!preparedUpdate) {
      return { preparedUpdate: false };
    }

    await this.logEvent(
      taskId,
      terminalStatus === "completed" ? "completed" : "failed",
      agent.id,
      terminalStatus === "completed"
        ? `${agentKind} task completed`
        : `${agentKind} task failed: ${adapterErrorForLog}`,
      { durationSec, specialty },
    );
    this.broadcast({
      type: `task.${terminalStatus === "completed" ? "completed" : "failed"}`,
      data: { taskId, agentId: agent.id, specialty },
    });

    this.deliverDelegatorReply(taskId).catch((err) =>
      console.error(`[dispatcher] deliver(${taskId}) threw:`, err),
    );

    return { preparedUpdate: true };
  }

  /**
   * Hand the delegator-reply policy to DelegatorReply if it's wired, else
   * fall back to direct templated send. The wired path is the normal one;
   * the fallback covers boot windows where setDelegationContext hasn't run
   * yet (e.g., recoverStuckTasks before delegationService is bound).
   */
  private async deliverDelegatorReply(taskId: string): Promise<void> {
    if (this.delegatorReply) {
      await this.delegatorReply.handleTerminal(taskId);
      return;
    }
    if (this.notifier) {
      await this.notifier.deliver(taskId);
    }
  }

  private async drainSpecialistQueue(
    slotKey: string,
    agent: Parameters<Dispatcher["executeSpecialistTask"]>[1],
  ): Promise<void> {
    const slot = this.running.get(slotKey);
    if (!slot) return;
    const nextTaskId = slot.queue.shift();
    if (!nextTaskId) {
      this.running.delete(slotKey);
      return;
    }
    await this.executeSpecialistTask(nextTaskId, agent, slotKey);
  }

  private buildSpecialistSystemPrompt(
    agent: {
      name: string;
      roleContent: string;
      soulContent: string | null;
      operatingInstructions: string | null;
    },
    task: { title: string; description: string | null },
    specialty: string,
  ): string {
    const parts: string[] = [];
    parts.push(`# You are ${agent.name}\n`);
    if (agent.roleContent) {
      parts.push(agent.roleContent);
      parts.push("");
    }
    parts.push("# Operating Contract\n");
    parts.push(
      agent.operatingInstructions ??
        `You are a ${specialty} specialist. Use your granted tools; keep responses self-contained.`,
    );
    parts.push("");
    parts.push("# Task\n");
    parts.push(task.title);
    if (task.description) {
      parts.push("");
      parts.push(task.description);
    }
    parts.push("");
    parts.push(
      "Work the problem using your granted tools. When you're done, give a clear, self-contained response — the principal sees what you return, not your scratch work.",
    );
    return parts.join("\n");
  }

  // -- Core execution -------------------------------------------------

  private async executeTask(
    taskId: string,
    agent: { id: string; name: string; roleContent: string; soulContent: string | null },
    slotKey: string,
  ): Promise<void> {
    const task = await this.loadTask(taskId);
    if (!task) {
      console.error(`[dispatcher] Task ${taskId} vanished before execution`);
      this.running.delete(slotKey);
      return;
    }

    // Claim the slot
    this.running.set(slotKey, { taskId, queue: this.running.get(slotKey)?.queue ?? [] });

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(agent, task);

    // Mark as in_progress
    await this.db
      .update(tasks)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    await this.logEvent(taskId, "started", agent.id, "Task execution started");

    this.broadcast({
      type: "task.started",
      data: { taskId, agentId: agent.id },
    });

    // Execute via adapter
    try {
      const result = await this.adapter.execute({
        systemPrompt,
        messages: [
          { role: "user", content: task.description ?? task.title },
        ],
      });

      // Parse progress markers from the response
      const progressMarkers = this.parseProgress(result.content);
      for (const marker of progressMarkers) {
        await this.logEvent(
          taskId,
          "progress_update",
          agent.id,
          marker.message,
          { step: marker.step, total: marker.total },
        );

        this.broadcast({
          type: "task.progress",
          data: {
            taskId,
            agentId: agent.id,
            step: marker.step,
            total: marker.total,
            message: marker.message,
          },
        });
      }

      // Parse result block
      const parsed = this.parseResult(result.content);
      const finalStatus = parsed.status;
      const finalContent = parsed.content;

      // Update task
      await this.db
        .update(tasks)
        .set({
          status: finalStatus,
          result: finalContent,
          updatedAt: new Date(),
          completedAt: finalStatus === "completed" ? new Date() : undefined,
        })
        .where(eq(tasks.id, taskId));

      const eventType = finalStatus === "completed" ? "completed" : "failed";
      await this.logEvent(taskId, eventType, agent.id, `Task ${eventType}`, {
        resultLength: finalContent.length,
      });

      this.broadcast({
        type: `task.${eventType}`,
        data: { taskId, agentId: agent.id, result: finalContent },
      });

      // Check project completion
      if (task.parentTaskId) {
        await this.checkProjectCompletion(task.parentTaskId);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown execution error";

      await this.db
        .update(tasks)
        .set({
          status: "failed",
          result: `Error: ${errorMsg}`,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));

      await this.logEvent(taskId, "failed", agent.id, `Task failed: ${errorMsg}`, {
        error: errorMsg,
      });

      this.broadcast({
        type: "task.failed",
        data: { taskId, agentId: agent.id, error: errorMsg },
      });

      // Still check project completion on failure
      if (task.parentTaskId) {
        await this.checkProjectCompletion(task.parentTaskId);
      }
    }

    // Drain the queue for this slot
    await this.drainQueue(slotKey, agent);
  }

  /**
   * After a task finishes, check if there are more queued tasks
   * for this agent+project slot. If so, pick up the next one.
   * If not, release the slot.
   */
  private async drainQueue(
    slotKey: string,
    agent: { id: string; name: string; roleContent: string; soulContent: string | null },
  ): Promise<void> {
    const slot = this.running.get(slotKey);
    if (!slot) return;

    const nextTaskId = slot.queue.shift();
    if (!nextTaskId) {
      // Nothing queued, release the slot
      this.running.delete(slotKey);
      return;
    }

    // Execute the next queued task (tail-recursive via async)
    await this.executeTask(nextTaskId, agent, slotKey);
  }

  // -- System prompt --------------------------------------------------

  private buildSystemPrompt(
    agent: { roleContent: string; soulContent: string | null },
    task: { title: string; description: string | null },
  ): string {
    const parts: string[] = [];

    // Agent role
    parts.push("# Agent Role\n");
    parts.push(agent.roleContent);
    parts.push("");

    // Agent personality (if present)
    if (agent.soulContent) {
      parts.push("# Agent Identity\n");
      parts.push(agent.soulContent);
      parts.push("");
    }

    // Task-mode instructions
    parts.push("# Task Instructions\n");
    parts.push(`You are executing a task: "${task.title}"`);
    if (task.description) {
      parts.push(`\nDetails: ${task.description}`);
    }
    parts.push("");
    parts.push("Complete the task and provide a clear, concise result.");
    parts.push("If you cannot complete the task, explain why.");
    parts.push("");

    // Progress + result format instructions
    parts.push("# Output Format\n");
    parts.push("As you work through the task, emit progress markers:");
    parts.push('  <progress step="1" total="3" message="Analyzing requirements..."/>');
    parts.push("");
    parts.push("When finished, wrap your final result:");
    parts.push('  <result status="completed">Your result here</result>');
    parts.push("");
    parts.push("If you cannot complete the task:");
    parts.push('  <result status="failed">Explanation of what went wrong</result>');

    return parts.join("\n");
  }

  // -- Parsing --------------------------------------------------------

  /**
   * Extract all <progress step="N" total="M" message="..."/> markers
   * from the adapter response.
   */
  private parseProgress(content: string): ParsedProgress[] {
    const markers: ParsedProgress[] = [];
    const regex = /<progress\s+step="(\d+)"\s+total="(\d+)"\s+message="([^"]*)"\/?\s*>/g;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      markers.push({
        step: parseInt(match[1], 10),
        total: parseInt(match[2], 10),
        message: match[3],
      });
    }

    return markers;
  }

  /**
   * Extract <result status="completed|failed">content</result> from the response.
   * If no result block, treat the entire response as a completed result.
   */
  private parseResult(content: string): ParsedResult {
    const regex = /<result\s+status="(completed|failed)">([\s\S]*?)<\/result>/;
    const match = regex.exec(content);

    if (match) {
      return {
        status: match[1] as "completed" | "failed",
        content: match[2].trim(),
      };
    }

    // Graceful fallback: strip progress tags and use the rest as a completed result
    const cleaned = content
      .replace(/<progress\s+[^>]*\/?\s*>/g, "")
      .trim();

    return {
      status: "completed",
      content: cleaned || content,
    };
  }

  // -- Project completion ---------------------------------------------

  /**
   * After a subtask completes or fails, check if ALL sibling subtasks
   * (same parentTaskId) are done. If so, broadcast project.completed.
   */
  private async checkProjectCompletion(parentTaskId: string): Promise<void> {
    const subtasks = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.parentTaskId, parentTaskId));

    if (subtasks.length === 0) return;

    const allDone = subtasks.every(
      (t) => t.status === "completed" || t.status === "failed",
    );

    if (allDone) {
      const completedCount = subtasks.filter((t) => t.status === "completed").length;
      const failedCount = subtasks.filter((t) => t.status === "failed").length;

      this.broadcast({
        type: "project.completed",
        data: {
          parentTaskId,
          total: subtasks.length,
          completed: completedCount,
          failed: failedCount,
        },
      });
    }
  }

  // -- Helpers --------------------------------------------------------

  private slotKey(agentId: string, parentTaskId: string | null): string {
    return `${agentId}:${parentTaskId || "standalone"}`;
  }

  private async loadTask(taskId: string) {
    const [task] = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));

    return task ?? null;
  }

  /**
   * Resolve the household's carson-os project id (if registered). Used to
   * decide whether a worktree task is "core" (CarsonOS itself) vs "project"
   * (any other registered codebase) for card labeling. Cached per household
   * to avoid a DB hit every dispatch.
   */
  private carsonOsProjectIdCache = new Map<string, string | null>();
  private async findCarsonOsProjectId(householdId: string): Promise<string | null> {
    const cached = this.carsonOsProjectIdCache.get(householdId);
    if (cached !== undefined) return cached;
    const [row] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.householdId, householdId), eq(projects.name, "carson-os")))
      .limit(1);
    const id = row?.id ?? null;
    this.carsonOsProjectIdCache.set(householdId, id);
    return id;
  }

  private async loadAgent(agentId: string) {
    const [agent] = await this.db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, agentId));

    return agent ?? null;
  }

  private async failTask(
    taskId: string,
    agentId: string,
    reason: string,
  ): Promise<void> {
    await this.db
      .update(tasks)
      .set({
        status: "failed",
        result: `Error: ${reason}`,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    await this.logEvent(taskId, "failed", agentId, reason, { error: reason });

    this.broadcast({
      type: "task.failed",
      data: { taskId, agentId, error: reason },
    });
  }

  private async logEvent(
    taskId: string,
    eventType: string,
    agentId: string | null,
    message: string | null,
    payload?: unknown,
    clauseIds?: string[],
  ): Promise<void> {
    try {
      await this.db.insert(taskEvents).values({
        taskId,
        eventType,
        agentId: agentId ?? undefined,
        message,
        payload: payload ?? null,
        clauseIds: clauseIds ?? null,
      });
    } catch (err) {
      console.error("[dispatcher] Failed to log task event:", err);
    }
  }
}
