/**
 * Redaction tools — let agents scrub sensitive content from the conversation
 * record after they've processed it (e.g. an API token the user pasted into
 * chat that's now safely stored via store_secret).
 *
 * M1 scope: redacts the `messages.content` field in SQLite AND appends an
 * activity_log entry so there's an audit trail. Telegram Bot API deletion
 * of the original user message is a follow-up — the user can manually swipe-
 * delete from their Telegram client for now.
 *
 * How to use (for agents): see GUIDE.md in custom-tools/ under "Secret hygiene".
 */

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { activityLog, conversations, messages } from "@carsonos/db";
import type { ToolDefinition, ToolResult } from "@carsonos/shared";

export const REDACTION_TOOLS: ToolDefinition[] = [
  {
    name: "redact_recent_user_message",
    description:
      "Scrub the most recent user message in this conversation (replace its content with a redaction marker) and log an audit entry. " +
      "Use this IMMEDIATELY after store_secret succeeds, so the API token the user pasted doesn't sit in plaintext in the message history. " +
      "Example: redact_recent_user_message({ reason: 'contained API token' }). " +
      "The user's Telegram client will still show their message in scrollback (they can swipe-delete manually); this call is about the server-side record.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Short explanation of why this message is being redacted. Stored in the audit log and shown in place of the content. Example: 'contained API token'.",
        },
      },
      required: ["reason"],
    },
  },
];

export const REDACTION_TOOL_NAMES = new Set(REDACTION_TOOLS.map((t) => t.name));

export interface RedactionToolContext {
  db: Db;
  agentId: string;
  memberId: string;
  householdId: string;
}

export async function handleRedactionTool(
  ctx: RedactionToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (name !== "redact_recent_user_message") {
    return { content: `Unknown redaction tool: ${name}`, is_error: true };
  }
  const reason = String(input.reason ?? "").trim();
  if (!reason) {
    return {
      content: "reason is required. Example: redact_recent_user_message({ reason: 'contained API token' }).",
      is_error: true,
    };
  }

  // Find the active conversation for this (agent, member) pair
  const conversation = ctx.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.agentId, ctx.agentId), eq(conversations.memberId, ctx.memberId)))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1)
    .all()[0];

  if (!conversation) {
    return { content: "No active conversation found. Cannot redact.", is_error: true };
  }

  // Find the most recent user message in that conversation
  const recentUserMsg = ctx.db
    .select({
      id: messages.id,
      content: messages.content,
      metadata: messages.metadata,
    })
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), eq(messages.role, "user")))
    .orderBy(desc(messages.createdAt))
    .limit(1)
    .all()[0];

  if (!recentUserMsg) {
    return { content: "No recent user message found to redact.", is_error: true };
  }

  // Already redacted? idempotent success
  const originalContent = recentUserMsg.content;
  if (originalContent.startsWith("[REDACTED:")) {
    return { content: "That message was already redacted. No action taken." };
  }

  const redactedContent = `[REDACTED: ${reason}]`;
  const originalLength = originalContent.length;

  // Parse existing metadata (may be JSON string) and add redaction info
  let metadataObj: Record<string, unknown> = {};
  const rawMetadata = recentUserMsg.metadata;
  if (typeof rawMetadata === "string" && rawMetadata.length > 0) {
    try {
      metadataObj = JSON.parse(rawMetadata) as Record<string, unknown>;
    } catch {
      /* keep empty if malformed */
    }
  } else if (rawMetadata && typeof rawMetadata === "object") {
    metadataObj = { ...(rawMetadata as Record<string, unknown>) };
  }
  metadataObj.redacted = true;
  metadataObj.redactedReason = reason;
  metadataObj.redactedAt = new Date().toISOString();
  metadataObj.originalLength = originalLength;

  ctx.db
    .update(messages)
    .set({ content: redactedContent, metadata: JSON.stringify(metadataObj) })
    .where(eq(messages.id, recentUserMsg.id))
    .run();

  // Log the redaction for audit
  ctx.db
    .insert(activityLog)
    .values({
      id: crypto.randomUUID(),
      householdId: ctx.householdId,
      agentId: ctx.agentId,
      action: "redact_user_message",
      details: JSON.stringify({
        messageId: recentUserMsg.id,
        reason,
        originalLength,
      }),
    })
    .run();

  return {
    content: `Redacted the most recent user message (${originalLength} chars). Reason: ${reason}. The user's Telegram scrollback will still show the original — they can swipe-delete it from their end if they want it gone from the device.`,
  };
}
