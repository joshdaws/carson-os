/**
 * CarsonOS v3 -- server entry point.
 *
 * Boot sequence:
 *   1. Database
 *   2. Adapter (claude-code | codex | anthropic-sdk)
 *   3. ConstitutionEngine
 *   4. TaskEngine
 *   5. CarsonOversight
 *   6. InterviewEngine
 *   7. Express app with all routes
 *   8. HTTP server + WebSocket
 *   9. Telegram relay (if configured)
 */

import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createDb } from "@carsonos/db";
import { getConfig } from "./config.js";
import { backupDatabase } from "./services/backup.js";
import { checkForUpdates } from "./services/update-check.js";
import { Scheduler } from "./services/scheduler.js";
import { createApp } from "./app.js";
import { setupWebSocket, broadcast } from "./ws/live-events.js";
import { AppEventBus } from "./services/event-bus.js";
import { createAdapter } from "./services/subprocess-adapter.js";
import { ConstitutionEngine } from "./services/constitution-engine.js";
import { TaskEngine } from "./services/task-engine.js";
import { CarsonOversight } from "./services/carson-oversight.js";
import { InterviewEngine } from "./services/interview.js";
import { ProfileInterviewEngine } from "./services/profile-interview.js";
import { PersonalityInterviewEngine } from "./services/personality-interview.js";
import { Dispatcher } from "./services/dispatcher.js";
import { DelegationService } from "./services/delegation-service.js";
import { WorkspaceProvider } from "./services/delegation/workspace.js";
import {
  DelegationNotifier,
  type TelegramSendFn,
  type TelegramSendResult,
} from "./services/delegation/notifier.js";
import { familyMembers, tasks as tasksTable, conversations, messages, delegationNotifications } from "@carsonos/db";
import { and, desc, eq } from "drizzle-orm";
import { MultiRelayManager } from "./services/multi-relay-manager.js";
import { SignalRelayManager } from "./services/signal-relay-manager.js";
import { bootMemory } from "./services/memory/index.js";
import { hydrateEnvFromSettings } from "./services/env-hydration.js";
import { ToolRegistry } from "./services/tool-registry.js";
import { GoogleCalendarProvider, CALENDAR_TOOLS, GMAIL_TOOLS, DRIVE_TOOLS } from "./services/google/index.js";
import { CalDavProvider, CALDAV_CALENDAR_TOOLS } from "./services/caldav/index.js";
import { ImapProvider, IMAP_EMAIL_TOOLS } from "./services/imap/index.js";

// Read VERSION from the repo root (two levels up from server/src/). Single
// source of truth — bumping VERSION at ship time updates the boot banner
// without a separate code change.
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const versionPath = join(here, "..", "..", "VERSION");
    return readFileSync(versionPath, "utf8").trim();
  } catch {
    return "unknown";
  }
}

const BANNER = [
  "",
  ` CarsonOS v${readVersion()}`,
  " Your family's values, your family's AI.",
  "",
].join("\n");

