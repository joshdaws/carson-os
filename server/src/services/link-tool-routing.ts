/**
 * Link → tool routing hints.
 *
 * Some content lives behind sources that generic WebSearch/WebFetch can't read
 * reliably. X/Twitter is the canonical example: the public web view is
 * JS-rendered and login-walled, so an agent that reaches for WebSearch when a
 * user pastes an `x.com/.../status/...` link either fails or — worse —
 * hallucinates a summary.
 *
 * The household may have a dedicated tool for this (e.g. `x_get_post`, backed
 * by a live X data API). The model sees that tool in its tool list, but with
 * dozens of tools available and WebSearch advertised prominently in its
 * capabilities, it doesn't reliably connect "X link" → "use the X tool".
 *
 * This module closes that gap deterministically: when the user's message
 * contains an X/Twitter post link, we inject a per-turn steering note that
 * either (a) names the exact household tool to use, or (b) — if no such tool is
 * available — tells the agent not to guess or invent the post's contents.
 *
 * Pure functions, no DB or network. Wired into the chat turn in
 * constitution-engine.
 */

import type { ToolDefinition } from "@carsonos/shared";

/**
 * Match X/Twitter status URLs. Covers x.com, twitter.com, mobile.twitter.com,
 * fxtwitter/vxtwitter mirrors, and optional `www.`/subdomains, with the
 * `/<handle>/status/<id>` shape. Query strings (`?s=46`) are tolerated.
 */
const X_POST_URL_RE =
  /https?:\/\/(?:[a-z0-9-]+\.)*(?:x|twitter|fxtwitter|vxtwitter|nitter|fixupx)\.com\/[A-Za-z0-9_]+\/status(?:es)?\/\d+(?:[/?#]\S*)?/gi;

/**
 * Extract distinct X/Twitter post URLs from a block of text.
 * Trailing punctuation that commonly hugs pasted links is trimmed.
 */
export function detectXPostUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(X_POST_URL_RE) ?? [];
  const cleaned = matches.map((m) => m.replace(/[)\]}>.,;'"]+$/, ""));
  return Array.from(new Set(cleaned));
}

/** Does this message reference at least one X/Twitter post? */
export function hasXPostLink(text: string): boolean {
  return detectXPostUrls(text).length > 0;
}

/**
 * Find the best available tool for reading a *specific* X/Twitter post by URL.
 *
 * Preference order:
 *   1. A tool that takes a `url` input and references X/Twitter posts — the
 *      shape `x_get_post` has. Best fit for "read this exact link".
 *   2. Any tool whose name/description references reading an X/Twitter
 *      post/tweet/thread (fallback when the schema is opaque).
 *
 * Search tools (query-based, e.g. `x_search_posts`) are intentionally NOT
 * matched — they answer "find posts about X", not "read this link".
 *
 * Returns the tool's callable name (what the model invokes), or null.
 */
export function findXPostTool(tools: ToolDefinition[]): string | null {
  if (!tools || tools.length === 0) return null;

  const candidates = tools.filter(isXReadingTool);
  if (candidates.length === 0) return null;

  // Prefer a tool that accepts a `url` input — that's the "fetch this exact
  // post" shape, not a keyword search.
  const withUrl = candidates.find(hasUrlInput);
  return (withUrl ?? candidates[0]).name;
}

function isXReadingTool(tool: ToolDefinition): boolean {
  const name = (tool.name ?? "").toLowerCase();
  const desc = (tool.description ?? "").toLowerCase();

  // Exclude obvious search/keyword tools — they don't read a specific link.
  if (/search/.test(name)) return false;

  const haystack = `${name} ${desc}`;
  const mentionsX = /\b(x|twitter)\b|x\/twitter|tweet/.test(haystack);
  if (!mentionsX) return false;

  const mentionsPost = /\b(post|posts|tweet|tweets|thread|status)\b/.test(haystack);
  const mentionsRead = /\b(get|read|fetch|load|view|open|retrieve)\b/.test(haystack);

  // Strongest signal: the canonical name. Otherwise require both an X/Twitter
  // reference AND a read+post intent so we don't grab unrelated tools.
  return name === "x_get_post" || (mentionsPost && mentionsRead);
}

function hasUrlInput(tool: ToolDefinition): boolean {
  const schema = tool.input_schema as
    | { properties?: Record<string, unknown> }
    | undefined;
  const props = schema?.properties;
  if (!props || typeof props !== "object") return false;
  return Object.keys(props).some((k) => /url|link/i.test(k));
}

/**
 * Build a per-turn steering note for a message containing X/Twitter link(s).
 *
 * Returns null when the message has no X link (the common case) so callers can
 * skip injection entirely.
 *
 * Two outcomes:
 *   - Tool available  → name it and forbid WebSearch / fabrication.
 *   - No tool         → forbid guessing; tell the agent to be honest about the
 *                       limitation rather than inventing a summary.
 */
export function buildXLinkSteering(
  message: string,
  tools: ToolDefinition[],
): string | null {
  const urls = detectXPostUrls(message);
  if (urls.length === 0) return null;

  const urlList = urls.map((u) => `- ${u}`).join("\n");
  const toolName = findXPostTool(tools);

  if (toolName) {
    return [
      "<system-reminder>",
      `The user's message contains X/Twitter post link(s):`,
      urlList,
      "",
      `Use the \`${toolName}\` tool to fetch the actual post content before you respond.`,
      "Do NOT use web search or web fetch for X/Twitter links — they cannot read",
      "X/Twitter reliably. Do NOT summarize, paraphrase, or guess the post from",
      `memory or prior knowledge. Call \`${toolName}\` with the URL, then answer`,
      "from what it returns. If the tool errors, say so plainly instead of guessing.",
      "</system-reminder>",
    ].join("\n");
  }

  return [
    "<system-reminder>",
    "The user's message contains X/Twitter post link(s):",
    urlList,
    "",
    "You do not have a tool that can read X/Twitter posts, and web search cannot",
    "read them reliably. Do NOT guess, summarize, or invent the post's contents.",
    "Tell the user you can't open the link directly and ask them to paste the text",
    "if they'd like you to help with it.",
    "</system-reminder>",
  ].join("\n");
}

/**
 * Append a steering note to the last user message in a turn array, returning a
 * new array. No-op (returns the same array) when the note is null/empty or
 * there is no user message to attach to.
 */
export function appendSteeringToLastUserMessage<
  T extends { role: string; content: string },
>(messages: T[], note: string | null): T[] {
  if (!note) return messages;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return messages;
  const copy = messages.slice();
  copy[lastUserIdx] = {
    ...copy[lastUserIdx],
    content: `${copy[lastUserIdx].content}\n\n${note}`,
  };
  return copy;
}
