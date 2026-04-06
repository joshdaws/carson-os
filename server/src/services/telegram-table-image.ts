/**
 * Table-to-image renderer for Telegram.
 *
 * Converts markdown tables into PNG images via SVG -> sharp.
 * Tables render as clean, styled HTML-like tables that users
 * can pinch-to-zoom on mobile.
 */

import sharp from "sharp";

// ── Types ───────────────────────────────────────────────────────────

interface ParsedTable {
  headers: string[];
  rows: string[][];
}

// ── Constants ───────────────────────────────────────────────────────

const FONT_SIZE = 14;
const FONT_FAMILY = "monospace";
const HEADER_BG = "#1a1f2e";
const HEADER_TEXT = "#e8dfd0";
const ROW_BG_EVEN = "#faf8f4";
const ROW_BG_ODD = "#f0ede6";
const BORDER_COLOR = "#ddd5c8";
const TEXT_COLOR = "#1a1f2e";
const CELL_PAD_X = 12;
const CELL_PAD_Y = 8;
const CHAR_WIDTH = 8.4; // approximate monospace char width at 14px
const LINE_HEIGHT = FONT_SIZE + CELL_PAD_Y * 2;

// ── Public API ──────────────────────────────────────────────────────

/**
 * Parse a markdown table string into headers and rows.
 * Returns null if the input doesn't look like a valid table.
 */
export function parseMarkdownTable(markdown: string): ParsedTable | null {
  const lines = markdown.trim().split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  const parseLine = (line: string): string[] =>
    line.split("|").slice(1, -1).map((c) => c.trim());

  // Find the separator row (|---|---|)
  const sepIdx = lines.findIndex((l) => /^\|[\s-:|]+\|$/.test(l));

  let headers: string[];
  let dataLines: string[];

  if (sepIdx >= 0) {
    // Has separator: everything before is header, everything after is data
    headers = parseLine(lines[sepIdx - 1] || lines[0]);
    dataLines = lines.slice(sepIdx + 1);
  } else {
    // No separator: first line is header
    headers = parseLine(lines[0]);
    dataLines = lines.slice(1);
  }

  const rows = dataLines
    .filter((l) => !/^\|[\s-:|]+\|$/.test(l)) // skip any extra separators
    .map(parseLine);

  if (headers.length === 0 || rows.length === 0) return null;

  return { headers, rows };
}

/**
 * Render a parsed table to a PNG buffer.
 * Returns the image as a Buffer ready to send via Telegram.
 */
