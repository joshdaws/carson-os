/**
 * Gmail tool definitions + handler.
 *
 * Tools:
 *   - gmail_triage       — "Any important emails?"
 *   - gmail_read         — "Read that email from Tyler"
 *   - gmail_compose      — "Write Tyler an email about Saturday" (creates draft)
 *   - gmail_reply        — "Reply and say yes" (creates draft reply)
 *   - gmail_update_draft — "Change the subject line" (updates existing draft)
 *   - gmail_send_draft   — "That looks good, send it" (sends a draft)
 *   - gmail_search       — "Find emails about the soccer tournament"
 *
 * compose and reply create DRAFTS by default. The user reviews in Gmail,
 * then either sends from Gmail or tells the agent "send it."
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolDefinition, ToolResult } from "@carsonos/shared";
import type { GoogleCalendarProvider } from "./calendar-provider.js";

export const GMAIL_TOOLS: ToolDefinition[] = [
  {
    name: "gmail_triage",
    description:
      "Check inbox for recent or unread emails. Shows sender, subject, and date. Use when someone asks about their email, inbox, or if anything important came in.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Gmail search query (e.g., 'is:unread', 'from:boss', 'subject:invoice'). Defaults to unread.",
        },
        max: {
          type: "number",
          description: "Max messages to show (default: 10).",
        },
      },
    },
  },
  {
    name: "gmail_read",
    description:
      "Read the full content of a specific email by its message ID (from gmail_triage results).",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The Gmail message ID to read.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "gmail_compose",
    description:
      "Compose a new email and save it as a draft. The draft appears in Gmail for the user to review before sending. Always tell the user: 'Draft is waiting in Gmail.' If they want changes, use gmail_update_draft. If they approve, use gmail_send_draft.",
    input_schema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient email address(es), comma-separated.",
        },
        subject: {
          type: "string",
          description: "Email subject line.",
        },
        body: {
          type: "string",
          description: "Email body (plain text).",
        },
        cc: {
          type: "string",
          description: "CC email address(es), comma-separated (optional).",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "gmail_reply",
    description:
      "Draft a reply to an existing email thread. Creates a draft (does NOT send). Uses the message ID from gmail_triage or gmail_read results. Tell the user: 'Reply draft is waiting in Gmail.'",
    input_schema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "Gmail message ID to reply to.",
        },
        body: {
          type: "string",
          description: "Reply body (plain text).",
        },
      },
      required: ["messageId", "body"],
    },
  },
  {
    name: "gmail_update_draft",
    description:
      "Update an existing draft's content. Use when the user asks to change something in a draft you composed.",
    input_schema: {
      type: "object",
      properties: {
        draftId: {
          type: "string",
          description: "The draft ID (from gmail_compose or gmail_reply results).",
        },
        to: {
          type: "string",
          description: "Updated recipient(s) (optional — keeps original if omitted).",
        },
        subject: {
          type: "string",
          description: "Updated subject (optional).",
        },
        body: {
          type: "string",
          description: "Updated body (required — replaces entire body).",
        },
        cc: {
          type: "string",
          description: "Updated CC (optional).",
        },
      },
      required: ["draftId", "body"],
    },
  },
  {
    name: "gmail_send_draft",
    description:
      "Send a previously composed draft. Only use when the user explicitly approves sending (e.g., 'send it', 'looks good, go ahead').",
    input_schema: {
      type: "object",
      properties: {
        draftId: {
          type: "string",
          description: "The draft ID to send.",
        },
      },
      required: ["draftId"],
    },
  },
  {
    name: "gmail_search",
    description:
      "Search Gmail for messages matching a query. Use Gmail search syntax.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Gmail search query (e.g., 'from:tyler soccer tournament', 'has:attachment pdf').",
        },
        max: {
          type: "number",
          description: "Max results (default: 10).",
        },
      },
      required: ["query"],
    },
  },
];

// ── Handler ────────────────────────────────────────────────────────

export function createGmailToolHandler(
  provider: GoogleCalendarProvider,
  memberSlug: string,
): (name: string, input: Record<string, unknown>) => Promise<ToolResult> {
  return async (name, input) => {
    try {
      switch (name) {
        case "gmail_triage":
        case "gmail_search": {
          const args = ["gmail", "+triage", "--format", "json"];
          if (input.query) args.push("--query", input.query as string);
          args.push("--max", String(input.max ?? 10));

          const stdout = await provider.gws(memberSlug, args);
          const jsonStart = stdout.indexOf("[");
          if (jsonStart < 0) return { content: "No emails found." };
          const messages = JSON.parse(stdout.slice(jsonStart));

          if (!Array.isArray(messages) || messages.length === 0) {
            return { content: "No emails found." };
          }

          const formatted = messages
            .map((m: Record<string, string>) =>
              `- ${m.from ?? "Unknown"}: ${m.subject ?? "(no subject)"} (${m.date ?? ""}) [id: ${m.id ?? ""}]`
            )
            .join("\n");

          return { content: `${messages.length} messages:\n${formatted}` };
        }

        case "gmail_read": {
          const args = ["gmail", "+read", "--id", input.id as string, "--headers", "--format", "json"];
          const stdout = await provider.gws(memberSlug, args);
          const jsonStart = stdout.indexOf("{");
          const msg = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart) : stdout);

          const parts = [];
          if (msg.from) parts.push(`From: ${msg.from}`);
          if (msg.to) parts.push(`To: ${msg.to}`);
          if (msg.subject) parts.push(`Subject: ${msg.subject}`);
          if (msg.date) parts.push(`Date: ${msg.date}`);
          parts.push("");
          parts.push(msg.body ?? msg.text ?? "(empty)");

          return { content: parts.join("\n") };
        }

        case "gmail_compose": {
          const raw = buildRawEmail({
            to: input.to as string,
            subject: input.subject as string,
            body: input.body as string,
            cc: input.cc as string | undefined,
          });

          const tmpFile = join(tmpdir(), `carsonos-draft-${Date.now()}.eml`);
          writeFileSync(tmpFile, raw);

          try {
            const args = [
              "gmail", "users", "drafts", "create",
              "--params", JSON.stringify({ userId: "me" }),
              "--upload", tmpFile,
              "--upload-content-type", "message/rfc822",
              "--format", "json",
            ];

            const stdout = await provider.gws(memberSlug, args);
            const jsonStart = stdout.indexOf("{");
            const result = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart) : stdout);
            const draftId = result.id ?? "unknown";

            return {
              content: `Draft created (id: ${draftId}). It's waiting in Gmail for review. To send: tell me "send it" or send from Gmail directly.`,
            };
          } finally {
            try { unlinkSync(tmpFile); } catch { /* ignore */ }
          }
        }

        case "gmail_reply": {
          // First read the original message to get headers
          const readArgs = ["gmail", "+read", "--id", input.messageId as string, "--headers", "--format", "json"];
          const readOut = await provider.gws(memberSlug, readArgs);
          const readStart = readOut.indexOf("{");
          const original = JSON.parse(readStart >= 0 ? readOut.slice(readStart) : readOut);

          const replyTo = original.from ?? "";
          const subject = original.subject?.startsWith("Re: ")
            ? original.subject
            : `Re: ${original.subject ?? ""}`;

          const raw = buildRawEmail({
            to: replyTo,
            subject,
            body: input.body as string,
            inReplyTo: input.messageId as string,
            threadId: original.threadId,
          });

          const tmpFile = join(tmpdir(), `carsonos-reply-${Date.now()}.eml`);
          writeFileSync(tmpFile, raw);

          try {
            const draftJson: Record<string, unknown> = {
              message: { threadId: original.threadId },
            };
            const args = [
              "gmail", "users", "drafts", "create",
              "--params", JSON.stringify({ userId: "me" }),
              "--json", JSON.stringify(draftJson),
              "--upload", tmpFile,
              "--upload-content-type", "message/rfc822",
              "--format", "json",
            ];

            const stdout = await provider.gws(memberSlug, args);
            const jsonStart = stdout.indexOf("{");
            const result = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart) : stdout);
            const draftId = result.id ?? "unknown";

            return {
              content: `Reply draft created (id: ${draftId}). It's waiting in Gmail for review. To send: tell me "send it" or send from Gmail directly.`,
            };
          } finally {
            try { unlinkSync(tmpFile); } catch { /* ignore */ }
          }
        }

        case "gmail_update_draft": {
          const raw = buildRawEmail({
            to: input.to as string | undefined ?? "",
            subject: input.subject as string | undefined ?? "",
            body: input.body as string,
            cc: input.cc as string | undefined,
          });

          const tmpFile = join(tmpdir(), `carsonos-draft-update-${Date.now()}.eml`);
          writeFileSync(tmpFile, raw);

          try {
            const args = [
              "gmail", "users", "drafts", "update",
              "--params", JSON.stringify({ userId: "me", id: input.draftId as string }),
              "--upload", tmpFile,
              "--upload-content-type", "message/rfc822",
              "--format", "json",
            ];

            const stdout = await provider.gws(memberSlug, args);
            const jsonStart = stdout.indexOf("{");
            const result = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart) : stdout);

            return { content: `Draft updated (id: ${result.id ?? input.draftId}). Review in Gmail.` };
          } finally {
            try { unlinkSync(tmpFile); } catch { /* ignore */ }
          }
        }

        case "gmail_send_draft": {
          const args = [
            "gmail", "users", "drafts", "send",
            "--params", JSON.stringify({ userId: "me" }),
            "--json", JSON.stringify({ id: input.draftId as string }),
            "--format", "json",
          ];

          await provider.gws(memberSlug, args);
          return { content: `Draft sent successfully.` };
        }

        default:
          return { content: `Unknown Gmail tool: ${name}`, is_error: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Gmail error: ${msg}`, is_error: true };
    }
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function buildRawEmail(opts: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  inReplyTo?: string;
  threadId?: string;
}): string {
  const lines = [
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
  ];
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  lines.push("", opts.body);
  return lines.join("\r\n");
}
