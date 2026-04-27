/**
 * CalDAV calendar provider — wraps the `tsdav` client for calendar operations.
 *
 * Each family member gets their own credentials file so they authenticate
 * with their own CalDAV account (iCloud, Nextcloud, Fastmail, etc.).
 *
 * Credentials are stored at:
 *   ~/.carsonos/caldav/<memberSlug>/credentials.json
 *
 * Dependency: `tsdav` npm package (included in server deps)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDAVClient } from "tsdav";
import type { DAVCalendar, DAVObject } from "tsdav";

const TIMEOUT_MS = 30_000;

// ── Types ──────────────────────────────────────────────────────────

export interface CalDavCredentials {
  serverUrl: string;
  username: string;
  password: string;
}

export interface CalDavAuthStatus {
  authenticated: boolean;
  credentialsPath: string;
}

/** A single parsed VEVENT block, used internally before building CalendarEvent. */
export interface ParsedVEvent {
  /** Raw iCal DTSTART value (e.g. "20260415T140000Z") — used as the occurrence ID fragment. */
  rawDtstart: string;
  /** Raw RECURRENCE-ID value, present only on exception/override instances. */
  recurrenceId?: string;
  summary?: string;
  start?: string;
  end?: string;
  location?: string;
  description?: string;
}

export interface CalendarEvent {
  /**
   * Stable ID for this event. For single events: the CalDAV object URL.
   * For recurring event occurrences: `${url}#${rawDtstart}` so each occurrence
   * is uniquely addressable by get_calendar_event.
   */
  id: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  /** Display name of the calendar this event belongs to. */
  calendar?: string;
  /** Not applicable for CalDAV — included for interface parity with Google provider. */
  htmlLink?: string;
}

// ── Provider ───────────────────────────────────────────────────────

export class CalDavProvider {
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

  private loadCredentials(memberSlug: string): CalDavCredentials {
    const path = this.credentialsPath(memberSlug);
    if (!existsSync(path)) {
      throw new Error(
        `CalDAV not configured for this member. Create ${path} with fields: serverUrl, username, password`,
      );
    }
    try {
      return JSON.parse(readFileSync(path, "utf8")) as CalDavCredentials;
    } catch {
      throw new Error(`Failed to read CalDAV credentials at ${path}. Check that the file is valid JSON.`);
    }
  }

