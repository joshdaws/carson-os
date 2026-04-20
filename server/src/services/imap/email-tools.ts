/**
 * IMAP email tool definitions + handler.
 *
 * Tools (read-only):
 *   - imap_triage  — "Any important emails?" — recent unread messages summary
 *   - imap_read    — "Read that email from Tyler" — full content by message ID
 *   - imap_search  — "Find emails about the invoice" — search by Gmail-style query
 *
 * Message IDs use format "<mailbox>:<uid>" (e.g. "INBOX:12345").
 * No send, compose, draft, reply, or delete tools — read-only.
 */

import type { ToolDefinition, ToolResult } from "@carsonos/shared";
import type { ImapProvider } from "./imap-provider.js";

export const IMAP_EMAIL_TOOLS: ToolDefinition[] = [
  {
    name: "imap_triage",
    description:
      "Check the email inbox for recent or unread messages. Shows sender, subject, and date for each. Use when someone asks about their email, inbox, or if anything important came in.",
    input_schema: {
      type: "object",
      properties: {
        mailbox: {
          type: "string",
          description: "Mailbox to check (default: INBOX).",
        },
        max: {
          type: "number",
          description: "Maximum number of messages to return (default: 20).",
        },
        unreadOnly: {
          type: "boolean",
          description:
            "If true, only return unread messages. If false, return all recent messages. Default: true.",
        },
      },
    },
  },
  {
    name: "imap_read",
    description:
      "Read the full content of a specific email by its message ID. Message IDs come from imap_triage or imap_search results. Use when someone wants to read, open, or see the details of a specific email.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            'Message ID to read (format: "<mailbox>:<uid>", e.g. "INBOX:12345"). Obtained from imap_triage or imap_search.',
        },
      },
      required: ["id"],
    },
  },
  {
    name: "imap_search",
    description:
      'Search email messages by query. Supports Gmail-style operators: from:address, to:address, subject:text, body:text, before:YYYY-MM-DD, after:YYYY-MM-DD, is:unread, is:read, is:flagged. Unrecognised terms are full-text searched. Example: "from:boss is:unread" or "subject:invoice after:2026-01-01".',
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Search query using Gmail-style operators, e.g. "from:tyler soccer" or "subject:invoice is:unread".',
        },
        mailbox: {
          type: "string",
          description: "Mailbox to search (default: INBOX).",
        },
        max: {
          type: "number",
          description: "Maximum number of results (default: 20).",
        },
      },
      required: ["query"],
    },
  },
];

// ── Handler ────────────────────────────────────────────────────────

export function createImapEmailToolHandler(
  provider: ImapProvider,
  memberSlug: string,
): (name: string, input: Record<string, unknown>) => Promise<ToolResult> {
  return async (name, input) => {
    try {
      switch (name) {
        case "imap_triage": {
          const messages = await provider.triageInbox(memberSlug, {
            mailbox: input.mailbox as string | undefined,
            max: input.max as number | undefined,
            unreadOnly: input.unreadOnly as boolean | undefined,
          });

          if (messages.length === 0) {
            const qualifier =
              input.unreadOnly === false ? "recent" : "unread";
            return { content: `No ${qualifier} messages.` };
          }

          const lines = messages.map(
            (m) => `- ${m.from}: ${m.subject} (${m.date}) [id: ${m.id}]`,
          );
          return {
            content: `${messages.length} message(s):\n${lines.join("\n")}`,
          };
        }

        case "imap_read": {
          const message = await provider.readMessage(
            memberSlug,
            input.id as string,
          );

          const parts: string[] = [
            `From: ${message.from}`,
          ];
          if (message.to) parts.push(`To: ${message.to}`);
          parts.push(`Subject: ${message.subject}`);
          parts.push(`Date: ${message.date}`);
          parts.push("");
          parts.push(message.body ?? "(empty)");

          return { content: parts.join("\n") };
        }

        case "imap_search": {
          const messages = await provider.searchMessages(
            memberSlug,
            input.query as string,
            {
              mailbox: input.mailbox as string | undefined,
              max: input.max as number | undefined,
            },
          );

          if (messages.length === 0) {
            return {
              content: `No messages found matching "${input.query}".`,
            };
          }

          const lines = messages.map(
            (m) => `- ${m.from}: ${m.subject} (${m.date}) [id: ${m.id}]`,
          );
          return {
            content: `${messages.length} message(s):\n${lines.join("\n")}`,
          };
        }

        default:
          return { content: `Unknown IMAP tool: ${name}`, is_error: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `IMAP error: ${msg}`, is_error: true };
    }
  };
}
