/**
 * Markdown-to-Telegram-HTML converter for CarsonOS.
 *
 * LLMs produce markdown; Telegram expects a subset of HTML.
 * Every outbound message passes through this module before dispatch.
 *
 * Pure functions. No dependencies.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape HTML entities so content doesn't collide with our formatting tags. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Unescape HTML entities (used when we need to re-escape selectively). */
function unescapeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// ---------------------------------------------------------------------------
// stripThinkingBlocks
// ---------------------------------------------------------------------------

/**
 * Remove LLM thinking/thought blocks from text.
 * Preserves blocks that appear inside markdown code fences.
 */
export function stripThinkingBlocks(text: string): string {
  // First, pull out fenced code blocks so we don't touch them.
  const codeFences: string[] = [];
  const CODE_PLACEHOLDER = "\x00CODE_FENCE\x00";

  let processed = text.replace(/```[\s\S]*?```/g, (match) => {
    codeFences.push(match);
    return CODE_PLACEHOLDER;
  });

  // Remove <think>...</think>, <thinking>...</thinking>, <thought>...</thought>
  processed = processed.replace(
    /<(?:think|thinking|thought)>[\s\S]*?<\/(?:think|thinking|thought)>/gi,
    ""
  );

  // Restore code fences
  let idx = 0;
  processed = processed.replace(
    new RegExp(CODE_PLACEHOLDER.replace(/\x00/g, "\\x00"), "g"),
    () => codeFences[idx++]
  );

  return processed.trim();
}

// ---------------------------------------------------------------------------
// markdownToTelegramHtml
// ---------------------------------------------------------------------------

/**
 * Convert markdown text to Telegram-compatible HTML.
 *
 * Handles: bold, italic, strikethrough, inline code, code blocks,
 * links, blockquotes, and escaped characters.
 */
