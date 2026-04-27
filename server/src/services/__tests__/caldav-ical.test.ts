/**
 * Tests for CalDAV iCal parsing helpers.
 *
 * These are the pure functions that convert raw iCalendar text from the
 * CalDAV server into structured CalendarEvent objects. Real regressions here
 * are silent data corruption — a broken parser returns wrong dates or drops
 * events without throwing.
 */

import { describe, it, expect } from "vitest";
import {
  parseAllVEvents,
  parseICalDate,
  decodeICalText,
  encodeICalText,
  foldLine,
  type ParsedVEvent,
} from "../caldav/caldav-provider.js";

// ── parseICalDate ──────────────────────────────────────────────────

describe("parseICalDate", () => {
  it("parses an all-day date (YYYYMMDD) to ISO date string", () => {
    expect(parseICalDate("20260415")).toBe("2026-04-15");
  });

  it("parses a UTC datetime (YYYYMMDDTHHmmssZ) to ISO 8601", () => {
    const result = parseICalDate("20260415T140000Z");
    expect(result).toBe("2026-04-15T14:00:00.000Z");
  });

  it("parses a floating datetime (no timezone suffix) verbatim", () => {
    // Floating datetimes have no UTC marker — return without Z
    expect(parseICalDate("20260415T140000")).toBe("2026-04-15T14:00:00");
  });

  it("returns unrecognised values as-is", () => {
    expect(parseICalDate("not-a-date")).toBe("not-a-date");
    expect(parseICalDate("")).toBe("");
  });

  it("handles midnight UTC correctly (not shifted to previous day)", () => {
    const result = parseICalDate("20260101T000000Z");
    expect(result).toBe("2026-01-01T00:00:00.000Z");
  });

  it("handles end-of-day UTC (23:59:59Z)", () => {
    const result = parseICalDate("20261231T235959Z");
    expect(result).toBe("2026-12-31T23:59:59.000Z");
  });
});

// ── decodeICalText ─────────────────────────────────────────────────

describe("decodeICalText", () => {
  it("decodes \\n escape to newline", () => {
    expect(decodeICalText("line one\\nline two")).toBe("line one\nline two");
  });

  it("decodes \\N (uppercase) as well", () => {
    expect(decodeICalText("line one\\Nline two")).toBe("line one\nline two");
  });

  it("decodes \\, to literal comma", () => {
    expect(decodeICalText("apples\\, oranges")).toBe("apples, oranges");
  });

  it("decodes \\; to literal semicolon", () => {
    expect(decodeICalText("part one\\; part two")).toBe("part one; part two");
  });

  it("decodes \\\\ to single backslash", () => {
    expect(decodeICalText("C:\\\\Users\\\\test")).toBe("C:\\Users\\test");
  });

  it("decodes multiple escape sequences in one string", () => {
    const input = "Meeting\\, Board Room\\nBring ID\\; badge";
    expect(decodeICalText(input)).toBe("Meeting, Board Room\nBring ID; badge");
  });

  it("leaves plain text unchanged", () => {
    expect(decodeICalText("Weekly standup")).toBe("Weekly standup");
  });

  it("handles empty string", () => {
    expect(decodeICalText("")).toBe("");
  });
});

// ── encodeICalText ─────────────────────────────────────────────────

describe("encodeICalText", () => {
  it("encodes backslash first (avoids double-escaping)", () => {
    expect(encodeICalText("C:\\Users\\test")).toBe("C:\\\\Users\\\\test");
  });

  it("encodes semicolons", () => {
    expect(encodeICalText("part one; part two")).toBe("part one\\; part two");
  });

  it("encodes commas", () => {
    expect(encodeICalText("apples, oranges")).toBe("apples\\, oranges");
  });

  it("encodes newlines", () => {
    expect(encodeICalText("line one\nline two")).toBe("line one\\nline two");
  });

  it("is the inverse of decodeICalText for round-trip", () => {
    const original = "Meeting, Board Room\nBring ID; badge";
    expect(decodeICalText(encodeICalText(original))).toBe(original);
  });

  it("handles empty string", () => {
    expect(encodeICalText("")).toBe("");
  });
});