export async function renderTableImage(table: ParsedTable): Promise<Buffer> {
  const { headers, rows } = table;
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length));

  // Calculate column widths based on content
  const colWidths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    const headerLen = (headers[c] || "").length;
    const maxDataLen = Math.max(...rows.map((r) => (r[c] || "").length), 0);
    const charCount = Math.max(headerLen, maxDataLen, 3);
    colWidths[c] = charCount * CHAR_WIDTH + CELL_PAD_X * 2;
  }

  const tableWidth = colWidths.reduce((sum, w) => sum + w, 0) + 2; // +2 for border
  const tableHeight = LINE_HEIGHT * (rows.length + 1) + 2; // +1 for header, +2 for border

  // Build SVG
  const svgParts: string[] = [];

  svgParts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tableWidth}" height="${tableHeight}">`,
    `<rect width="${tableWidth}" height="${tableHeight}" fill="${ROW_BG_EVEN}" rx="4"/>`,
  );

  // Header row
  let x = 1;
  svgParts.push(
    `<rect x="1" y="1" width="${tableWidth - 2}" height="${LINE_HEIGHT}" fill="${HEADER_BG}" rx="4"/>`,
    `<rect x="1" y="${LINE_HEIGHT - 4}" width="${tableWidth - 2}" height="8" fill="${HEADER_BG}"/>`,
  );

  for (let c = 0; c < colCount; c++) {
    const text = escapeXml(headers[c] || "");
    svgParts.push(
      `<text x="${x + CELL_PAD_X}" y="${LINE_HEIGHT / 2 + FONT_SIZE / 3}" ` +
      `font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" font-weight="bold" ` +
      `fill="${HEADER_TEXT}">${text}</text>`,
    );
    x += colWidths[c];
  }

  // Data rows
  for (let r = 0; r < rows.length; r++) {
    const y = LINE_HEIGHT * (r + 1) + 1;
    const bg = r % 2 === 0 ? ROW_BG_EVEN : ROW_BG_ODD;

    svgParts.push(
      `<rect x="1" y="${y}" width="${tableWidth - 2}" height="${LINE_HEIGHT}" fill="${bg}"/>`,
    );

    // Horizontal separator
    svgParts.push(
      `<line x1="1" y1="${y}" x2="${tableWidth - 1}" y2="${y}" stroke="${BORDER_COLOR}" stroke-width="1"/>`,
    );

    x = 1;
    for (let c = 0; c < colCount; c++) {
      const text = escapeXml(rows[r]?.[c] || "");
      svgParts.push(
        `<text x="${x + CELL_PAD_X}" y="${y + LINE_HEIGHT / 2 + FONT_SIZE / 3}" ` +
        `font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" ` +
        `fill="${TEXT_COLOR}">${text}</text>`,
      );
      x += colWidths[c];
    }
  }

  // Vertical column separators
  x = 1;
  for (let c = 0; c < colCount - 1; c++) {
    x += colWidths[c];
    svgParts.push(
      `<line x1="${x}" y1="1" x2="${x}" y2="${tableHeight - 1}" stroke="${BORDER_COLOR}" stroke-width="1"/>`,
    );
  }

  // Outer border
  svgParts.push(
    `<rect x="0.5" y="0.5" width="${tableWidth - 1}" height="${tableHeight - 1}" ` +
    `fill="none" stroke="${BORDER_COLOR}" stroke-width="1" rx="4"/>`,
  );

  svgParts.push("</svg>");

  const svg = svgParts.join("\n");

  // Convert SVG to PNG via sharp
  const png = await sharp(Buffer.from(svg))
    .png()
    .toBuffer();

  return png;
}

/**
 * Detect markdown tables in text, render each as an image,
 * and return the text with tables removed plus the image buffers.
 */
interface TableImage {
  image: Buffer;
  caption: string;
  markdown: string;  // raw table markdown for LLM description
}

export async function extractAndRenderTables(
  text: string,
): Promise<{ cleanText: string; images: TableImage[] }> {
  const images: TableImage[] = [];
  const TABLE_REGEX = /((?:^[|].+[|]\s*(?:\n|$))+)/gm;

  let cleanText = text;
  const matches = [...text.matchAll(TABLE_REGEX)];

  for (const match of matches) {
    const tableBlock = match[0];
    const parsed = parseMarkdownTable(tableBlock);

    if (parsed && parsed.rows.length > 0) {
      try {
        const img = await renderTableImage(parsed);

        // Build a descriptive caption from context around the table
        const caption = buildTableCaption(text, match.index ?? 0, parsed);

        images.push({ image: img, caption, markdown: tableBlock });
        cleanText = cleanText.replace(tableBlock, "[table sent as image]");
      } catch (err) {
        console.error("[table-image] Failed to render table:", err);
      }
    }
  }

  return { cleanText: cleanText.trim(), images };
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Derive a descriptive caption for a table by looking at what
 * comes immediately before it in the source text: a heading,
 * a sentence, or a label line. Falls back to summarizing the
 * column headers.
 */
function buildTableCaption(
  fullText: string,
  tableStartIndex: number,
  table: ParsedTable,
): string {
  // Look at the text before the table (last 200 chars before the match)
  const before = fullText.slice(Math.max(0, tableStartIndex - 200), tableStartIndex).trim();

  if (before.length > 0) {
    const lines = before.split("\n").filter((l) => l.trim().length > 0);
    const lastLine = lines[lines.length - 1]?.trim() ?? "";

    // If the last line before the table is a heading (# ...), use it
    const headingMatch = lastLine.match(/^#{1,6}\s+(.+)/);
    if (headingMatch) {
      return headingMatch[1].trim();
    }

    // If the last line is a short label (under 80 chars, ends with colon or is a sentence)
    if (lastLine.length > 0 && lastLine.length < 80) {
      // Strip trailing colon
      return lastLine.replace(/:$/, "").trim();
    }
  }

  // Fallback: describe using column headers
  return table.headers.join(" / ");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
