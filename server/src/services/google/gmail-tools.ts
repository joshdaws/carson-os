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
import { convert as htmlToTextConvert } from "html-to-text";
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

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Extract a single balanced JSON value (object or array) from `s` starting at
 * index `start`. The `gws` CLI sometimes appends non-JSON content (e.g. a
 * keyring backend status line) after its JSON output, which causes
 * `JSON.parse` to choke on the trailing garbage. Walking the string with
 * bracket/string-aware depth tracking lets us slice off exactly the JSON
 * portion regardless of what follows it.
 */
function extractBalancedJson(s: string, start: number): string {
  const open = s[start];
  const close = open === "[" ? "]" : open === "{" ? "}" : "";
  if (!close) return s.slice(start);
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start);
}

/**
 * Convert HTML email body to readable plain text. Marketing and transactional
 * emails frequently come back HTML-only (or with HTML as the dominant part);
 * the agent needs something readable to summarize from. We use the
 * `html-to-text` library configured to:
 *
 * - render links inline as `text [https://url]` (the format the task spec
 *   asked for and what scans cleanly when the agent quotes back to the user),
 * - drop tracking-only artifacts (images, style/script, base64 src),
 * - preserve list structure with `-` bullets,
 * - flatten the layout-table soup that marketing senders love so it doesn't
 *   render as a column of single-word lines.
 *
 * Exported so unit tests can pin the conversion behavior.
 */
export function htmlToText(html: string): string {
  if (!html) return "";
  const text = htmlToTextConvert(html, {
    wordwrap: false,
    selectors: [
      // Inline links as: "anchor text [https://url]". Skip mailto/anchor-only refs.
      {
        selector: "a",
        options: {
          hideLinkHrefIfSameAsText: true,
          ignoreHref: false,
          linkBrackets: ["[", "]"],
          noAnchorUrl: true,
          baseUrl: undefined,
        },
      },
      // Drop images entirely — alt text alone rarely helps and tracking pixels
      // produce noise.
      { selector: "img", format: "skip" },
      // Bullet-style lists.
      { selector: "ul", options: { itemPrefix: " - " } },
      // Headings: keep original case (the library uppercases h1 by default,
      // which loses signal when agents quote headings back).
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false } },
      { selector: "h3", options: { uppercase: false } },
      { selector: "h4", options: { uppercase: false } },
      { selector: "h5", options: { uppercase: false } },
      { selector: "h6", options: { uppercase: false } },
    ],
  });
  // Normalize whitespace: NBSP → regular space (html-to-text preserves
  // U+00A0, but agent prompts read cleaner with ASCII spaces); collapse runs
  // of more than two blank lines; trim trailing whitespace per line.
  return text
    .replace(/\u00A0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Pick the best body content from a Gmail message JSON returned by the `gws`
 * CLI. Handles both shapes we've observed:
 *
 *   - `{ body: "..." }` — plain text (CLI's default rendering)
 *   - `{ text: "...", html: "..." }` — multipart messages where the CLI exposes
 *     both parts. Prefer plain text per the task spec; fall back to HTML.
 *   - `{ html: "..." }` — HTML-only message returned via `--html`.
 *
 * Returns the converted plain text plus a flag indicating whether the source
 * was HTML (so the caller can annotate the output).
 */
export function pickEmailBody(msg: Record<string, unknown>): {
  text: string;
  fromHtml: boolean;
} {
  const plain =
    typeof msg.text === "string" && msg.text.trim()
      ? msg.text.trim()
      : typeof msg.body === "string" && msg.body.trim() && !looksLikeHtml(msg.body)
      ? (msg.body as string).trim()
      : "";
  if (plain) return { text: plain, fromHtml: false };

  const html =
    typeof msg.html === "string" && msg.html.trim()
      ? (msg.html as string)
      : typeof msg.body === "string" && looksLikeHtml(msg.body)
      ? (msg.body as string)
      : "";
  if (html) return { text: htmlToText(html), fromHtml: true };

  return { text: "", fromHtml: false };
}

/** Heuristic: does this string look like HTML rather than plain text? */
function looksLikeHtml(s: string): boolean {
  return /<\s*(html|body|div|p|br|span|table|a\s|img\s|h[1-6])\b/i.test(s);
}

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
          const messages = JSON.parse(extractBalancedJson(stdout, jsonStart));

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
          const id = input.id as string;
          const args = ["gmail", "+read", "--id", id, "--headers", "--format", "json"];
          const stdout = await provider.gws(memberSlug, args);
          const jsonStart = stdout.indexOf("{");
          const msg = JSON.parse(jsonStart >= 0 ? extractBalancedJson(stdout, jsonStart) : stdout);

          const parts = [];
          if (msg.from) parts.push(`From: ${msg.from}`);
          if (msg.to) parts.push(`To: ${msg.to}`);
          if (msg.subject) parts.push(`Subject: ${msg.subject}`);
          if (msg.date) parts.push(`Date: ${msg.date}`);
          parts.push("");

          // Try to extract a body from whatever the CLI returned. Multipart
          // messages will often expose both a `text` and `html` field; we
          // prefer plain. Some senders (marketing/transactional) only ship an
          // HTML part, in which case the CLI's default `body` field comes back
          // empty even though `--html` would yield content.
          let { text, fromHtml } = pickEmailBody(msg);

          if (!text) {
            // Re-fetch with --html so we capture HTML-only messages.
            const htmlArgs = ["gmail", "+read", "--id", id, "--html", "--format", "json"];
            try {
              const htmlOut = await provider.gws(memberSlug, htmlArgs);
              const htmlStart = htmlOut.indexOf("{");
              const htmlMsg = JSON.parse(
                htmlStart >= 0 ? extractBalancedJson(htmlOut, htmlStart) : htmlOut,
              );
              const picked = pickEmailBody(htmlMsg);
              text = picked.text;
              fromHtml = picked.fromHtml || fromHtml;
            } catch {
              // Fall through to "(empty …)" below.
            }
          }

          if (text) {
            if (fromHtml) {
              parts.push("(HTML email — converted to text below)");
              parts.push("");
            }
            parts.push(text);
          } else {
            parts.push("(empty — could not retrieve message body)");
          }

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