  private async createClient(creds: CalDavCredentials) {
    return createDAVClient({
      serverUrl: creds.serverUrl,
      credentials: { username: creds.username, password: creds.password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
  }

  // ── Auth ─────────────────────────────────────────────────────────

  /** Check if a member has a credentials file saved. */
  getAuthStatus(memberSlug: string): CalDavAuthStatus {
    const path = this.credentialsPath(memberSlug);
    return { authenticated: existsSync(path), credentialsPath: path };
  }

  /**
   * Save credentials for a member. Writes credentials.json to the member's
   * CalDAV directory. The server is not contacted — call listEvents() to
   * verify the credentials work.
   */
  saveCredentials(memberSlug: string, credentials: CalDavCredentials): string {
    const path = this.credentialsPath(memberSlug);
    writeFileSync(path, JSON.stringify(credentials, null, 2), "utf8");
    return path;
  }

  // ── Calendar operations ──────────────────────────────────────────

  /**
   * List upcoming events across all of a member's calendars.
   * opts.days     — how many days ahead to look (default: 7)
   * opts.today    — only return today's events
   * opts.calendar — filter to a specific calendar display name
   */
  async listEvents(
    memberSlug: string,
    opts?: { days?: number; today?: boolean; calendar?: string },
  ): Promise<CalendarEvent[]> {
    const creds = this.loadCredentials(memberSlug);
    const client = await withTimeout(this.createClient(creds), TIMEOUT_MS);

    const now = new Date();
    const startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(startDate);
    if (opts?.today) {
      endDate.setHours(23, 59, 59, 999);
    } else {
      endDate.setDate(endDate.getDate() + (opts?.days ?? 7));
      endDate.setHours(23, 59, 59, 999);
    }

    const calendars = await withTimeout(client.fetchCalendars(), TIMEOUT_MS);

    // Filter to the requested calendar name if provided
    const targetCalendars = opts?.calendar
      ? calendars.filter((c) =>
          getCalendarName(c).toLowerCase().includes(opts.calendar!.toLowerCase()),
        )
      : calendars;

    if (targetCalendars.length === 0 && opts?.calendar) {
      throw new Error(
        `No calendar found matching "${opts.calendar}". Available: ${calendars.map(getCalendarName).join(", ")}`,
      );
    }

    const events: CalendarEvent[] = [];

    for (const cal of targetCalendars) {
      let objects: DAVObject[];
      try {
        objects = await withTimeout(
          client.fetchCalendarObjects({
            calendar: cal,
            expand: true,
            timeRange: {
              start: startDate.toISOString(),
              end: endDate.toISOString(),
            },
          }),
          TIMEOUT_MS,
        );
      } catch {
        // Some calendars (e.g. task/reminder lists) don't support time-range queries — skip them
        continue;
      }

      const calName = getCalendarName(cal);
      for (const obj of objects) {
        if (!obj.data) continue;
        // parseAllVEvents returns one entry per VEVENT block. With expand:true the
        // server expands recurring events, so a weekly meeting with 3 occurrences
        // in the window yields 3 ParsedVEvent entries, each with the correct DTSTART.
        const vevents = parseAllVEvents(obj.data);
        for (const vevent of vevents) {
          if (!vevent.summary) continue;
          events.push({
            // Append raw DTSTART as fragment so each occurrence has a unique,
            // stable ID that getEvent can use to retrieve the right instance.
            id: `${obj.url}#${vevent.rawDtstart}`,
            summary: vevent.summary,
            start: vevent.start ?? "",
            end: vevent.end ?? "",
            location: vevent.location,
            description: vevent.description,
            calendar: calName,
          });
        }
      }
    }

    // Sort by start time
    events.sort((a, b) => a.start.localeCompare(b.start));
    return events;
  }

  /** Create a new calendar event on the member's primary (first) calendar, or a named one. */
  async createEvent(
    memberSlug: string,
    opts: {
      summary: string;
      start: string;
      end: string;
      location?: string;
      description?: string;
      calendar?: string;
    },
  ): Promise<CalendarEvent> {
    const creds = this.loadCredentials(memberSlug);
    const client = await withTimeout(this.createClient(creds), TIMEOUT_MS);

    const calendars = await withTimeout(client.fetchCalendars(), TIMEOUT_MS);
    if (calendars.length === 0) {
      throw new Error("No calendars found for this member.");
    }

    // Pick the named calendar or fall back to the first one
    const targetCal = opts.calendar
      ? (calendars.find((c) =>
          getCalendarName(c).toLowerCase().includes(opts.calendar!.toLowerCase()),
        ) ?? calendars[0])
      : calendars[0];

    const uid = randomUUID();
    const filename = `${uid}.ics`;
    const iCalString = buildVEvent({
      uid,
      summary: opts.summary,
      start: opts.start,
      end: opts.end,
      location: opts.location,
      description: opts.description,
    });

    await withTimeout(
      client.createCalendarObject({
        calendar: targetCal,
        filename,
        iCalString,
      }),
      TIMEOUT_MS,
    );

    const eventUrl = `${targetCal.url.replace(/\/$/, "")}/${filename}`;

    return {
      id: eventUrl,
      summary: opts.summary,
      start: opts.start,
      end: opts.end,
      location: opts.location,
      description: opts.description,
      calendar: getCalendarName(targetCal),
    };
  }

  /**
   * Get a specific event by its ID (the `id` field returned by listEvents /
   * createEvent). Handles two ID formats:
   *
   *   - Plain URL  (createEvent): `https://caldav.example.com/.../event.ics`
   *   - URL#dtstart (listEvents): `https://caldav.example.com/.../event.ics#20260415T140000Z`
   *
   * For recurring occurrences the fragment is the raw iCal DTSTART of that
   * instance. We fetch the master object and look for:
   *   1. An exception/override VEVENT whose RECURRENCE-ID matches the fragment.
   *   2. Falling back to the master VEVENT's properties with the occurrence's DTSTART.
   *
   * The `_calendarId` parameter is accepted for API parity with the Google
   * provider but is not needed — the calendar URL is inferred from the event URL.
   */
  async getEvent(
    memberSlug: string,
    eventId: string,
    _calendarId?: string,
  ): Promise<CalendarEvent> {
    const creds = this.loadCredentials(memberSlug);
    const client = await withTimeout(this.createClient(creds), TIMEOUT_MS);

    // Split off the occurrence fragment added by listEvents
    const hashIdx = eventId.lastIndexOf("#");
    const url = hashIdx >= 0 ? eventId.slice(0, hashIdx) : eventId;
    const targetDtstart = hashIdx >= 0 ? eventId.slice(hashIdx + 1) : undefined;

    // Derive the parent calendar URL from the object URL
    const calendarUrl = url.substring(0, url.lastIndexOf("/") + 1);

    const objects = await withTimeout(
      client.fetchCalendarObjects({
        calendar: { url: calendarUrl } as DAVCalendar,
        objectUrls: [url],
      }),
      TIMEOUT_MS,
    );

    const obj = objects.find((o) => o.url === url) ?? objects[0];
    if (!obj?.data) {
      throw new Error(`Event not found: ${url}`);
    }

    const vevents = parseAllVEvents(obj.data);
    if (vevents.length === 0) {
      throw new Error(`No VEVENT found in calendar object: ${url}`);
    }

    let vevent: ParsedVEvent;
    if (targetDtstart) {
      // Prefer an exception VEVENT whose RECURRENCE-ID matches this occurrence
      const override = vevents.find((v) => v.recurrenceId === targetDtstart);
      // Fall back to the master (no RECURRENCE-ID) or first VEVENT
      const master = vevents.find((v) => !v.recurrenceId) ?? vevents[0];
      if (override) {
        vevent = override;
      } else {
        // Use master properties (description, location, etc.) but stamp with
        // the specific occurrence's DTSTART so the returned time is correct.
        vevent = { ...master, rawDtstart: targetDtstart, start: parseICalDate(targetDtstart) };
      }
    } else {
      vevent = vevents[0];
    }

    return {
      id: eventId,
      summary: vevent.summary ?? "(No title)",
      start: vevent.start ?? "",
      end: vevent.end ?? "",
      location: vevent.location,
      description: vevent.description,
    };
  }

  /**
   * CalDAV is always available (it's an npm package, not an external CLI).
   * Returns true unconditionally — per-member auth is checked via getAuthStatus().
   */
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

// ── iCal helpers ───────────────────────────────────────────────────

/**
 * Extract the display name from a DAVCalendar, handling both string
 * and object forms (some servers return { _cdata: "Name" }).
 */
function getCalendarName(cal: DAVCalendar): string {
  if (typeof cal.displayName === "string" && cal.displayName) {
    return cal.displayName;
  }
  if (cal.displayName && typeof cal.displayName === "object") {
    const name = (cal.displayName as Record<string, unknown>)["_cdata"];
    if (typeof name === "string" && name) return name;
  }
  // Fall back to the last path segment of the URL
  const parts = (cal.url ?? "").replace(/\/$/, "").split("/");
  return parts[parts.length - 1] ?? "Calendar";
}

/**
 * Parse ALL VEVENT blocks out of an iCalendar string and return one
 * ParsedVEvent per block.
 *
 * With CalDAV server-side expansion (expand:true + timeRange), the server
 * returns a VCALENDAR where each occurrence of a recurring event is a
 * separate VEVENT block with its own DTSTART and, for exception instances,
 * a RECURRENCE-ID. This function collects every block so the caller gets
 * one CalendarEvent per occurrence rather than just the master.
 *
 * Handles CRLF/LF line endings and RFC 5545 line folding (continuation lines).
 */
export function parseAllVEvents(ical: string): ParsedVEvent[] {
  // Unfold: CRLF/LF followed by whitespace is a continuation
  const unfolded = ical.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  const lines = unfolded.split(/\r\n|\n/);

  const results: ParsedVEvent[] = [];
  let inVEvent = false;
  let props: Record<string, string> = {};

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inVEvent = true;
      props = {};
      continue;
    }
    if (line === "END:VEVENT") {
      inVEvent = false;
      // Only emit if there's a DTSTART — skip malformed or VTODO/VJOURNAL blocks
      if (props["DTSTART"]) {
        results.push({
          rawDtstart: props["DTSTART"],
          recurrenceId: props["RECURRENCE-ID"],
          summary: props["SUMMARY"] ? decodeICalText(props["SUMMARY"]) : undefined,
          start: parseICalDate(props["DTSTART"]),
          end: props["DTEND"] ? parseICalDate(props["DTEND"]) : undefined,
          location: props["LOCATION"] ? decodeICalText(props["LOCATION"]) : undefined,
          description: props["DESCRIPTION"] ? decodeICalText(props["DESCRIPTION"]) : undefined,
        });
      }
      props = {};
      continue;
    }
    if (!inVEvent) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;

    const rawKey = line.slice(0, colonIdx).toUpperCase();
    const value = line.slice(colonIdx + 1).trim();

    // Normalised property name (strip parameters like TZID=...)
    const propName = rawKey.split(";")[0];
    props[propName] = value;

    // Also store the full raw key so DTSTART;TZID=America/Chicago:... is
    // captured under both "DTSTART" and "DTSTART;TZID=AMERICA/CHICAGO".
    props[rawKey] = value;
  }

  return results;
}

/** Convert an iCal date/datetime value to an ISO 8601 string. */
export function parseICalDate(value: string): string {
  // All-day: YYYYMMDD
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  // UTC datetime: YYYYMMDDTHHmmssZ
  if (/^\d{8}T\d{6}Z$/.test(value)) {
    return new Date(
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T` +
        `${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
    ).toISOString();
  }
  // Floating datetime: YYYYMMDDTHHmmss (no timezone suffix)
  if (/^\d{8}T\d{6}$/.test(value)) {
    return (
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T` +
      `${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}`
    );
  }
  // Return as-is if unrecognised
  return value;
}

/** Decode iCal text escaping (\\n → newline, \\, → comma, etc.). */
export function decodeICalText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** Encode a plain string for use as an iCal text property value. */
export function encodeICalText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** Convert an ISO 8601 datetime string to iCal DTSTART/DTEND format (UTC). */
function toICalDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  // e.g. 20260415T140000Z
}

/**
 * Build a minimal valid VCALENDAR/VEVENT iCalendar string.
 * RFC 5545 §3.1: lines must be folded at 75 octets.
 */
function buildVEvent(opts: {
  uid: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
}): string {
  const now = toICalDateTime(new Date().toISOString());

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CarsonOS//CarsonOS CalDAV//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${opts.uid}@carsonos`,
    `DTSTAMP:${now}`,
    `DTSTART:${toICalDateTime(opts.start)}`,
    `DTEND:${toICalDateTime(opts.end)}`,
    `SUMMARY:${encodeICalText(opts.summary)}`,
  ];

  if (opts.location) lines.push(`LOCATION:${encodeICalText(opts.location)}`);
  if (opts.description) lines.push(`DESCRIPTION:${encodeICalText(opts.description)}`);

  lines.push("END:VEVENT", "END:VCALENDAR");

  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/**
 * Fold a single iCal content line at 75 octets (RFC 5545 §3.1).
 * Continuation lines begin with a single space.
 */
export function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  chunks.push(line.slice(0, 75));
  let i = 75;
  while (i < line.length) {
    chunks.push(" " + line.slice(i, i + 74));
    i += 74;
  }
  return chunks.join("\r\n");
}

// ── Utility ────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`CalDAV request timed out after ${ms}ms`)), ms),
    ),
  ]);
}