export function markdownToTelegramHtml(text: string): string {
  // Handle escaped characters first -- replace \* \_ \~ \` \[ \] \\ with placeholders
  const escapes: string[] = [];
  const ESC_PLACEHOLDER = "\x01ESC";

  let result = text.replace(/\\([*_~`\[\]\\>])/g, (_match, char) => {
    const index = escapes.length;
    escapes.push(char);
    return `${ESC_PLACEHOLDER}${index}\x01`;
  });

  // Extract fenced code blocks before any other processing.
  // They must not have their content transformed.
  const codeBlocks: string[] = [];
  const CODEBLOCK_PLACEHOLDER = "\x02CODEBLOCK";

  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const index = codeBlocks.length;
    const escaped = escapeHtml(code.replace(/\n$/, "")); // trim trailing newline inside fence
    if (lang) {
      codeBlocks.push(
        `<pre><code class="language-${lang}">${escaped}</code></pre>`
      );
    } else {
      codeBlocks.push(`<pre>${escaped}</pre>`);
    }
    return `${CODEBLOCK_PLACEHOLDER}${index}\x02`;
  });

  // Extract inline code before processing other inline formatting.
  const inlineCodes: string[] = [];
  const INLINE_CODE_PLACEHOLDER = "\x03INLINECODE";

  result = result.replace(/`([^`]+?)`/g, (_match, code) => {
    const index = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `${INLINE_CODE_PLACEHOLDER}${index}\x03`;
  });

  // Now escape HTML entities in the remaining content (outside code).
  result = escapeHtml(result);

  // --- Headers ---
  // # H1 -> <b>H1</b> (Telegram has no header tags, use bold + newlines)
  result = result.replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, text) => {
    return `\n<b>${text.trim()}</b>\n`;
  });

  // --- Horizontal rules ---
  // ---, ***, ___ on their own line -> thin line
  result = result.replace(/^[-*_]{3,}\s*$/gm, "———");

  // --- Task lists ---
  // - [x] done -> ✅ done
  // - [ ] todo -> ☐ todo
  result = result.replace(/^(\s*)[-*]\s*\[x\]\s*/gm, "$1✅ ");
  result = result.replace(/^(\s*)[-*]\s*\[ ?\]\s*/gm, "$1☐ ");

  // --- Image syntax ---
  // ![alt](url) -> [alt](url) (strip the !, then link handler below catches it)
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "[$1]($2)");

  // --- Tables ---
  // Convert markdown tables to monospace <pre> with padded columns
  result = result.replace(
    /((?:^[|].+[|]\s*(?:\n|$))+)/gm,
    (tableBlock) => {
      const allRows = tableBlock
        .split("\n")
        .filter((line) => line.trim().length > 0);
      // Strip separator rows (|---|---|)
      const dataRows = allRows.filter((line) => !/^\|[\s-:|]+\|$/.test(line));
      if (dataRows.length === 0) return tableBlock;

      // Parse cells
      const parsed = dataRows.map((row) =>
        row.split("|").slice(1, -1).map((cell) => cell.trim())
      );

      // Calculate max width per column
      const colCount = Math.max(...parsed.map((r) => r.length));
      const colWidths: number[] = [];
      for (let c = 0; c < colCount; c++) {
        colWidths[c] = Math.max(...parsed.map((r) => (r[c] || "").length), 1);
      }

      // Render with padding
      const formatted = parsed.map((row) =>
        row.map((cell, c) => cell.padEnd(colWidths[c] || 1)).join(" │ ")
      );

      // Add separator after header
      if (formatted.length > 1) {
        const sep = colWidths.map((w) => "─".repeat(w)).join("─┼─");
        formatted.splice(1, 0, sep);
      }

      return `<pre>${formatted.join("\n")}</pre>`;
    }
  );

  // --- Blockquotes ---
  // Merge consecutive blockquote lines into a single <blockquote>.
  // Handle nested: >> and >>> become single level (Telegram only supports one level)
  result = result.replace(
    /(^|\n)((?:&gt;)+ .+(?:\n(?:&gt;)+ .+)*)/g,
    (_match, prefix, block) => {
      const lines = block
        .split("\n")
        .map((line: string) => line.replace(/^(?:&gt;)+ /, ""))
        .join("\n");
      return `${prefix}<blockquote>${lines}</blockquote>`;
    }
  );

  // --- Links ---
  // [text](url) -> <a href="url">text</a>
  // The URL was HTML-escaped above so we need to un-escape the href value.
  result = result.replace(
    /\[([^\]]+?)\]\(([^)]+?)\)/g,
    (_match, linkText, url) => {
      return `<a href="${unescapeHtml(url)}">${linkText}</a>`;
    }
  );

  // --- Strikethrough ---
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // --- Bold + Italic combined: ***text*** or ___text___ ---
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
  result = result.replace(/___(.+?)___/g, "<b><i>$1</i></b>");

  // --- Bold ---
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/__(.+?)__/g, "<b>$1</b>");

  // --- Italic ---
  // Single * or _ but NOT inside a bold marker (which we already consumed).
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<i>$1</i>");
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<i>$1</i>");

  // --- Restore inline code ---
  result = result.replace(
    new RegExp(`${INLINE_CODE_PLACEHOLDER}(\\d+)\\x03`, "g"),
    (_match, index) => inlineCodes[parseInt(index, 10)]
  );

  // --- Restore code blocks ---
  result = result.replace(
    new RegExp(`${CODEBLOCK_PLACEHOLDER}(\\d+)\\x02`, "g"),
    (_match, index) => codeBlocks[parseInt(index, 10)]
  );

  // --- Restore escaped characters ---
  result = result.replace(
    new RegExp(`${ESC_PLACEHOLDER}(\\d+)\\x01`, "g"),
    (_match, index) => escapeHtml(escapes[parseInt(index, 10)])
  );

  // --- Collapse excessive newlines ---
  // 3+ consecutive newlines → 2 (one blank line max between paragraphs)
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

// ---------------------------------------------------------------------------
// wrapFileReferences
// ---------------------------------------------------------------------------

const FILE_EXTENSIONS =
  /(?<!\w)([\w./-]+\.(?:md|ts|js|py|json|yaml|yml|txt|css|html))(?!\w)/g;

/**
 * Wrap bare file references (e.g. `foo.ts`, `src/bar.py`) in `<code>` tags
 * so Telegram doesn't try to create link previews to domain registrars.
 *
 * Skips content already inside `<code>` or `<pre>` tags.
 */
