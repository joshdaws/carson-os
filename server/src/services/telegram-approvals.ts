/**
 * Telegram Approval Handler -- inline button delivery for task approvals.
 *
 * When Carson oversight escalates a task (the agent can't auto-approve),
 * this sends an inline keyboard to the parent's Telegram chat so they
 * can approve or reject without opening the dashboard.
 *
 * Integrates with the MultiRelayManager's bot instances and the
 * TaskEngine's approve/reject lifecycle.
 */

import { Bot, InlineKeyboard } from "grammy";
import type { Db } from "@carsonos/db";
import { tasks, staffAgents, familyMembers, staffAssignments } from "@carsonos/db";
import { eq, and } from "drizzle-orm";
import type { TaskEngine } from "./task-engine.js";

// ── Types ───────────────────────────────────────────────────────────

interface ApprovalConfig {
  db: Db;
  taskEngine: TaskEngine;
}

interface ManagedBotRef {
  bot: Bot;
  agentId: string;
}

// Telegram callback_data has a 64-byte limit. UUIDs are 36 chars,
// so "approve:" (8) + 36 = 44, well within range. But if IDs are
// ever longer (e.g. prefixed), we truncate to be safe.
const CALLBACK_PREFIX_APPROVE = "approve:";
const CALLBACK_PREFIX_REJECT = "reject:";
const CALLBACK_DATA_MAX_BYTES = 64;

// ── Handler ─────────────────────────────────────────────────────────

export class TelegramApprovalHandler {
  private db: Db;
  private taskEngine: TaskEngine;

  constructor(config: ApprovalConfig) {
    this.db = config.db;
    this.taskEngine = config.taskEngine;
  }

