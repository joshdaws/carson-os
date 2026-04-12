/**
 * Google Calendar tool definitions + handler.
 *
 * Three tools:
 *   - list_calendar_events  — "What do we have this week?"
 *   - create_calendar_event — "Schedule a dentist appointment Thursday at 2pm"
 *   - get_calendar_event    — "Tell me more about that meeting"
 *
 * Tools are registered in the ToolRegistry and granted per-agent.
 */

import type { ToolDefinition, ToolResult } from "@carsonos/shared";
import type { GoogleCalendarProvider } from "./calendar-provider.js";

// ── Tool definitions ───────────────────────────────────────────────

export const CALENDAR_TOOLS: ToolDefinition[] = [
  {
    name: "list_calendar_events",
    description:
      "List upcoming calendar events. Use this when someone asks about their schedule, what's coming up, or what they have this week. Returns events from all of this member's calendars.",
    input_schema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "How many days ahead to look (default: 7).",
        },
        today: {
          type: "boolean",
          description: "Set true to only show today's events.",
        },
        calendar: {
          type: "string",
          description: "Filter to a specific calendar name (optional).",
        },
      },
    },
  },
  {
    name: "create_calendar_event",
    description:
      "Create a new calendar event. Use this when someone asks to schedule, book, or add something to the calendar. Always confirm the date and time with the user before creating.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Event title (e.g., 'Dentist appointment').",
        },
        start: {
          type: "string",
          description: "Start time in ISO 8601 format (e.g., '2026-04-15T14:00:00-05:00').",
        },
        end: {
          type: "string",
          description: "End time in ISO 8601 format.",
        },
        location: {
          type: "string",
          description: "Event location (optional).",
        },
        description: {
          type: "string",
          description: "Event description/notes (optional).",
        },
        calendar: {
          type: "string",
          description: "Which calendar to add to (default: primary).",
        },
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    name: "get_calendar_event",
    description:
      "Get details of a specific calendar event by its ID. Use this to get more info about an event from the list.",
    input_schema: {
      type: "object",
      properties: {
        eventId: {
          type: "string",
          description: "The event ID (from list_calendar_events results).",
        },
        calendarId: {
          type: "string",
          description: "Calendar ID (default: primary).",
        },
      },
      required: ["eventId"],
    },
  },
];

// ── Handler ────────────────────────────────────────────────────────

export function createCalendarToolHandler(
  provider: GoogleCalendarProvider,
  memberSlug: string,
): (name: string, input: Record<string, unknown>) => Promise<ToolResult> {
  return async (name, input) => {
    try {
      switch (name) {
        case "list_calendar_events": {
          const events = await provider.listEvents(memberSlug, {
            days: input.days as number | undefined,
            today: input.today as boolean | undefined,
            calendar: input.calendar as string | undefined,
          });

          if (events.length === 0) {
            return { content: "No events found for that time period." };
          }

          const formatted = events
            .map((e) => {
              const cal = e.calendar ? ` [${e.calendar}]` : "";
              const loc = e.location ? ` @ ${e.location}` : "";
              return `- ${e.start} — ${e.summary}${cal}${loc} (id: ${e.id})`;
            })
            .join("\n");

          return { content: `${events.length} events:\n${formatted}` };
        }

        case "create_calendar_event": {
          const event = await provider.createEvent(memberSlug, {
            summary: input.summary as string,
            start: input.start as string,
            end: input.end as string,
            location: input.location as string | undefined,
            description: input.description as string | undefined,
            calendar: input.calendar as string | undefined,
          });

          return {
            content: `Event created: "${event.summary}" on ${event.start}${event.htmlLink ? ` — ${event.htmlLink}` : ""}`,
          };
        }

        case "get_calendar_event": {
          const event = await provider.getEvent(
            memberSlug,
            input.eventId as string,
            input.calendarId as string | undefined,
          );

          const parts = [
            `**${event.summary}**`,
            `Start: ${event.start}`,
            `End: ${event.end}`,
          ];
          if (event.location) parts.push(`Location: ${event.location}`);
          if (event.description) parts.push(`Description: ${event.description}`);
          if (event.htmlLink) parts.push(`Link: ${event.htmlLink}`);

          return { content: parts.join("\n") };
        }

        default:
          return { content: `Unknown calendar tool: ${name}`, is_error: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Calendar error: ${msg}`, is_error: true };
    }
  };
}
