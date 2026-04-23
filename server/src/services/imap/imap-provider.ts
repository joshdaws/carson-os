/**
 * IMAP email provider — wraps imapflow for read-only email operations.
 *
 * Each family member gets their own credentials file so they authenticate
 * with their own email account (iCloud, Gmail, Fastmail, etc.).
 *
 * Credentials are stored at:
 *   ~/.carsonos/imap/<memberSlug>/credentials.json
 *
 * Dependency: `imapflow` npm package (included in server deps)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import type { SearchObject, FetchMessageObject } from "imapflow";

const TIMEOUT_MS = 30_000;
const BODY_MAX_CHARS = 8_000;

// ── Types ──────────────────────────────────────────────────────────

export interface ImapCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface ImapAuthStatus {
  authenticated: boolean;
  credentialsPath: string;
}

export interface EmailMessage {
  /**
   * Stable message identifier in the format "<mailbox>:<uid>".
   * e.g. "INBOX:12345"  — pass this to readMessage() / imap_read.
   */
  id: string;
  from: string;
  to?: string;
  subject: string;
  date: string;
  body?: string;
  mailbox?: string;
}

// ── Provider ───────────────────────────────────────────────────────

export class ImapProvider {
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    mkdirSync(rootDir, { recursive: true });
  }

  // ── Directory / credential helpers ───────────────────────────────

  private memberDir(memberSlug: string): string {
    const dir = join(this.rootDir, memberSlug);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private credentialsPath(memberSlug: string): string {
    return join(this.memberDir(memberSlug), "credentials.json");
  }

  private loadCredentials(memberSlug: string): ImapCredentials {
    const path = this.credentialsPath(memberSlug);
    if (!existsSync(path)) {
      throw new Error(
        `IMAP not configured for this member. Create ${path} with fields: host, port, username, password`,
      );
    }
    try {
      return JSON.parse(readFileSync(path, "utf8")) as ImapCredentials;
    } catch {
      throw new Error(
        `Failed to read IMAP credentials at ${path}. Check that the file is valid JSON.`,
      );
    }
  }

  private createClient(creds: ImapCredentials): ImapFlow {
    return new ImapFlow({
      host: creds.host,
      port: creds.port,
      secure: creds.port === 993,
      auth: { user: creds.username, pass: creds.password },
      logger: false,
    });
  }

  // ── Auth ─────────────────────────────────────────────────────────

  /** Check if a member has a credentials file saved. */
  getAuthStatus(memberSlug: string): ImapAuthStatus {
    const path = this.credentialsPath(memberSlug);
    return { authenticated: existsSync(path), credentialsPath: path };
  }

  /**
   * Save credentials for a member. Writes credentials.json to the member's
   * IMAP directory. The server is not contacted — call triageInbox() to
   * verify the credentials work.
   */
  saveCredentials(memberSlug: string, credentials: ImapCredentials): string {
    const path = this.credentialsPath(memberSlug);
    writeFileSync(path, JSON.stringify(credentials, null, 2), "utf8");
    return path;
  }

  // ── Email operations ─────────────────────────────────────────────

  /**
   * Triage the inbox: return the N most recent unread (or all) messages.
   * Returns envelope info only — use readMessage() for full content.
   *
   * opts.mailbox    — mailbox to open (default: "INBOX")
   * opts.max        — max messages to return (default: 20)
   * opts.unreadOnly — only return unseen messages (default: true)
   */
  async triageInbox(
    memberSlug: string,
    opts?: { mailbox?: string; max?: number; unreadOnly?: boolean },
  ): Promise<EmailMessage[]> {
    const creds = this.loadCredentials(memberSlug);
    const client = this.createClient(creds);
    const mailbox = opts?.mailbox ?? "INBOX";
    const max = opts?.max ?? 20;
    const unreadOnly = opts?.unreadOnly ?? true;

    await withTimeout(client.connect(), TIMEOUT_MS);
    try {
      const lock = (await withTimeout(client.getMailboxLock(mailbox), TIMEOUT_MS)) as { release: () => void };
      try {
        const query: SearchObject = unreadOnly ? { seen: false } : { all: true };
        const uids = (await withTimeout(client.search(query, { uid: true }), TIMEOUT_MS)) as number[] | false;

        if (!uids || uids.length === 0) return [];

        // Take the last `max` UIDs (highest = most recently received)
        const recent = uids.slice(-max);
        return await fetchEnvelopes(client, recent, mailbox);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  /**
   * Read the full content of a specific message by ID.
   * messageId format: "<mailbox>:<uid>"  (from triageInbox / searchMessages).
   */
  async readMessage(memberSlug: string, messageId: string): Promise<EmailMessage> {
    const creds = this.loadCredentials(memberSlug);
    const client = this.createClient(creds);
    const { mailbox, uid } = parseMessageId(messageId);

    await withTimeout(client.connect(), TIMEOUT_MS);
    try {
      const lock = (await withTimeout(client.getMailboxLock(mailbox), TIMEOUT_MS)) as { release: () => void };
      try {
        const msg = (await withTimeout(
          client.fetchOne(uid, { envelope: true, source: true, uid: true }, { uid: true }),
          TIMEOUT_MS,
        )) as {
          envelope?: {
            from?: Array<{ name?: string; address?: string }>;
            to?: Array<{ name?: string; address?: string }>;
            subject?: string;
            date?: Date | string;
          };
          source?: Buffer;
        } | undefined;

        if (!msg) {
          throw new Error(`Message not found: ${messageId}`);
        }

        const body = msg.source ? extractBody(msg.source.toString("binary")) : undefined;

        return {
          id: messageId,
          from: formatAddresses(msg.envelope?.from),
          to: formatAddresses(msg.envelope?.to),
          subject: msg.envelope?.subject ?? "(no subject)",
          date: msg.envelope?.date ? formatDate(msg.envelope.date) : "",
          body,
          mailbox,
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  /**
   * Search messages using a Gmail-style query string.
   * Supported operators: from:, to:, subject:, body:, before:, after:, is:unread, is:read, is:flagged
   * Unrecognised terms are used as full-text search.
   *
   * opts.mailbox — mailbox to search (default: "INBOX")
   * opts.max     — max results (default: 20)
   */
  async searchMessages(
    memberSlug: string,
    query: string,
    opts?: { mailbox?: string; max?: number },
  ): Promise<EmailMessage[]> {
    const creds = this.loadCredentials(memberSlug);
    const client = this.createClient(creds);
    const mailbox = opts?.mailbox ?? "INBOX";
    const max = opts?.max ?? 20;

    await withTimeout(client.connect(), TIMEOUT_MS);
    try {
      const lock = (await withTimeout(client.getMailboxLock(mailbox), TIMEOUT_MS)) as { release: () => void };
      try {
        const searchObj = parseSearchQuery(query);
        const uids = (await withTimeout(client.search(searchObj, { uid: true }), TIMEOUT_MS)) as number[] | false;

        if (!uids || uids.length === 0) return [];

        const recent = uids.slice(-max);
        return await fetchEnvelopes(client, recent, mailbox);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  /**
   * IMAP is always available (it's an npm package, not an external CLI).
   * Returns true unconditionally — per-member auth is checked via getAuthStatus().
   */
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

// ── Shared fetch helper ────────────────────────────────────────────

/**
 * Fetch envelope data for a list of UIDs from the currently-locked mailbox.
 * Returns EmailMessage objects sorted newest-first (no body content).
 */
async function fetchEnvelopes(
  client: ImapFlow,
  uids: number[],
  mailbox: string,
): Promise<EmailMessage[]> {
  const messages: EmailMessage[] = [];

  for await (const msg of client.fetch(
    uids,
    { envelope: true, uid: true },
    { uid: true },
  ) as AsyncIterable<FetchMessageObject>) {
    messages.push({
      id: `${mailbox}:${msg.uid}`,
      from: formatAddresses(msg.envelope?.from),
      to: formatAddresses(msg.envelope?.to),
      subject: msg.envelope?.subject ?? "(no subject)",
      date: msg.envelope?.date ? formatDate(msg.envelope.date) : "",
      mailbox,
    });
  }

  // Reverse so newest (highest UID) appears first
  return messages.reverse();
}

// ── Message ID helpers ─────────────────────────────────────────────

/** Parse a message ID in format "<mailbox>:<uid>". */
export function parseMessageId(messageId: string): { mailbox: string; uid: number } {
  const colonIdx = messageId.lastIndexOf(":");
  if (colonIdx < 0) {
    throw new Error(
      `Invalid message ID format: "${messageId}". Expected "<mailbox>:<uid>", e.g. "INBOX:12345".`,
    );
  }
  const mailbox = messageId.slice(0, colonIdx) || "INBOX";
  const uid = parseInt(messageId.slice(colonIdx + 1), 10);
  if (isNaN(uid)) {
    throw new Error(`Invalid UID in message ID: "${messageId}".`);
  }
  return { mailbox, uid };
}

/** Format an array of address objects to a readable string. */
export function formatAddresses(
  addrs?: Array<{ name?: string; address?: string }>,
): string {
  if (!addrs || addrs.length === 0) return "";
  return addrs
    .map((a) => {
      if (a.name && a.address) return `${a.name} <${a.address}>`;
      return a.address ?? a.name ?? "";
    })
    .join(", ");
}

/** Format a Date to a locale-friendly string. */
function formatDate(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── MIME body extraction ───────────────────────────────────────────

/**
 * Extract readable plain text from a raw RFC 5322 message string.
 * Handles multipart, base64/quoted-printable encoding, and HTML stripping.
 */
function extractBody(raw: string): string {
  const { headers, body } = splitHeadersBody(raw);
  const contentType = getHeader(headers, "content-type") ?? "text/plain";
  const encoding = (getHeader(headers, "content-transfer-encoding") ?? "7bit")
    .toLowerCase()
    .trim();

  let text: string;
  if (/multipart\//i.test(contentType)) {
    const boundary = extractBoundary(contentType);
    text = boundary ? extractMultipartText(body, boundary) : body;
  } else {
    text = decodeBody(body, encoding);
    if (/text\/html/i.test(contentType)) {
      text = stripHtml(text);
    }
  }

  // Normalise whitespace and truncate
  text = text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
  if (text.length > BODY_MAX_CHARS) {
    text = `${text.slice(0, BODY_MAX_CHARS)}\n\n[… truncated]`;
  }
  return text;
}

/** Split a raw RFC 5322 message into unfolded headers and body. */
function splitHeadersBody(raw: string): { headers: string; body: string } {
  // CRLF blank line separates headers from body
  const crlfSep = raw.indexOf("\r\n\r\n");
  if (crlfSep >= 0) {
    return {
      headers: unfoldHeaders(raw.slice(0, crlfSep)),
      body: raw.slice(crlfSep + 4),
    };
  }
  // LF-only fallback
  const lfSep = raw.indexOf("\n\n");
  if (lfSep >= 0) {
    return {
      headers: unfoldHeaders(raw.slice(0, lfSep)),
      body: raw.slice(lfSep + 2),
    };
  }
  return { headers: unfoldHeaders(raw), body: "" };
}

/** RFC 5322 header unfolding: CRLF/LF followed by whitespace is a continuation. */
function unfoldHeaders(block: string): string {
  return block.replace(/\r\n([ \t])/g, "$1").replace(/\n([ \t])/g, "$1");
}

/** Get a named header value from an unfolded header block (case-insensitive). */
function getHeader(headers: string, name: string): string | undefined {
  const re = new RegExp(`^${name}:\\s*(.+)`, "im");
  const m = re.exec(headers);
  return m ? m[1].trim() : undefined;
}

/** Extract the `boundary` parameter from a Content-Type value. */
function extractBoundary(contentType: string): string | undefined {
  const m = /boundary="?([^";,\s]+)"?/i.exec(contentType);
  return m ? m[1] : undefined;
}

/**
 * Recursively walk a MIME multipart body and return the best plain-text content.
 * Prefers text/plain parts; falls back to text/html → strip.
 */
function extractMultipartText(body: string, boundary: string): string {
  const delimiter = `--${boundary}`;
  const parts = body.split(delimiter);
  let plainText = "";
  let htmlFallback = "";

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === "--" || trimmed.startsWith("--")) continue;

    const { headers: partHeaders, body: partBody } = splitHeadersBody(part);
    const partContentType = (
      getHeader(partHeaders, "content-type") ?? "text/plain"
    ).toLowerCase();
    const partEncoding = (
      getHeader(partHeaders, "content-transfer-encoding") ?? "7bit"
    )
      .toLowerCase()
      .trim();

    if (partContentType.startsWith("multipart/")) {
      const subBoundary = extractBoundary(partContentType);
      if (subBoundary) {
        const sub = extractMultipartText(partBody, subBoundary);
        if (sub) plainText += sub;
        continue;
      }
    }

    if (partContentType.startsWith("text/plain")) {
      plainText += decodeBody(partBody, partEncoding);
    } else if (partContentType.startsWith("text/html") && !plainText) {
      htmlFallback = decodeBody(partBody, partEncoding);
    }
  }

  if (plainText) return plainText;
  if (htmlFallback) return stripHtml(htmlFallback);
  return "";
}

/** Decode a MIME body based on its Content-Transfer-Encoding. */
function decodeBody(body: string, encoding: string): string {
  switch (encoding) {
    case "base64":
      try {
        return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
      } catch {
        return body;
      }
    case "quoted-printable":
      return decodeQuotedPrintable(body);
    default:
      // 7bit, 8bit, binary — return as-is
      return body;
  }
}

/** Decode quoted-printable encoded content. */
function decodeQuotedPrintable(qp: string): string {
  return (
    qp
      // Soft line breaks (= at end of line)
      .replace(/=\r\n/g, "")
      .replace(/=\n/g, "")
      // Encoded bytes: =XX
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
  );
}

/** Strip HTML tags and decode common HTML entities. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|li|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Search query parser ────────────────────────────────────────────

/**
 * Parse a Gmail-style search query string into an imapflow SearchObject.
 *
 * Exported for unit testing.
 *
 * Supported operators:
 *   from:address     — sender matches
 *   to:address       — recipient matches
 *   cc:address       — CC matches
 *   subject:text     — subject matches
 *   body:text        — body matches
 *   before:YYYY-MM-DD — received before date
 *   after:YYYY-MM-DD  — received after date (alias: since:)
 *   is:unread        — unseen messages
 *   is:read          — seen messages
 *   is:flagged       — flagged messages
 *   is:unflagged     — unflagged messages
 *   is:answered      — answered messages
 *
 * Unrecognised tokens are combined into a full-text search.
 */
export function parseSearchQuery(query: string): SearchObject {
  const tokens = tokenize(query);
  const obj: SearchObject = {};
  const textParts: string[] = [];

  for (const token of tokens) {
    const colonIdx = token.indexOf(":");
    if (colonIdx > 0) {
      const key = token.slice(0, colonIdx).toLowerCase();
      const value = token.slice(colonIdx + 1).replace(/^"|"$/g, "");

      switch (key) {
        case "from":    obj.from = value; break;
        case "to":      obj.to = value; break;
        case "cc":      obj.cc = value; break;
        case "bcc":     obj.bcc = value; break;
        case "subject": obj.subject = value; break;
        case "body":    obj.body = value; break;
        case "text":    obj.text = value; break;
        case "before":  obj.before = parseQueryDate(value); break;
        case "after":
        case "since":   obj.since = parseQueryDate(value); break;
        case "is": {
          switch (value.toLowerCase()) {
            case "unread":     obj.seen = false; break;
            case "read":       obj.seen = true; break;
            case "flagged":    obj.flagged = true; break;
            case "unflagged":  obj.flagged = false; break;
            case "answered":   obj.answered = true; break;
            case "unanswered": obj.answered = false; break;
          }
          break;
        }
        default:
          textParts.push(token);
      }
    } else {
      textParts.push(token);
    }
  }

  if (textParts.length > 0) {
    obj.text = textParts.join(" ");
  }

  // Default to all messages if no criteria specified
  if (Object.keys(obj).length === 0) {
    obj.all = true;
  }

  return obj;
}

/** Tokenise a query string, respecting double-quoted phrases. */
function tokenize(query: string): string[] {
  const tokens: string[] = [];
  const re = /[^\s"]+(?:"[^"]*"[^\s"]*)*|"[^"]*"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
}

/** Parse a date string (YYYY-MM-DD or natural) into a Date for IMAP search. */
function parseQueryDate(value: string): Date {
  const d = new Date(value);
  return isNaN(d.getTime()) ? new Date() : d;
}

// ── Utility ────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`IMAP request timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}