  /**
   * Send an approval request with inline Approve/Reject buttons.
   */
  async sendApprovalRequest(
    task: typeof tasks.$inferSelect,
    bot: Bot,
    parentTelegramId: string,
  ): Promise<void> {
    try {
      // Look up the agent name for the message
      const [agent] = await this.db
        .select()
        .from(staffAgents)
        .where(eq(staffAgents.id, task.agentId));

      const agentName = agent?.name ?? "Unknown agent";

      // Build callback data, truncating taskId if needed to fit 64-byte limit
      const approveData = this.buildCallbackData(CALLBACK_PREFIX_APPROVE, task.id);
      const rejectData = this.buildCallbackData(CALLBACK_PREFIX_REJECT, task.id);

      const keyboard = new InlineKeyboard()
        .text("Approve", approveData)
        .text("Reject", rejectData);

      // Build the message body
      const lines: string[] = [
        "<b>Task Approval Required</b>",
        "",
        task.title,
        `Agent: ${agentName}`,
      ];

      if (task.description) {
        lines.push(`Details: ${task.description}`);
      }

      const message = lines.join("\n");

      await bot.api.sendMessage(parentTelegramId, message, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });

      console.log(
        `[telegram-approvals] Sent approval request for task "${task.title}" to ${parentTelegramId}`,
      );
    } catch (err) {
      console.error(
        `[telegram-approvals] Failed to send approval request for task ${task.id}:`,
        err,
      );
    }
  }

  /**
   * Parse callback data and execute the approve/reject action.
   * Returns the action taken and the task title for the response message.
   */
  async handleCallback(
    callbackData: string,
    userId: string,
  ): Promise<{ action: string; taskTitle: string }> {
    // Parse action and taskId
    let action: "approve" | "reject";
    let taskId: string;

    if (callbackData.startsWith(CALLBACK_PREFIX_APPROVE)) {
      action = "approve";
      taskId = callbackData.slice(CALLBACK_PREFIX_APPROVE.length);
    } else if (callbackData.startsWith(CALLBACK_PREFIX_REJECT)) {
      action = "reject";
      taskId = callbackData.slice(CALLBACK_PREFIX_REJECT.length);
    } else {
      throw new Error(`Unknown callback format: ${callbackData}`);
    }

    // Verify the user is a parent
    const [member] = await this.db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.telegramUserId, userId))
      .limit(1);

    if (!member) {
      throw new Error("Unrecognized user");
    }

    if (member.role !== "parent") {
      throw new Error("Only parents can approve or reject tasks");
    }

    // Load the task to get the title
    const task = await this.taskEngine.getTask(taskId);
    if (!task) {
      throw new Error("Task not found");
    }

    // Execute the action
    if (action === "approve") {
      await this.taskEngine.approveTask(taskId, member.id);
    } else {
      await this.taskEngine.rejectTask(taskId, member.id, "Rejected via Telegram");
    }

    console.log(
      `[telegram-approvals] Task "${task.title}" ${action}d by ${member.name}`,
    );

    return {
      action,
      taskTitle: task.title,
    };
  }

  /**
   * Register the callback_query handler on a bot instance.
   * Call this once per bot during startup.
   */
  registerCallbackHandler(bot: Bot): void {
    bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;

      // Only handle our approval callbacks
      if (
        !data.startsWith(CALLBACK_PREFIX_APPROVE) &&
        !data.startsWith(CALLBACK_PREFIX_REJECT)
      ) {
        return;
      }

      const userId = String(ctx.from.id);

      try {
        const { action, taskTitle } = await this.handleCallback(data, userId);

        // Look up the parent's name for the confirmation
        const [member] = await this.db
          .select()
          .from(familyMembers)
          .where(eq(familyMembers.telegramUserId, userId))
          .limit(1);

        const parentName = member?.name ?? "Parent";
        const actionPastTense = action === "approve" ? "Approved" : "Rejected";

        // Answer the callback query (dismisses the loading spinner)
        await ctx.answerCallbackQuery({
          text: `${actionPastTense}: ${taskTitle}`,
        });

        // Edit the original message to show the result and remove the keyboard
        await ctx.editMessageText(
          `${actionPastTense} by ${parentName}: ${taskTitle}`,
          { reply_markup: undefined },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Something went wrong";
        console.error(`[telegram-approvals] Callback error:`, err);

        try {
          await ctx.answerCallbackQuery({
            text: message,
            show_alert: true,
          });
        } catch {
          // swallow -- callback might have expired
        }
      }
    });
  }

  /**
   * Find the right bot and parent Telegram ID for sending an approval
   * in a given household. Looks for a parent with a Telegram ID who
   * is assigned to one of the running bots.
   */
  async findParentBotAndTelegramId(
    householdId: string,
    bots: Map<string, ManagedBotRef>,
  ): Promise<{ bot: Bot; telegramId: string } | null> {
    // Find all parents in the household
    const parents = await this.db
      .select()
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.householdId, householdId),
          eq(familyMembers.role, "parent"),
        ),
      );

    if (parents.length === 0) {
      console.warn(
        `[telegram-approvals] No parents found in household ${householdId}`,
      );
      return null;
    }

    // For each parent with a Telegram ID, find an assigned bot
    for (const parent of parents) {
      if (!parent.telegramUserId) continue;

      // Find which agents this parent is assigned to
      const assignments = await this.db
        .select()
        .from(staffAssignments)
        .where(eq(staffAssignments.memberId, parent.id));

      for (const assignment of assignments) {
        const managed = bots.get(assignment.agentId);
        if (managed) {
          return {
            bot: managed.bot,
            telegramId: parent.telegramUserId,
          };
        }
      }
    }

    console.warn(
      `[telegram-approvals] No parent in household ${householdId} has a Telegram ID with an assigned running bot`,
    );
    return null;
  }

  // ── Private helpers ───────────────────────────────────────────────

  /**
   * Build callback data string, truncating the taskId if the combined
   * result would exceed Telegram's 64-byte callback_data limit.
   */
  private buildCallbackData(prefix: string, taskId: string): string {
    const maxIdBytes = CALLBACK_DATA_MAX_BYTES - Buffer.byteLength(prefix, "utf-8");
    const idBytes = Buffer.byteLength(taskId, "utf-8");

    if (idBytes <= maxIdBytes) {
      return `${prefix}${taskId}`;
    }

    // Truncate to fit. Since UUIDs are ASCII this is safe.
    const truncated = Buffer.from(taskId, "utf-8").subarray(0, maxIdBytes).toString("utf-8");
    console.warn(
      `[telegram-approvals] Truncated taskId from ${idBytes} to ${maxIdBytes} bytes for callback_data`,
    );
    return `${prefix}${truncated}`;
  }
}
