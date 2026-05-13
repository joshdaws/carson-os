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
        },
      },
      // Drop images entirely — alt text alone rarely helps and tracking pixels
      // produce noise.
      { selector: "img", format: "skip" },
      // Bullet-style lists.
      { selector: "ul", options: { itemPrefix: " - " } },
      // Flatten the layout-table soup that marketing senders love so cells
      // don't get concatenated with no separator. `dataTable` renders rows as
      // newline-separated lines with cells joined by spaces.
      { selector: "table", format: "dataTable" },
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
 * Decode a base64url-encoded string (Gmail API's native encoding for message
 * part bodies). Base64url uses `-` and `_` in place of `+` and `/` and omits
 * trailing `=` padding. We convert to standard base64 before decoding.
 *
 * `Buffer.from(s, "base64")` silently drops invalid characters rather than
 * throwing, which would produce garbled mojibake if the input is not actually
 * base64url. To avoid surfacing that to the user, we:
 *
 *   1. Validate the input is composed only of base64url-safe characters
 *      (`A-Z a-z 0-9 - _ =`). Anything else → `""`.
 *   2. Wrap the decode itself in try/catch as a belt-and-suspenders.
 */
export function decodeBase64Url(data: string): string {
  if (!data) return "";
  try {
    if (!/^[A-Za-z0-9_\-]*=*$/.test(data)) return "";
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Detect whether a Gmail API payload part is an attachment (versus an inline
 * body part). An attachment-shaped `text/plain` part ordered before the real
 * body can otherwise shadow the body and end up displayed instead.
 *
 * Two signals — either one wins:
 *   - `filename` set and non-empty (Gmail API exposes this on every part; only
 *     attachment parts have it populated).
 *   - `Content-Disposition: attachment[; …]` header.
 */
function isAttachmentPart(node: Record<string, unknown>): boolean {
  const filename = typeof node.filename === "string" ? node.filename.trim() : "";
  if (filename) return true;
  const headers = node.headers;
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (!h || typeof h !== "object") continue;
      const ho = h as Record<string, unknown>;
      const hname = typeof ho.name === "string" ? ho.name.toLowerCase() : "";
      const hval = typeof ho.value === "string" ? ho.value.trim().toLowerCase() : "";
      if (hname === "content-disposition" && hval.startsWith("attachment")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Read a single header value (case-insensitive) from a Gmail API
 * `payload.headers[]` array. Used as a fallback for From/To/Subject/Date when
 * the surrounding tooling stops flattening these onto the top-level message
 * object (pure Gmail API responses keep them only in `payload.headers[]`).
 */
export function readPayloadHeader(payload: unknown, name: string): string {
  if (!payload || typeof payload !== "object") return "";
  const headers = (payload as Record<string, unknown>).headers;
  if (!Array.isArray(headers)) return "";
  const target = name.toLowerCase();
  for (const h of headers) {
    if (!h || typeof h !== "object") continue;
    const ho = h as Record<string, unknown>;
    const hname = typeof ho.name === "string" ? ho.name.toLowerCase() : "";
    if (hname === target) {
      return typeof ho.value === "string" ? ho.value : "";
    }
  }
  return "";
}

/**
 * Walk a Gmail API `payload` tree (or any part within it) and collect the
 * decoded text/plain and text/html bodies we find. Gmail multipart messages
 * nest parts arbitrarily deep (`multipart/alternative` inside
 * `multipart/mixed` inside `multipart/related`, etc.), so we recurse.
 *
 * Returned strings are already base64url-decoded UTF-8.
 *
 * Safety/correctness guards:
 *   - **Attachment skip**: parts marked with `Content-Disposition: attachment`
 *     (or carrying a `filename`) are ignored even if their `mimeType` is
 *     `text/plain` — otherwise a plain-text attachment ordered before the body
 *     could shadow the real body.
 *   - **mimeType matching**: uses `startsWith` so `text/plain; charset=utf-8`
 *     and `text/html; charset=iso-8859-1` both match.
 *   - **Recursion cap**: bails after `MAX_DEPTH` levels to bound work on
 *     pathological / malicious payloads.
 */
const MAX_PAYLOAD_DEPTH = 10;

export function collectPayloadBodies(payload: unknown): {
  plain: string;
  html: string;
} {
  const out = { plain: "", html: "" };
  if (!payload || typeof payload !== "object") return out;
  walk(payload as Record<string, unknown>, 0);
  return out;

  function walk(node: Record<string, unknown>, depth: number): void {
    if (depth > MAX_PAYLOAD_DEPTH) return;
    // Skip attachment parts entirely — both their body and their children.
    if (isAttachmentPart(node)) return;

    const mime = typeof node.mimeType === "string" ? node.mimeType.toLowerCase() : "";
    const body = node.body as { data?: unknown } | undefined;
    const data =
      body && typeof body === "object" && typeof body.data === "string" ? body.data : "";
    if (data) {
      const decoded = decodeBase64Url(data);
      if (decoded) {
        if (mime.startsWith("text/plain") && !out.plain) out.plain = decoded;
        else if (mime.startsWith("text/html") && !out.html) out.html = decoded;
        else if (!mime && !out.plain && !looksLikeHtml(decoded)) out.plain = decoded;
        else if (!mime && !out.html && looksLikeHtml(decoded)) out.html = decoded;
      }
    }
    const parts = node.parts;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (p && typeof p === "object") walk(p as Record<string, unknown>, depth + 1);
      }
    }
  }
}

/**
 * Pick the best body content from a Gmail message JSON returned by the `gws`
 * CLI. Handles every shape we've observed:
 *
 *   - `{ body_text: "...", body_html: "..." }` — the `gws gmail +read` helper's
 *     native output. The helper pre-decodes the message and exposes plain and
 *     HTML parts as snake_case top-level fields. THIS is the shape `gmail_read`
 *     actually receives in production. Prefer plain text; fall back to HTML.
 *   - `{ body: "..." }` — plain text (CLI's default rendering)
 *   - `{ text: "...", html: "..." }` — multipart messages where the CLI exposes
 *     both parts. Prefer plain text per the task spec; fall back to HTML.
 *   - `{ html: "..." }` — HTML-only message returned via `--html`.
 *   - `{ payload: { parts: [...] } }` — Gmail API's native shape. The lower-level
 *     `gws gmail users messages get` returns this. Each part has a `mimeType`
 *     and a base64url-encoded `body.data` blob. We walk the part tree, prefer
 *     `text/plain`, fall back to `text/html`.
 *   - `{ snippet: "..." }` — last-resort preview Gmail always returns.
 *
 * Returns the converted plain text plus a flag indicating whether the source
 * was HTML (so the caller can annotate the output).
 */
export function pickEmailBody(msg: Record<string, unknown>): {
  text: string;
  fromHtml: boolean;
} {
  // 1. The `gws +read` helper's own snake_case output. This is what the
  //    `gmail_read` handler actually receives — the helper decodes Gmail's
  //    base64url multipart body internally and exposes the result as plain
  //    `body_text` / `body_html` strings. PR #70 missed this shape because
  //    its tests fed in raw Gmail-API payloads instead of `gws +read` output.
  if (typeof msg.body_text === "string" && msg.body_text.trim()) {
    return { text: msg.body_text.trim(), fromHtml: false };
  }

  // 2. Other top-level string fields the CLI sometimes flattens for us.
  const plain =
    typeof msg.text === "string" && msg.text.trim()
      ? msg.text.trim()
      : typeof msg.body === "string" && msg.body.trim() && !looksLikeHtml(msg.body)
      ? msg.body.trim()
      : "";
  if (plain) return { text: plain, fromHtml: false };

  if (typeof msg.body_html === "string" && msg.body_html.trim()) {
    return { text: htmlToText(msg.body_html), fromHtml: true };
  }

  const html =
    typeof msg.html === "string" && msg.html.trim()
      ? msg.html
      : typeof msg.body === "string" && looksLikeHtml(msg.body)
      ? msg.body
      : "";
  if (html) return { text: htmlToText(html), fromHtml: true };

  // 3. Walk Gmail's native `payload.parts[].body.data` tree.
  const fromParts = collectPayloadBodies(msg.payload);
  if (fromParts.plain.trim()) {
    return { text: fromParts.plain.trim(), fromHtml: false };
  }
  if (fromParts.html.trim()) {
    return { text: htmlToText(fromParts.html), fromHtml: true };
  }

  // 4. Final fallback: Gmail's `snippet` preview (always present in API
  //    responses; a truncated plain-text excerpt of the first ~200 chars).
  if (typeof msg.snippet === "string" && msg.snippet.trim()) {
    return { text: msg.snippet.trim(), fromHtml: false };
  }

  return { text: "", fromHtml: false };
}

/**
 * Render a Gmail address header value as a readable "Name <email>" string.
 * The `gws` CLI returns these as structured objects (`{ name, email }`) or
 * arrays of objects rather than the raw RFC 5322 string, so naive string
 * interpolation gives `[object Object]`. We handle:
 *
 *   - `"Bob Smith <bob@example.com>"` (raw string) — passed through as-is
 *   - `{ name: "Bob Smith", email: "bob@example.com" }` → `"Bob Smith <bob@example.com>"`
 *   - `{ email: "bob@example.com" }` → `"bob@example.com"`
 *   - `{ name: "Bob Smith" }` → `"Bob Smith"`
 *   - `{ address: "bob@example.com" }` (alternate key name) — same as `email`
 *   - `[{...}, {...}]` arrays — joined with `", "`
 *   - `null`/`undefined`/other primitives — empty string / coerced
 */
export function formatAddress(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) {
    return v
      .map(formatAddress)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join(", ");
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const email =
      typeof o.email === "string"
        ? o.email.trim()
        : typeof o.address === "string"
        ? o.address.trim()
        : "";
    if (name && email) return `${name} <${email}>`;
    if (email) return email;
    if (name) return name;
    return "";
  }
  return String(v);
}

/**
 * Heuristic: does this string look like HTML rather than plain text?
 *
 * Catches the common shapes we see in the wild:
 *   - full documents with <html>/<body>/<head>/<!DOCTYPE …>
 *   - block elements (div, p, br, table, ul/ol/li, h1-h6, blockquote, pre)
 *   - inline formatting fragments (strong, em, b, i, u, span, a, img)
 *   - HTML comments (`<!-- … -->`)
 *
 * Exported for unit tests so we can pin the borderline cases.
 */
export function looksLikeHtml(s: string): boolean {
  if (!s) return false;
  // <!DOCTYPE …> / <!-- … --> — declarations and comments are HTML-only syntax.
  if (/<!(?:DOCTYPE\b|--)/i.test(s)) return true;
  // Tag names: block + inline + a/img with attribute or self-close.
  return /<\s*\/?\s*(html|head|body|div|p|br|span|table|tr|td|th|thead|tbody|tfoot|ul|ol|li|h[1-6]|blockquote|pre|code|hr|article|section|header|footer|nav|main|aside|figure|figcaption|strong|em|b|i|u|s|small|sub|sup|mark|del|ins|font|center|a|img|style|script)\b/i.test(s);
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
            .map((m: Record<string, unknown>) => {
              const from = formatAddress(m.from) || "Unknown";
              const subject = (typeof m.subject === "string" && m.subject) || "(no subject)";
              const date = typeof m.date === "string" ? m.date : "";
              const id = typeof m.id === "string" ? m.id : "";
              return `- ${from}: ${subject} (${date}) [id: ${id}]`;
            })
            .join("\n");

          return { content: `${messages.length} messages:\n${formatted}` };
        }

        case "gmail_read": {
          const id = input.id as string;
          const args = ["gmail", "+read", "--id", id, "--headers", "--format", "json"];
          const stdout = await provider.gws(memberSlug, args);
          const jsonStart = stdout.indexOf("{");
          const msg = JSON.parse(jsonStart >= 0 ? extractBalancedJson(stdout, jsonStart) : stdout);

          const parts: string[] = [];
          // Headers may be flattened onto the top-level message object (the
          // `gws` CLI does this) or live only inside `payload.headers[]` (pure
          // Gmail API response shape). Read both, preferring the flattened
          // form when present.
          const from =
            formatAddress(msg.from) ||
            formatAddress(readPayloadHeader(msg.payload, "From"));
          const to =
            formatAddress(msg.to) ||
            formatAddress(readPayloadHeader(msg.payload, "To"));
          const cc =
            formatAddress(msg.cc) ||
            formatAddress(readPayloadHeader(msg.payload, "Cc"));
          const subject =
            (typeof msg.subject === "string" && msg.subject) ||
            readPayloadHeader(msg.payload, "Subject");
          const date =
            (typeof msg.date === "string" && msg.date) ||
            readPayloadHeader(msg.payload, "Date");
          if (from) parts.push(`From: ${from}`);
          if (to) parts.push(`To: ${to}`);
          if (cc) parts.push(`Cc: ${cc}`);
          if (subject) parts.push(`Subject: ${subject}`);
          if (date) parts.push(`Date: ${date}`);
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
              fromHtml = picked.fromHtml;
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

          // Same defensive handling as gmail_read: From may be an object or
          // array, may live in payload.headers[], and Subject may be missing
          // or non-string. Coerce everything carefully before stuffing it into
          // the outgoing draft.
          const replyTo =
            formatAddress(original.from) ||
            formatAddress(readPayloadHeader(original.payload, "From"));
          const origSubjectRaw =
            (typeof original.subject === "string" && original.subject) ||
            readPayloadHeader(original.payload, "Subject") ||
            "";
          const subject = origSubjectRaw.startsWith("Re: ")
            ? origSubjectRaw
            : `Re: ${origSubjectRaw}`;
          // gws +read exposes thread id as snake_case `thread_id`. Lower-level
          // gmail.users.messages.get returns camelCase `threadId`. Accept either.
          const threadId =
            typeof original.thread_id === "string"
              ? original.thread_id
              : typeof original.threadId === "string"
              ? original.threadId
              : undefined;

          const raw = buildRawEmail({
            to: replyTo,
            subject,
            body: input.body as string,
            inReplyTo: input.messageId as string,
            threadId,
          });

          const tmpFile = join(tmpdir(), `carsonos-reply-${Date.now()}.eml`);
          writeFileSync(tmpFile, raw);

          try {
            const draftJson: Record<string, unknown> = {
              message: threadId ? { threadId } : {},
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
