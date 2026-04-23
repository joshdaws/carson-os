/**
 * Tests for IMAP helper functions: search query parser, message ID parser,
 * and address formatter.
 *
 * These are pure functions. Regressions here mean agents silently search
 * the wrong mailbox, use wrong date ranges, or mis-identify senders.
 */

import { describe, it, expect } from "vitest";
import {
  parseSearchQuery,
  parseMessageId,
  formatAddresses,
} from "../imap/imap-provider.js";

// ── parseSearchQuery ───────────────────────────────────────────────

describe("parseSearchQuery", () => {
  it("parses from: operator", () => {
    const result = parseSearchQuery("from:alice@example.com");
    expect(result.from).toBe("alice@example.com");
  });

  it("parses to: operator", () => {
    const result = parseSearchQuery("to:bob@example.com");
    expect(result.to).toBe("bob@example.com");
  });

  it("parses cc: operator", () => {
    const result = parseSearchQuery("cc:carol@example.com");
    expect(result.cc).toBe("carol@example.com");
  });

  it("parses subject: operator", () => {
    const result = parseSearchQuery("subject:quarterly");
    expect(result.subject).toBe("quarterly");
  });

  it("parses body: operator", () => {
    const result = parseSearchQuery("body:invoice");
    expect(result.body).toBe("invoice");
  });

  it("parses is:unread as seen=false", () => {
    const result = parseSearchQuery("is:unread");
    expect(result.seen).toBe(false);
  });

  it("parses is:read as seen=true", () => {
    const result = parseSearchQuery("is:read");
    expect(result.seen).toBe(true);
  });

  it("parses is:flagged as flagged=true", () => {
    const result = parseSearchQuery("is:flagged");
    expect(result.flagged).toBe(true);
  });

  it("parses is:unflagged as flagged=false", () => {
    const result = parseSearchQuery("is:unflagged");
    expect(result.flagged).toBe(false);
  });

  it("parses is:answered as answered=true", () => {
    const result = parseSearchQuery("is:answered");
    expect(result.answered).toBe(true);
  });

  it("parses after: as since (date object)", () => {
    const result = parseSearchQuery("after:2026-01-01");
    expect(result.since).toBeInstanceOf(Date);
    // Use getUTCFullYear so the test passes in all timezones (new Date("YYYY-MM-DD") is midnight UTC)
    expect((result.since as Date).getUTCFullYear()).toBe(2026);
  });

  it("parses since: as alias for after:", () => {
    const result = parseSearchQuery("since:2026-03-15");
    expect(result.since).toBeInstanceOf(Date);
  });

  it("parses before: as Date object", () => {
    const result = parseSearchQuery("before:2026-06-30");
    expect(result.before).toBeInstanceOf(Date);
    expect((result.before as Date).getUTCFullYear()).toBe(2026);
  });

  it("treats unrecognised tokens as full-text search", () => {
    const result = parseSearchQuery("budget proposal");
    expect(result.text).toBe("budget proposal");
    expect(result.from).toBeUndefined();
  });

  it("appends multiple unrecognised tokens into a single text value", () => {
    const result = parseSearchQuery("hello world foo");
    expect(result.text).toBe("hello world foo");
  });

  it("combines known operators and free text in one query", () => {
    const result = parseSearchQuery("from:alice@example.com is:unread invoice Q2");
    expect(result.from).toBe("alice@example.com");
    expect(result.seen).toBe(false);
    expect(result.text).toBe("invoice Q2");
  });

  it("defaults to all:true when query is empty", () => {
    expect(parseSearchQuery("").all).toBe(true);
    expect(parseSearchQuery("   ").all).toBe(true);
  });

  it("does not set all:true when at least one criterion is present", () => {
    const result = parseSearchQuery("from:alice@example.com");
    expect(result.all).toBeUndefined();
  });

  it("strips surrounding double quotes from operator values", () => {
    // subject:"quarterly review" → subject should be 'quarterly review'
    const result = parseSearchQuery('subject:"quarterly review"');
    expect(result.subject).toBe("quarterly review");
  });

  it("unknown is: values are silently ignored (no crash)", () => {
    // Ensures we don't throw on new/unrecognised is: flags
    expect(() => parseSearchQuery("is:spam")).not.toThrow();
  });

  it("operator names are case-insensitive (FROM: works)", () => {
    const result = parseSearchQuery("FROM:alice@example.com");
    expect(result.from).toBe("alice@example.com");
  });
});

// ── parseMessageId ─────────────────────────────────────────────────

describe("parseMessageId", () => {
  it("parses INBOX:12345 correctly", () => {
    const { mailbox, uid } = parseMessageId("INBOX:12345");
    expect(mailbox).toBe("INBOX");
    expect(uid).toBe(12345);
  });

  it("parses a nested mailbox name (Sent/2023)", () => {
    // Mailbox names can contain slashes — only the last colon is the separator
    const { mailbox, uid } = parseMessageId("Sent/2023:999");
    expect(mailbox).toBe("Sent/2023");
    expect(uid).toBe(999);
  });

  it("parses a mailbox name with colons (Trash:42)", () => {
    // lastIndexOf(':') is the separator, earlier colons belong to mailbox name
    const { mailbox, uid } = parseMessageId("Archive:Old:42");
    expect(mailbox).toBe("Archive:Old");
    expect(uid).toBe(42);
  });

  it("throws on missing colon separator", () => {
    expect(() => parseMessageId("INBOX12345")).toThrow("Invalid message ID format");
  });

  it("throws on non-numeric UID", () => {
    expect(() => parseMessageId("INBOX:abc")).toThrow("Invalid UID");
  });

  it("defaults mailbox to INBOX when part before colon is empty", () => {
    const { mailbox } = parseMessageId(":5678");
    expect(mailbox).toBe("INBOX");
  });

  it("returns uid as a number (not a string)", () => {
    const { uid } = parseMessageId("INBOX:100");
    expect(typeof uid).toBe("number");
  });
});

// ── formatAddresses ────────────────────────────────────────────────

describe("formatAddresses", () => {
  it("formats name + address as 'Name <email>'", () => {
    const result = formatAddresses([{ name: "Alice Smith", address: "alice@example.com" }]);
    expect(result).toBe("Alice Smith <alice@example.com>");
  });

  it("formats address-only entry (no name)", () => {
    const result = formatAddresses([{ address: "bob@example.com" }]);
    expect(result).toBe("bob@example.com");
  });

  it("formats name-only entry (no address)", () => {
    const result = formatAddresses([{ name: "No Address" }]);
    expect(result).toBe("No Address");
  });

  it("joins multiple addresses with ', '", () => {
    const result = formatAddresses([
      { name: "Alice", address: "alice@example.com" },
      { address: "bob@example.com" },
    ]);
    expect(result).toBe("Alice <alice@example.com>, bob@example.com");
  });

  it("returns empty string for undefined input", () => {
    expect(formatAddresses(undefined)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(formatAddresses([])).toBe("");
  });

  it("handles entries where both name and address are missing", () => {
    // Should not crash — returns empty string for that slot
    const result = formatAddresses([{}]);
    expect(result).toBe("");
  });
});
