/**
 * Gmail tool definitions + handler.
 *
 * Tools:
 *   - gmail_triage     — "Any important emails?"
 *   - gmail_read       — "Read that email from Tyler"
 *   - gmail_send       — "Send Tyler an email about Saturday"
 *   - gmail_reply      — "Reply and say yes"
 *   - gmail_search     — "Find emails about the soccer tournament"
 */

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
    name: "gmail_send",
    description:
      "Send a new email. Always confirm the recipient and content with the user before sending.",
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
      "Reply to an existing email thread. Uses the message ID from gmail_triage or gmail_read results.",
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
  provider: GoogleCalendarProvider, // reuse the same gws wrapper
  memberSlug: string,
): (name: string, input: Record<string, unknown>) => Promise<ToolResult> {
  return async (name, input) => {
    try {
      switch (name) {
        case "gmail_triage": {
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

        case "gmail_send": {
          const args = [
            "gmail", "+send",
            "--to", input.to as string,
            "--subject", input.subject as string,
            "--body", input.body as string,
            "--format", "json",
          ];
          if (input.cc) args.push("--cc", input.cc as string);

          const stdout = await provider.gws(memberSlug, args);
          return { content: `Email sent. ${stdout.trim()}` };
        }

        case "gmail_reply": {
          const args = [
            "gmail", "+reply",
            "--message-id", input.messageId as string,
            "--body", input.body as string,
            "--format", "json",
          ];

          const stdout = await provider.gws(memberSlug, args);
          return { content: `Reply sent. ${stdout.trim()}` };
        }

        case "gmail_search": {
          const args = [
            "gmail", "+triage",
            "--query", input.query as string,
            "--max", String(input.max ?? 10),
            "--format", "json",
          ];

          const stdout = await provider.gws(memberSlug, args);
          const jsonStart = stdout.indexOf("[");
          if (jsonStart < 0) return { content: "No emails found." };
          const messages = JSON.parse(stdout.slice(jsonStart));

          if (!Array.isArray(messages) || messages.length === 0) {
            return { content: "No emails matching that search." };
          }

          const formatted = messages
            .map((m: Record<string, string>) =>
              `- ${m.from ?? "Unknown"}: ${m.subject ?? "(no subject)"} (${m.date ?? ""}) [id: ${m.id ?? ""}]`
            )
            .join("\n");

          return { content: `${messages.length} results:\n${formatted}` };
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
