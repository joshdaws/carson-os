/**
 * Google Calendar provider — wraps the `gws` CLI for calendar operations.
 *
 * Each family member gets their own gws config directory so they
 * authenticate with their own Google account. The provider resolves
 * the right config dir per member before shelling out to gws.
 *
 * Dependency: `gws` CLI (https://github.com/googleworkspace/cli)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const GWS_BIN = "gws";
const TIMEOUT_MS = 30_000;

// ── Types ──────────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  calendar?: string;
  htmlLink?: string;
}

export interface CalendarAuthStatus {
  authenticated: boolean;
  authMethod: string;
  configDir: string;
}

// ── Provider ───────────────────────────────────────────────────────

export class GoogleCalendarProvider {
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    mkdirSync(rootDir, { recursive: true });
  }

  /** Get the gws config directory for a member. */
  private memberConfigDir(memberSlug: string): string {
    const dir = join(this.rootDir, memberSlug);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Run a gws command with the right config dir for a member. */
  async gws(
    memberSlug: string,
    args: string[],
  ): Promise<string> {
    const configDir = this.memberConfigDir(memberSlug);
    const env = {
      ...process.env,
      GOOGLE_WORKSPACE_CLI_CONFIG_DIR: configDir,
    };

    const { stdout } = await execFileAsync(GWS_BIN, args, {
      timeout: TIMEOUT_MS,
      env,
    });

    return stdout;
  }

  // ── Auth ─────────────────────────────────────────────────────────

  /** Check if a member has authenticated with Google. */
  async getAuthStatus(memberSlug: string): Promise<CalendarAuthStatus> {
    const configDir = this.memberConfigDir(memberSlug);
    try {
      const stdout = await this.gws(memberSlug, ["auth", "status"]);
      const status = JSON.parse(stdout);
      return {
        authenticated: status.auth_method !== "none" && status.storage !== "none",
        authMethod: status.auth_method ?? "none",
        configDir,
      };
    } catch {
      return { authenticated: false, authMethod: "none", configDir };
    }
  }

  /**
   * Copy the shared client_secret.json into a member's config dir.
   * The user needs to run `gws auth login` manually from that dir,
   * or we trigger it from the dashboard.
   */
  setupMemberAuth(memberSlug: string, clientSecretPath: string): string {
    const configDir = this.memberConfigDir(memberSlug);
    const targetPath = join(configDir, "client_secret.json");
    if (!existsSync(targetPath) && existsSync(clientSecretPath)) {
      copyFileSync(clientSecretPath, targetPath);
    }
    return configDir;
  }

  // ── Calendar operations ──────────────────────────────────────────

  /** List upcoming events (default: this week). */
  async listEvents(
    memberSlug: string,
    opts?: { days?: number; today?: boolean; calendar?: string },
  ): Promise<CalendarEvent[]> {
    const args = ["calendar", "+agenda", "--format", "json"];

    if (opts?.today) {
      args.push("--today");
    } else {
      args.push("--days", String(opts?.days ?? 7));
    }

    if (opts?.calendar) {
      args.push("--calendar", opts.calendar);
    }

    try {
      const stdout = await this.gws(memberSlug, args);
      // Strip non-JSON prefix (gws may print "Using keyring backend: keyring" before JSON)
      const jsonStart = stdout.indexOf("{");
      const parsed = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart) : stdout);

      // gws +agenda returns { events: [...], count: N }
      const events: CalendarEvent[] = [];
      const rawEvents = parsed.events ?? [];
      for (const e of rawEvents) {
        events.push({
          id: (e.id as string) ?? "",
          summary: (e.summary as string) ?? "(No title)",
          start: (e.start as string) ?? "",
          end: (e.end as string) ?? "",
          location: e.location || undefined,
          description: e.description as string | undefined,
          calendar: e.calendar as string | undefined,
          htmlLink: e.htmlLink as string | undefined,
        });
      }

      // Sort by start time
      events.sort((a, b) => a.start.localeCompare(b.start));
      return events;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("401") || msg.includes("auth")) {
        throw new Error(`Google Calendar not authenticated for this member. Run 'gws auth login' in ${this.memberConfigDir(memberSlug)}`);
      }
      throw err;
    }
  }

  /** Create a new calendar event. */
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
    const args = [
      "calendar", "+insert",
      "--summary", opts.summary,
      "--start", opts.start,
      "--end", opts.end,
      "--format", "json",
    ];

    if (opts.location) args.push("--location", opts.location);
    if (opts.description) args.push("--description", opts.description);
    if (opts.calendar) args.push("--calendar", opts.calendar);

    const stdout = await this.gws(memberSlug, args);
    const jsonStart = stdout.indexOf("{");
    const result = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart) : stdout);

    return {
      id: result.id ?? "",
      summary: result.summary ?? opts.summary,
      start: (result.start as string) || opts.start,
      end: (result.end as string) || opts.end,
      location: result.location,
      description: result.description,
      htmlLink: result.htmlLink,
    };
  }

  /** Get a specific event by ID. */
  async getEvent(
    memberSlug: string,
    eventId: string,
    calendarId = "primary",
  ): Promise<CalendarEvent> {
    const args = [
      "calendar", "events", "get",
      "--params", JSON.stringify({ calendarId, eventId }),
      "--format", "json",
    ];

    const stdout = await this.gws(memberSlug, args);
    const jsonStart = stdout.indexOf("{");
    const e = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart) : stdout);

    return {
      id: e.id ?? eventId,
      summary: e.summary ?? "(No title)",
      start: formatEventTime(e.start),
      end: formatEventTime(e.end),
      location: e.location,
      description: e.description,
      htmlLink: e.htmlLink,
    };
  }

  /** Check if gws CLI is available. */
  async healthCheck(): Promise<boolean> {
    try {
      await execFileAsync("which", [GWS_BIN], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function formatEventTime(timeObj: unknown): string {
  if (!timeObj || typeof timeObj !== "object") return "";
  const t = timeObj as Record<string, string>;
  return t.dateTime ?? t.date ?? "";
}