export function wrapFileReferences(html: string): string {
  // Split the HTML into segments that are inside code/pre tags and those outside.
  // We only transform the "outside" segments.
  const parts: string[] = [];
  let lastIndex = 0;

  // Match <code>...</code> and <pre>...</pre> (including nested variants).
  const tagPattern = /<(?:code|pre)[^>]*>[\s\S]*?<\/(?:code|pre)>/gi;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = tagPattern.exec(html)) !== null) {
    // Push the segment before this tag.
    parts.push(
      html.slice(lastIndex, tagMatch.index).replace(FILE_EXTENSIONS, "<code>$1</code>")
    );
    // Push the tag content untouched.
    parts.push(tagMatch[0]);
    lastIndex = tagMatch.index + tagMatch[0].length;
  }

  // Push any remaining content after the last tag.
  parts.push(html.slice(lastIndex).replace(FILE_EXTENSIONS, "<code>$1</code>"));

  return parts.join("");
}

// ---------------------------------------------------------------------------
// chunkMessage
// ---------------------------------------------------------------------------

/** Simple self-closing or void tags that don't need stack tracking. */
const VOID_TAGS = new Set(["br", "hr", "img"]);

interface TagInfo {
  tag: string;
  full: string; // The full opening tag including attributes, e.g. `<a href="...">`
}

/**
 * Parse all open/close tags from an HTML string and return the stack of
 * tags that remain open at the end.
 */
function getOpenTags(html: string): TagInfo[] {
  const stack: TagInfo[] = [];
  const tagRegex = /<\/?([a-z][a-z0-9-]*)[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    const full = match[0];
    const tagName = match[1].toLowerCase();

    if (VOID_TAGS.has(tagName)) continue;

    if (full.startsWith("</")) {
      // Closing tag -- pop the stack if it matches.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tagName) {
          stack.splice(i, 1);
          break;
        }
      }
    } else {
      // Opening tag.
      stack.push({ tag: tagName, full });
    }
  }

  return stack;
}

/**
 * Split a long HTML message into Telegram-safe chunks.
 *
 * - Default max length: 4096 characters (Telegram's limit).
 * - Splits at paragraph boundaries first, then newlines, then hard-cuts.
 * - Preserves open/close tags across chunk boundaries.
 */
export function chunkMessage(html: string, maxLength = 4096): string[] {
  if (html.length <= maxLength) return [html];

  const chunks: string[] = [];
  let remaining = html;
  let openTags: TagInfo[] = [];

  while (remaining.length > 0) {
    // Build the prefix of reopened tags for this chunk.
    const prefix = openTags.map((t) => t.full).join("");
    const budget = maxLength - prefix.length;

    if (budget <= 0) {
      // Extremely unlikely, but safety valve: drop tag context and hard-split.
      chunks.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
      openTags = [];
      continue;
    }

    if (remaining.length <= budget) {
      // Everything fits.
      chunks.push(prefix + remaining);
      break;
    }

    // Find a good split point within our budget.
    let splitAt = -1;
    const candidate = remaining.slice(0, budget);

    // Prefer splitting at a paragraph boundary.
    const paraBreak = candidate.lastIndexOf("\n\n");
    if (paraBreak > 0) {
      splitAt = paraBreak;
    }

    // Fall back to a newline.
    if (splitAt === -1) {
      const lineBreak = candidate.lastIndexOf("\n");
      if (lineBreak > 0) {
        splitAt = lineBreak;
      }
    }

    // Fall back to last space.
    if (splitAt === -1) {
      const spaceBreak = candidate.lastIndexOf(" ");
      if (spaceBreak > 0) {
        splitAt = spaceBreak;
      }
    }

    // Hard-cut as last resort.
    if (splitAt === -1) {
      splitAt = budget;
    }

    const chunkContent = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt).replace(/^\n+/, ""); // trim leading newlines from next chunk

    // Build the chunk with prefix (reopened tags) and suffix (close open tags).
    const fullChunk = prefix + chunkContent;
    const chunkOpenTags = getOpenTags(fullChunk);
    const suffix = chunkOpenTags
      .slice()
      .reverse()
      .map((t) => `</${t.tag}>`)
      .join("");

    chunks.push(fullChunk + suffix);

    // The next chunk must reopen whatever was open at the split point.
    openTags = chunkOpenTags;
  }

  return chunks;
}