// ── foldLine ───────────────────────────────────────────────────────

describe("foldLine (RFC 5545 §3.1 line folding)", () => {
  it("leaves lines at or under 75 chars unchanged", () => {
    const short = "SUMMARY:Team standup";
    expect(foldLine(short)).toBe(short);

    const exactly75 = "X".repeat(75);
    expect(foldLine(exactly75)).toBe(exactly75);
  });

  it("folds a 76-char line at position 75 with CRLF + space", () => {
    const line = "A".repeat(76);
    const folded = foldLine(line);
    expect(folded).toContain("\r\n ");
    // First chunk is exactly 75 chars
    const parts = folded.split("\r\n");
    expect(parts[0]).toHaveLength(75);
    // Continuation chunk starts with a space, holds the remaining char
    expect(parts[1]).toBe(" " + "A");
  });

  it("folds multiple times for very long lines", () => {
    const line = "DESCRIPTION:" + "X".repeat(300);
    const folded = foldLine(line);
    const parts = folded.split("\r\n");
    // First chunk ≤ 75, all continuation chunks ≤ 75 (74 content + 1 leading space)
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(75);
    }
    // Reassembling (strip leading spaces from continuations) should give back original
    const rejoined = parts[0] + parts.slice(1).map((p) => p.slice(1)).join("");
    expect(rejoined).toBe(line);
  });

  it("handles a line of exactly 149 chars (fits in exactly two chunks)", () => {
    // 75 first + 74 continuation = 149 chars total
    const line = "B".repeat(149);
    const folded = foldLine(line);
    const parts = folded.split("\r\n");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(75);
    expect(parts[1]).toBe(" " + "B".repeat(74));
  });
});

// ── parseAllVEvents ────────────────────────────────────────────────

