/**
 * Google Drive tool definitions + handler.
 *
 * Tools:
 *   - drive_search     — "Find the budget spreadsheet"
 *   - drive_list       — "What files are in the shared family folder?"
 *   - drive_upload     — "Upload this file to Drive"
 */

import type { ToolDefinition, ToolResult } from "@carsonos/shared";
import type { GoogleCalendarProvider } from "./calendar-provider.js";

export const DRIVE_TOOLS: ToolDefinition[] = [
  {
    name: "drive_search",
    description:
      "Search Google Drive for files by name, content, or type. Use when someone asks to find a document, spreadsheet, photo, or any file.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query — file name or content keywords.",
        },
        type: {
          type: "string",
          enum: ["document", "spreadsheet", "presentation", "pdf", "image", "folder"],
          description: "Filter by file type (optional).",
        },
        max: {
          type: "number",
          description: "Max results (default: 10).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "drive_list",
    description:
      "List recent files in Google Drive, optionally in a specific folder.",
    input_schema: {
      type: "object",
      properties: {
        folderId: {
          type: "string",
          description: "Folder ID to list (default: root/My Drive).",
        },
        max: {
          type: "number",
          description: "Max results (default: 10).",
        },
      },
    },
  },
];

// ── MIME type mapping for Drive search ──────────────────────────────

const MIME_TYPES: Record<string, string> = {
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
  pdf: "application/pdf",
  image: "image/",
  folder: "application/vnd.google-apps.folder",
};

// ── Handler ────────────────────────────────────────────────────────

export function createDriveToolHandler(
  provider: GoogleCalendarProvider,
  memberSlug: string,
): (name: string, input: Record<string, unknown>) => Promise<ToolResult> {
  return async (name, input) => {
    try {
      switch (name) {
        case "drive_search": {
          const query = input.query as string;
          const fileType = input.type as string | undefined;
          const max = (input.max as number) ?? 10;

          // Build Drive query
          let driveQuery = `name contains '${query.replace(/'/g, "\\'")}'`;
          if (fileType && MIME_TYPES[fileType]) {
            if (fileType === "image") {
              driveQuery += ` and mimeType contains '${MIME_TYPES[fileType]}'`;
            } else {
              driveQuery += ` and mimeType = '${MIME_TYPES[fileType]}'`;
            }
          }
          driveQuery += " and trashed = false";

          const args = [
            "drive", "files", "list",
            "--params", JSON.stringify({
              q: driveQuery,
              pageSize: max,
              fields: "files(id,name,mimeType,modifiedTime,webViewLink,size)",
              orderBy: "modifiedTime desc",
            }),
            "--format", "json",
          ];

          const stdout = await provider.gws(memberSlug, args);
          const jsonStart = stdout.indexOf("{");
          const result = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart) : stdout);
          const files = result.files ?? [];

          if (files.length === 0) {
            return { content: `No files found for "${query}".` };
          }

          const formatted = files
            .map((f: Record<string, string>) =>
              `- ${f.name} (${formatMimeType(f.mimeType)}, modified ${f.modifiedTime?.slice(0, 10) ?? "unknown"})${f.webViewLink ? ` — ${f.webViewLink}` : ""}`
            )
            .join("\n");

          return { content: `${files.length} files:\n${formatted}` };
        }

        case "drive_list": {
          const folderId = (input.folderId as string) ?? "root";
          const max = (input.max as number) ?? 10;

          const args = [
            "drive", "files", "list",
            "--params", JSON.stringify({
              q: `'${folderId}' in parents and trashed = false`,
              pageSize: max,
              fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
              orderBy: "modifiedTime desc",
            }),
            "--format", "json",
          ];

          const stdout = await provider.gws(memberSlug, args);
          const jsonStart = stdout.indexOf("{");
          const result = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart) : stdout);
          const files = result.files ?? [];

          if (files.length === 0) {
            return { content: "No files in this folder." };
          }

          const formatted = files
            .map((f: Record<string, string>) =>
              `- ${f.name} (${formatMimeType(f.mimeType)}) [id: ${f.id}]`
            )
            .join("\n");

          return { content: `${files.length} files:\n${formatted}` };
        }

        default:
          return { content: `Unknown Drive tool: ${name}`, is_error: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Drive error: ${msg}`, is_error: true };
    }
  };
}

function formatMimeType(mimeType: string): string {
  if (!mimeType) return "file";
  if (mimeType.includes("document")) return "Doc";
  if (mimeType.includes("spreadsheet")) return "Sheet";
  if (mimeType.includes("presentation")) return "Slides";
  if (mimeType.includes("folder")) return "Folder";
  if (mimeType.includes("pdf")) return "PDF";
  if (mimeType.includes("image")) return "Image";
  return "file";
}