async function main() {
  const config = getConfig();
  const dbPath = join(config.dataDir, "carsonos.db");
  const eventBus = new AppEventBus();

  // Ensure data directory exists
  mkdirSync(config.dataDir, { recursive: true });

  // Check if our port is in use and warn (don't kill — could be unrelated).
  // If it's a stale CarsonOS, launchd/systemd already stopped the old one.
  try {
    const pids = execFileSync("lsof", ["-ti", `:${config.port}`], { encoding: "utf-8" }).trim();
    if (pids) {
      console.warn(`[boot] Port ${config.port} in use by PID(s): ${pids.replace(/\n/g, ", ")}. Will retry...`);
      // Wait briefly for the old process to finish shutting down
      const start = Date.now();
      while (Date.now() - start < 3000) {
        try {
          execFileSync("lsof", ["-ti", `:${config.port}`], { encoding: "utf-8" });
        } catch { break; } // port free
      }
    }
  } catch { /* port free, or lsof not available */ }

  // 0. Backup database before anything touches it
  backupDatabase(dbPath, config.dataDir, "boot");

  // 1. Boot database (pre-migration hook creates another backup if schema changes)
  const db = createDb(dbPath, (reason) => {
    backupDatabase(dbPath, config.dataDir, reason);
  });
  console.log(`[db] SQLite open at ${dbPath}`);

  // 1b. Hydrate allow-listed platform secrets (currently GROQ_API_KEY) from
  // instance_settings into process.env so services that read process.env can
  // pick up keys saved via the Settings UI without the operator editing files.
  await hydrateEnvFromSettings(db);

  // 2. Create adapter
  const adapter = createAdapter(config.adapterType);
  const adapterHealthy = await adapter.healthCheck();
  console.log(
    `[adapter] ${adapter.name} — ${adapterHealthy ? "healthy" : "unavailable"}`,
  );

  // 2b. Boot memory system
  let memoryProvider = undefined;
  try {
    memoryProvider = await bootMemory(db, config.memory);
    console.log(`[memory] Provider ready (${config.memory.kind}) at ${config.memory.rootDir}`);
  } catch (err) {
    console.warn("[memory] Boot failed, running without memory:", err);
  }

  // 2c. External providers
  const googleDir = join(config.dataDir, "google");
  const calendarProvider = new GoogleCalendarProvider(googleDir);
  const gwsHealthy = await calendarProvider.healthCheck();
  console.log(`[google] Calendar provider ${gwsHealthy ? "ready" : "unavailable (gws not installed)"}`);

  // CalDAV — always available, no external CLI dependency. Used for members
  // with iCloud/CalDAV credentials. Wins over Google at dispatch time for
  // members who have creds saved.
  const caldavDir = join(config.dataDir, "caldav");
  const caldavProvider = new CalDavProvider(caldavDir);
  console.log("[caldav] Calendar provider ready");

  // IMAP — always available, no external CLI dependency.
  // Per-member credentials resolved at dispatch time.
  const imapDir = join(config.dataDir, "imap");
  const imapProvider = new ImapProvider(imapDir);
  console.log("[imap] Email provider ready");

  // 2d. Tool registry
  const toolRegistry = new ToolRegistry(db);
  toolRegistry.setDataDir(config.dataDir);

  // Register calendar tools (per-member handler created at call time)
  if (gwsHealthy) {
    // Calendar tools need the member slug at execution time, so we register
    // a handler factory that the constitution engine will call per-message.
    // For now, register the tool definitions so they show up in grants.
    const googlePlaceholder = async (_name: string, _input: Record<string, unknown>) => ({
      content: "Google not configured for this member. Run gws auth login.",
      is_error: true as const,
    });

    toolRegistry.registerAll(
      CALENDAR_TOOLS.map((def) => ({ definition: def, category: "calendar", tier: "builtin" as const })),
      googlePlaceholder,
    );
    toolRegistry.registerAll(
      GMAIL_TOOLS.map((def) => ({ definition: def, category: "gmail", tier: "builtin" as const })),
      googlePlaceholder,
    );
    toolRegistry.registerAll(
      DRIVE_TOOLS.map((def) => ({ definition: def, category: "drive", tier: "builtin" as const })),
      googlePlaceholder,
    );
  } else {
    // gws not installed — register calendar tools under CalDAV so agents can
    // still use the calendar tools for members with CalDAV credentials saved.
    const caldavPlaceholder = async (_name: string, _input: Record<string, unknown>) => ({
      content: "CalDAV not configured for this member. Save credentials to ~/.carsonos/caldav/<member>/credentials.json",
      is_error: true as const,
    });

    toolRegistry.registerAll(
      CALDAV_CALENDAR_TOOLS.map((def) => ({ definition: def, category: "calendar", tier: "builtin" as const })),
      caldavPlaceholder,
    );
  }

  // Register IMAP email tools (always available — per-member auth checked at call time)
  const imapPlaceholder = async (_name: string, _input: Record<string, unknown>) => ({
    content: "IMAP not configured for this member. Save credentials to ~/.carsonos/imap/<member>/credentials.json",
    is_error: true as const,
  });

  toolRegistry.registerAll(
    IMAP_EMAIL_TOOLS.map((def) => ({ definition: def, category: "email", tier: "builtin" as const })),
    imapPlaceholder,
  );

  // Skills are enabled via trust level ("Skill" built-in for full trust).
  // No need to discover/register them — the SDK handles skill loading.

  // Load custom tools (SKILL.md files on disk) into the registry
  const { loadCustomTools } = await import("./services/custom-tools/index.js");
  await loadCustomTools(db, toolRegistry);

  console.log(`[tools] Registry ready (${toolRegistry.listAll().length} tools registered)`);

  // Seed any newly-added role defaults to existing agents (protects v0.4+
  // DEFAULT_GRANTS changes from the "agents with explicit grants silently
  // miss new role defaults" bug). Per-agent marker in instance_settings so
  // user revocations survive future release cycles.
  await toolRegistry.seedMissingDefaults();

  // 3. Constitution engine
  const constitutionEngine = new ConstitutionEngine({
    db,
    broadcast: eventBus.publish,
    adapter,
    memoryProvider,
    toolRegistry,
    calendarProvider: gwsHealthy ? calendarProvider : undefined,
    caldavProvider,
    imapProvider,
    featureFlags: config.featureFlags,
  });
  console.log("[engine] Constitution engine ready");

  // 4. Task engine
  const taskEngine = new TaskEngine({
    db,
    adapter,
    constitutionEngine,
    broadcast: eventBus.publish,
  });
  console.log("[engine] Task engine ready");

  // 5. Carson oversight
  const oversight = new CarsonOversight({
    db,
    constitutionEngine,
    broadcast: eventBus.publish,
  });
  console.log("[engine] Carson oversight ready");

  // 6. Interview engine
  const interviewEngine = new InterviewEngine({
    db,
    adapter,
  });
  console.log("[engine] Interview engine ready");

  // 6a. Profile interview engine
  const profileInterviewEngine = new ProfileInterviewEngine({
    db,
    adapter,
  });
  console.log("[engine] Profile interview engine ready");

  // 6b. Personality interview engine
  const personalityInterviewEngine = new PersonalityInterviewEngine({
    db,
    adapter,
  });
  console.log("[engine] Personality interview engine ready");

  // 6b-1. Workspace provider (v0.4: per-task git worktree + tool sandbox)
  const workspace = new WorkspaceProvider();

  // 6b-2. Telegram send fn for the notifier. multiRelay doesn't exist yet
  // (boot order: dispatcher → delegation-service → multiRelay), so the send
  // closure resolves the reference lazily. Until multiRelay is bound, sends
  // fail loud so the reconciler retries on next boot — never drops a payload.
  let multiRelayRef: MultiRelayManager | null = null;
  const notifierSend: TelegramSendFn = async (args): Promise<TelegramSendResult> => {
    if (!multiRelayRef) return { ok: false, error: "multiRelay not ready yet" };
    const [member] = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, args.memberId))
      .limit(1);
    if (!member?.telegramUserId) {
      return { ok: false, error: `no telegram user id for member ${args.memberId}` };
    }
    try {
      const { messageId } = await multiRelayRef.sendMessage(
        args.agentId,
        member.telegramUserId,
        args.text,
        { replyMarkup: args.replyMarkup },
      );
      return { ok: true, messageId };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
  const notifier = new DelegationNotifier(db, notifierSend);

  // 6b-3. Dispatcher with v0.4 deps wired
  const dispatcher = new Dispatcher({
    db,
    adapter,
    broadcast: eventBus.publish,
    workspace,
    notifier,
    toolRegistry,
  });
  // Recover any tasks stuck in in_progress from a previous crash. Phase-2
  // notifier replay happens AFTER multiRelay is bound (below); running it
  // here would silently fail because notifierSend can't reach multiRelayRef
  // yet.
  await dispatcher.recoverStuckTasks();
  console.log("[engine] Dispatcher ready (stuck tasks recovered)");

  // 6c. Delegation service (coordinates delegation lifecycle; v0.4)
  const orchestrator = new DelegationService(
    { db, adapter, broadcast: eventBus.publish },
    dispatcher,
    taskEngine,
  );
  orchestrator.setOversight(oversight);
  orchestrator.setNotifier(notifier);
  dispatcher.setDelegationContext(orchestrator, oversight);
  constitutionEngine.setDelegation(orchestrator, oversight);
  console.log("[engine] Delegation service ready (v0.4: MCP delegate_task + hire flow)");

  // 7. Telegram multi-relay (created before app so staff routes can trigger bot starts)
  const multiRelay = new MultiRelayManager({
    db,
    adapter,
    engine: constitutionEngine,
    orchestrator,
  });
  multiRelayRef = multiRelay; // bind the notifier's Telegram send target
  // Phase-2 notifier replay must wait until AFTER multiRelay.startAll() has
  // actually started the agent bots — `sendMessage` throws "Bot for agent X
  // is not running" if the bot isn't started yet. Deferred until after the
  // startAll() call below.

  // Wire multiRelay into the constitution engine (for agent pause/resume tools)
  constitutionEngine.setMultiRelay(multiRelay);

  // v0.4 back-channel wake: when a delegated task completes, DelegationService
  // runs a turn on the delegator's session via processMessage and relays the
  // reply through multiRelay.sendMessage. Wire both deps now that both exist.
  orchestrator.setEngineForWake({
    processMessage: (p) => constitutionEngine.processMessage({ ...p, channel: p.channel as "telegram" | "web" }),
  });
  orchestrator.setSenderForWake((agentId, telegramUserId, text) =>
    multiRelay.sendMessage(agentId, telegramUserId, text),
  );
  orchestrator.setAgentQueueForWake((agentId, memberId, fn) => multiRelay.enqueueAgentWork(agentId, memberId, fn));

  // 7b. Signal relay (agents with signal_account + signal_daemon_port set)
  const signalRelay = new SignalRelayManager({
    db,
    engine: constitutionEngine,
    orchestrator,
  });

  // 8. Create Express app with all dependencies
  const app = await createApp({
    db,
    adapter,
    constitutionEngine,
    taskEngine,
    oversight,
    delegationService: orchestrator,
    interviewEngine,
    profileInterviewEngine,
    personalityInterviewEngine,
    toolRegistry,
    multiRelay,
    signalRelay,
  });

  // 9. Create HTTP server and attach WebSocket
  const server = createServer(app);
  const wss = setupWebSocket(server);

  // 10. Wire event consumers
  eventBus.on("*", broadcast);
  eventBus.on("project.completed", (event) => {
    if (!event.data) return;
    const { parentTaskId } = event.data as { parentTaskId: string };
    orchestrator.handleProjectCompleted(parentTaskId).catch((err: unknown) => {
      console.error("[events] Failed to handle project completion:", err);
    });
  });

  eventBus.on("delegation.result", (event) => {
    if (!event.data) return;
    multiRelay.eventBus.emit("delegation.result", event.data);
    signalRelay.eventBus.emit("delegation.result", event.data);
  });

  // v0.4: when a task is cancelled, tear down its workspace if one was provisioned.
  eventBus.on("task.cancelled", (event) => {
    dispatcher.handleCancelBroadcast(event).catch((err: unknown) => {
      console.error("[events] handleCancelBroadcast failed:", err);
    });
  });

  // v0.4: when a hire is approved, tell the principal via Carson's bot so
  // they get visible feedback (the inline-button edit only stamps the card;
  // the user still needs a chat message saying "Dev is on staff, what's next").
  // Without this, the user taps Approve and hears nothing until they prompt
  // Carson again — the dead-air problem we hit during the first real test.
  eventBus.on("hire.approved", (event) => {
    void (async () => {
      const data = event.data as
        | {
            taskId: string;
            householdId: string;
            developerAgentId: string;
            specialty: string;
            name: string;
          }
        | undefined;
      if (!data) return;
      try {
        const [task] = await db
          .select({
            agentId: tasksTable.agentId,
            requestedBy: tasksTable.requestedBy,
            description: tasksTable.description,
          })
          .from(tasksTable)
          .where(eq(tasksTable.id, data.taskId))
          .limit(1);
        if (!task?.agentId || !task.requestedBy) return;

        const [member] = await db
          .select()
          .from(familyMembers)
          .where(eq(familyMembers.id, task.requestedBy))
          .limit(1);
        if (!member?.telegramUserId) return;

        // Stamp the approval card with "✅ Approved" and strip the buttons.
        // Telegram-path approvals already do this via ctx.editMessageText in
        // the callback_query handler; this is idempotent-enough (editing to
        // the same text just returns "not modified"), and it's the ONLY way
        // to update the card when approval came through the Web UI instead.
        // Previously the web-approval path left live Approve/Reject buttons
        // sitting in Telegram — user would tap one later and race the flow.
        const [notif] = await db
          .select({ deliveredMessageId: delegationNotifications.deliveredMessageId, payload: delegationNotifications.payload })
          .from(delegationNotifications)
          .where(
            and(
              eq(delegationNotifications.taskId, data.taskId),
              eq(delegationNotifications.kind, "hire_proposal"),
            ),
          )
          .limit(1);
        if (notif?.deliveredMessageId) {
          const originalText =
            (notif.payload && typeof notif.payload === "object" && "text" in (notif.payload as Record<string, unknown>)
              ? String((notif.payload as Record<string, unknown>).text ?? "")
              : "") || "";
          const stampedText = `✅ Approved\n\n${originalText}`;
          await multiRelay.editMessage(task.agentId, member.telegramUserId, notif.deliveredMessageId, stampedText).catch(() => {});
        }

        // Pull originalUserRequest out of the hire-proposal metadata. If the
        // proposer passed it, auto-delegate so the user doesn't have to
        // re-prompt. If not (proactive hire), just tell the user the
        // specialist is ready and wait.
        let originalUserRequest: string | undefined;
        try {
          const meta = task.description ? JSON.parse(task.description) : null;
          if (meta && typeof meta.originalUserRequest === "string" && meta.originalUserRequest.trim()) {
            originalUserRequest = meta.originalUserRequest.trim();
          }
        } catch {
          // malformed description — proceed as if no originalUserRequest
        }

        if (!originalUserRequest) {
          const text =
            `✅ **${data.name}** is on staff — ${data.specialty} specialist.\n\n` +
            `Tell me what you want them to work on and I'll delegate it.`;
          await multiRelay.sendMessage(task.agentId, member.telegramUserId, text);
          // Thread the announcement into the agent's conversation so the
          // next turn's resumed SDK session sees "X is on staff" in
          // history. Without this, the system prompt built at session-
          // start is stale and Carson tells the user "X isn't on staff
          // yet" right after he just confirmed the hire. See 2026-04-24
          // E2E testing finding #1.
          await threadHireAnnouncement(db, task.agentId, member.id, text, {
            kind: "hire-approved",
            developerAgentId: data.developerAgentId,
            name: data.name,
            specialty: data.specialty,
          });
          return;
        }

        // Auto-delegation path: run the original request through the
        // delegation service as if the proposing agent had called
        // delegate_task directly. No LLM turn required; handleDelegateTaskCall
        // validates the edge (which we just created on approval), creates
        // the task row with correct depth + workspace kind, and hands it to
        // the dispatcher. User sees one concise status message, then the
        // specialist's completion notification when it finishes.
        const delegated = await orchestrator.handleDelegateTaskCall({
          fromAgentId: task.agentId,
          householdId: data.householdId,
          toAgentName: data.name,
          goal: originalUserRequest,
          requestedByMember: member.id,
        });

        if (!delegated.ok) {
          const text =
            `✅ **${data.name}** is on staff.\n\n` +
            `I tried to auto-delegate your request (_${originalUserRequest.slice(0, 120)}${originalUserRequest.length > 120 ? "…" : ""}_) but hit: ${delegated.error}\n\n` +
            `Just tell me what you want them to do and I'll retry.`;
          await multiRelay.sendMessage(task.agentId, member.telegramUserId, text);
          await threadHireAnnouncement(db, task.agentId, member.id, text, {
            kind: "hire-approved-auto-delegate-failed",
            developerAgentId: data.developerAgentId,
            name: data.name,
            specialty: data.specialty,
          });
          return;
        }

        const text =
          `✅ **${data.name}** is on staff — putting them on it now.\n\n` +
          `_${originalUserRequest}_\n\n` +
          `I'll ping you when they're done. Say "kill ${data.name}'s task" to cancel.`;
        await multiRelay.sendMessage(task.agentId, member.telegramUserId, text);
        await threadHireAnnouncement(db, task.agentId, member.id, text, {
          kind: "hire-approved-auto-delegated",
          developerAgentId: data.developerAgentId,
          name: data.name,
          specialty: data.specialty,
          runId: delegated.runId,
        });
      } catch (err) {
        console.error("[events] hire.approved follow-up failed:", err);
      }
    })();
  });

  // Start per-agent bots (agents with telegramBotToken set)
  await multiRelay.startAll();
  // Start per-agent Signal accounts (agents with signal_account + signal_daemon_port set)
  await signalRelay.startAll();

  // Bots are up now — drive Phase-2 notifier replay for any terminal tasks
  // whose completion/failure payloads were prepared but never delivered
  // (e.g., if the server restarted mid-task or Telegram was flaky at the
  // time). Fire-and-forget so the rest of boot doesn't block on the
  // Telegram round-trips.
  dispatcher.replayPendingNotifications().catch((err: unknown) => {
    console.error("[engine] Phase-2 notification replay failed:", err);
  });

  // Hourly sweep of expired hire proposals. Boot-time pass already fired
  // inside recoverStuckTasks; this catches anything that expires during a
  // long-running session (past the 24h TTL) without waiting for the next
  // restart. Cheap: just an indexed query + conditional UPDATE per hit.
  const APPROVAL_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
  setInterval(() => {
    dispatcher.sweepExpiredApprovals().catch((err: unknown) => {
      console.error("[engine] approval TTL sweep failed:", err);
    });
    // Also re-drive Phase-2 delivery in case any newly-expired tasks
    // prepared payloads — otherwise they'd sit undelivered until the
    // next server restart.
    dispatcher.replayPendingNotifications().catch((err: unknown) => {
      console.error("[engine] approval sweep replay failed:", err);
    });
  }, APPROVAL_SWEEP_INTERVAL_MS);

  // 11. Start the scheduled task ticker
  const scheduler = new Scheduler({
    db,
    engine: constitutionEngine,
    multiRelay,
    memoryProvider,
  });
  scheduler.start();

  // Start listening on loopback only
  server.listen(config.port, "127.0.0.1", () => {
    console.log(BANNER);
    console.log(`  env:      ${config.nodeEnv}`);
    console.log(`  adapter:  ${adapter.name}`);
    console.log(`  port:     ${config.port}`);
    console.log(`  data dir: ${config.dataDir}`);
    console.log(`  db:       ${dbPath}`);
    console.log(`  memory:   ${config.memory.rootDir}`);
    console.log(`  ws:       ws://127.0.0.1:${config.port}/ws`);
    console.log();

    // Check for updates in the background (non-blocking)
    const projectDir = join(import.meta.dirname, "../..");
    checkForUpdates(projectDir).catch(() => {});
  });

  // Graceful shutdown
  //
  // The hard requirement for dev ergonomics: when tsx watch sends SIGTERM, this
  // process MUST fully exit before tsx force-kills it (~5s grace), AND must
  // release port 3300 cleanly so the next process can rebind without
  // EADDRINUSE.
  //
  // Order matters:
  //   1. Stop the bot pollers — releases Telegram's lock so the new process
  //      doesn't 409. Each bot has POLL_TIMEOUT_S = 3s, all stop in parallel.
  //   2. Force-disconnect WebSocket clients — without this, server.close()
  //      hangs on the open ws connections and the port stays bound.
  //   3. Force-disconnect any lingering HTTP keep-alives via closeAllConnections.
  //   4. server.close() releases the port. After this returns, rebinding works.
  //   5. process.exit(0).
  //
  // Hard deadline (4s) under tsx's force-kill so we never get killed mid-shutdown.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received, closing...`);

    const HARD_EXIT_MS = 4_000;
    const exitTimer = setTimeout(() => {
      console.warn("[shutdown] hard deadline hit, exiting");
      process.exit(0);
    }, HARD_EXIT_MS);
    exitTimer.unref();

    void (async () => {
      try {
        await Promise.all([multiRelay.stopAll(), signalRelay.stopAll()]);
      } catch (err) {
        console.error("[shutdown] relay stop error:", err);
      }

      // Force-close all WebSocket clients so server.close() can complete.
      try {
        for (const client of wss.clients) {
          try { client.terminate(); } catch { /* swallow */ }
        }
        wss.close();
      } catch { /* swallow */ }

      // Force-drop lingering keep-alive HTTP connections.
      try { server.closeAllConnections(); } catch { /* swallow */ }

      // Now server.close() returns quickly because nothing is open.
      await new Promise<void>((resolve) => server.close(() => resolve()));

      console.log("[shutdown] done");
      process.exit(0);
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/**
 * Persist a system-announcement message into an agent's conversation with a
 * specific member so the agent's next turn (which resumes the SDK session
 * with a cached system prompt) has the announcement in history. Prevents
 * the "X isn't on staff yet" bug where Carson's prompt was built at
 * session-start, the hire landed during the session, and Carson had no
 * visibility into the change until the prompt was rebuilt.
 *
 * Resilient by design: failure to persist is logged but doesn't block the
 * Telegram send — the user still got the announcement.
 */
async function threadHireAnnouncement(
  db: ReturnType<typeof createDb>,
  agentId: string,
  memberId: string,
  text: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    // Conversation key in the runtime is (agentId, memberId, householdId,
    // channel) — see ConstitutionEngine.getOrCreateConversation. The
    // next turn that must see this announcement is the resumed Telegram
    // turn, so scope to channel="telegram" explicitly. Writing to the
    // wrong conversation row (e.g., a web conversation when the next
    // turn comes through Telegram) reintroduces the stale-staff-cache
    // bug we're closing.
    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.agentId, agentId),
          eq(conversations.memberId, memberId),
          eq(conversations.channel, "telegram"),
        ),
      )
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1);
    if (!conversation) return;

    const now = new Date();
    await db.insert(messages).values({
      conversationId: conversation.id,
      role: "assistant",
      content: text,
      metadata,
    });
    await db
      .update(conversations)
      .set({ lastMessageAt: now.toISOString() })
      .where(eq(conversations.id, conversation.id));
  } catch (err) {
    console.warn("[events] threadHireAnnouncement failed:", err);
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