describe("parseAllVEvents", () => {
  const wrap = (veventContent: string) =>
    `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${veventContent}END:VCALENDAR\r\n`;

  const singleEvent = wrap(
    "BEGIN:VEVENT\r\n" +
    "DTSTART:20260415T140000Z\r\n" +
    "DTEND:20260415T150000Z\r\n" +
    "SUMMARY:Team standup\r\n" +
    "LOCATION:Zoom\r\n" +
    "DESCRIPTION:Weekly sync\r\n" +
    "END:VEVENT\r\n",
  );

  it("parses a single VEVENT block", () => {
    const result = parseAllVEvents(singleEvent);
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe("Team standup");
    expect(result[0].location).toBe("Zoom");
    expect(result[0].description).toBe("Weekly sync");
  });

  it("preserves rawDtstart for occurrence ID construction", () => {
    const result = parseAllVEvents(singleEvent);
    expect(result[0].rawDtstart).toBe("20260415T140000Z");
  });

  it("parses start and end as ISO strings", () => {
    const result = parseAllVEvents(singleEvent);
    expect(result[0].start).toBe("2026-04-15T14:00:00.000Z");
    expect(result[0].end).toBe("2026-04-15T15:00:00.000Z");
  });

  it("parses multiple VEVENT blocks (server-expanded recurring events)", () => {
    const ical = wrap(
      "BEGIN:VEVENT\r\nDTSTART:20260415T140000Z\r\nDTEND:20260415T150000Z\r\nSUMMARY:Standup 1\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nDTSTART:20260422T140000Z\r\nDTEND:20260422T150000Z\r\nSUMMARY:Standup 2\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nDTSTART:20260429T140000Z\r\nDTEND:20260429T150000Z\r\nSUMMARY:Standup 3\r\nEND:VEVENT\r\n",
    );
    const result = parseAllVEvents(ical);
    expect(result).toHaveLength(3);
    expect(result.map((v) => v.summary)).toEqual(["Standup 1", "Standup 2", "Standup 3"]);
  });

  it("captures RECURRENCE-ID on exception instances", () => {
    const ical = wrap(
      "BEGIN:VEVENT\r\nDTSTART:20260415T140000Z\r\nDTEND:20260415T150000Z\r\n" +
      "RECURRENCE-ID:20260415T140000Z\r\nSUMMARY:Override occurrence\r\nEND:VEVENT\r\n",
    );
    const result = parseAllVEvents(ical);
    expect(result).toHaveLength(1);
    expect(result[0].recurrenceId).toBe("20260415T140000Z");
  });

  it("master VEVENT (no RECURRENCE-ID) has recurrenceId undefined", () => {
    const result = parseAllVEvents(singleEvent);
    expect(result[0].recurrenceId).toBeUndefined();
  });

  it("skips VEVENT blocks without DTSTART", () => {
    const ical = wrap(
      "BEGIN:VEVENT\r\nSUMMARY:No start date\r\nEND:VEVENT\r\n",
    );
    expect(parseAllVEvents(ical)).toHaveLength(0);
  });

  it("handles LF-only line endings (not just CRLF)", () => {
    const ical =
      "BEGIN:VCALENDAR\n" +
      "BEGIN:VEVENT\n" +
      "DTSTART:20260415T140000Z\n" +
      "SUMMARY:LF event\n" +
      "END:VEVENT\n" +
      "END:VCALENDAR\n";
    const result = parseAllVEvents(ical);
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe("LF event");
  });

  it("unfolds RFC 5545 continuation lines before parsing", () => {
    // A SUMMARY folded across two lines with CRLF + space
    const ical =
      "BEGIN:VCALENDAR\r\n" +
      "BEGIN:VEVENT\r\n" +
      "DTSTART:20260415T140000Z\r\n" +
      "SUMMARY:This is a very long summary that has been folded\r\n" +
      " across two lines\r\n" +
      "END:VEVENT\r\n" +
      "END:VCALENDAR\r\n";
    const result = parseAllVEvents(ical);
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe(
      "This is a very long summary that has been foldedacross two lines",
    );
  });

  it("strips parameter suffix from property name (DTSTART;TZID=...)", () => {
    // Properties with parameters like DTSTART;TZID=America/Chicago:20260415T090000
    // must be captured under the bare "DTSTART" key.
    const ical = wrap(
      "BEGIN:VEVENT\r\n" +
      "DTSTART;TZID=America/Chicago:20260415T090000\r\n" +
      "DTEND;TZID=America/Chicago:20260415T100000\r\n" +
      "SUMMARY:Zoned event\r\n" +
      "END:VEVENT\r\n",
    );
    const result = parseAllVEvents(ical);
    expect(result).toHaveLength(1);
    // rawDtstart should be the value portion only
    expect(result[0].rawDtstart).toBe("20260415T090000");
  });

  it("decodes iCal text escapes in summary and description", () => {
    const ical = wrap(
      "BEGIN:VEVENT\r\n" +
      "DTSTART:20260415T140000Z\r\n" +
      "SUMMARY:Board meeting\\, Q2 review\r\n" +
      "DESCRIPTION:Agenda:\\n1. Budget\\n2. Roadmap\r\n" +
      "END:VEVENT\r\n",
    );
    const result = parseAllVEvents(ical);
    expect(result[0].summary).toBe("Board meeting, Q2 review");
    expect(result[0].description).toBe("Agenda:\n1. Budget\n2. Roadmap");
  });

  it("returns empty array for an empty VCALENDAR", () => {
    expect(parseAllVEvents("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")).toHaveLength(0);
    expect(parseAllVEvents("")).toHaveLength(0);
  });

  it("parses an all-day event (DTSTART as YYYYMMDD date)", () => {
    const ical = wrap(
      "BEGIN:VEVENT\r\n" +
      "DTSTART:20260415\r\n" +
      "DTEND:20260416\r\n" +
      "SUMMARY:All day event\r\n" +
      "END:VEVENT\r\n",
    );
    const result = parseAllVEvents(ical);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe("2026-04-15");
    expect(result[0].end).toBe("2026-04-16");
  });
});
