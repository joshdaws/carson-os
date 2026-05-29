import { describe, it, expect } from "vitest";
import type { ToolDefinition } from "@carsonos/shared";
import {
  detectXPostUrls,
  hasXPostLink,
  findXPostTool,
  buildXLinkSteering,
  appendSteeringToLastUserMessage,
} from "../link-tool-routing.js";

// The real household tool that prompted this fix.
const xGetPost: ToolDefinition = {
  name: "x_get_post",
  description:
    "Fetch a specific X/Twitter post and its thread by URL using Grok's live x_search tool",
  input_schema: {
    type: "object",
    properties: { url: { type: "string", description: "Full X/Twitter post URL" } },
    required: ["url"],
  },
};

const xSearchPosts: ToolDefinition = {
  name: "x_search_posts",
  description: "Search recent X/Twitter posts by keyword query",
  input_schema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

const unrelatedTool: ToolDefinition = {
  name: "list_calendar_events",
  description: "List upcoming calendar events",
  input_schema: { type: "object", properties: {} },
};

describe("detectXPostUrls", () => {
  it("detects the exact URL Josh sent (x.com with ?s= query)", () => {
    const urls = detectXPostUrls(
      "check this out https://x.com/pbakaus/status/2060208540992880794?s=46",
    );
    expect(urls).toEqual([
      "https://x.com/pbakaus/status/2060208540992880794?s=46",
    ]);
  });

  it("detects twitter.com, mobile, and www variants", () => {
    expect(detectXPostUrls("https://twitter.com/jack/status/20")).toEqual([
      "https://twitter.com/jack/status/20",
    ]);
    expect(
      detectXPostUrls("https://mobile.twitter.com/jack/status/20"),
    ).toEqual(["https://mobile.twitter.com/jack/status/20"]);
    expect(detectXPostUrls("https://www.x.com/jack/status/20")).toEqual([
      "https://www.x.com/jack/status/20",
    ]);
  });

  it("detects fxtwitter / vxtwitter mirrors", () => {
    expect(
      detectXPostUrls("https://fxtwitter.com/user/status/12345"),
    ).toEqual(["https://fxtwitter.com/user/status/12345"]);
    expect(
      detectXPostUrls("https://vxtwitter.com/user/status/12345"),
    ).toEqual(["https://vxtwitter.com/user/status/12345"]);
  });

  it("trims trailing punctuation hugging a pasted link", () => {
    expect(
      detectXPostUrls("see (https://x.com/a/status/99)."),
    ).toEqual(["https://x.com/a/status/99"]);
  });

  it("dedupes repeated links", () => {
    const text =
      "https://x.com/a/status/1 and again https://x.com/a/status/1";
    expect(detectXPostUrls(text)).toEqual(["https://x.com/a/status/1"]);
  });

  it("returns nothing for profile links or non-X URLs", () => {
    expect(detectXPostUrls("https://x.com/pbakaus")).toEqual([]);
    expect(detectXPostUrls("https://example.com/a/status/1")).toEqual([]);
    expect(detectXPostUrls("just some text")).toEqual([]);
    expect(detectXPostUrls("")).toEqual([]);
  });

  it("hasXPostLink mirrors detection", () => {
    expect(hasXPostLink("https://x.com/a/status/1")).toBe(true);
    expect(hasXPostLink("no link here")).toBe(false);
  });
});

describe("findXPostTool", () => {
  it("picks x_get_post over x_search_posts", () => {
    expect(findXPostTool([xSearchPosts, xGetPost])).toBe("x_get_post");
  });

  it("ignores search-only X tools", () => {
    expect(findXPostTool([xSearchPosts])).toBeNull();
  });

  it("returns null when no X reading tool is present", () => {
    expect(findXPostTool([unrelatedTool])).toBeNull();
    expect(findXPostTool([])).toBeNull();
  });

  it("matches a generically-named tool that reads X posts by url", () => {
    const generic: ToolDefinition = {
      name: "fetch_tweet",
      description: "Read a tweet from Twitter given its url",
      input_schema: { type: "object", properties: { url: { type: "string" } } },
    };
    expect(findXPostTool([generic])).toBe("fetch_tweet");
  });

  it("prefers the url-input tool when multiple X readers exist", () => {
    const noUrl: ToolDefinition = {
      name: "x_read_latest",
      description: "Read the latest X post from an author",
      input_schema: { type: "object", properties: { handle: { type: "string" } } },
    };
    expect(findXPostTool([noUrl, xGetPost])).toBe("x_get_post");
  });
});

describe("buildXLinkSteering", () => {
  it("returns null when there is no X link", () => {
    expect(buildXLinkSteering("hello there", [xGetPost])).toBeNull();
  });

  it("names the tool and forbids web search when the tool is available", () => {
    const note = buildXLinkSteering(
      "read https://x.com/pbakaus/status/2060208540992880794?s=46",
      [xGetPost, unrelatedTool],
    );
    expect(note).not.toBeNull();
    expect(note).toContain("x_get_post");
    expect(note).toContain("https://x.com/pbakaus/status/2060208540992880794?s=46");
    expect(note!.toLowerCase()).toContain("do not use web search");
    expect(note!.toLowerCase()).toContain("do not summarize");
  });

  it("forbids guessing when no X tool is available", () => {
    const note = buildXLinkSteering(
      "read https://x.com/a/status/1",
      [unrelatedTool],
    );
    expect(note).not.toBeNull();
    expect(note).not.toContain("x_get_post");
    expect(note!.toLowerCase()).toContain("do not guess");
    expect(note!.toLowerCase()).toContain("can't open the link");
  });
});

describe("appendSteeringToLastUserMessage", () => {
  it("appends to the last user message, leaving others untouched", () => {
    const msgs = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "https://x.com/a/status/1" },
    ];
    const note = buildXLinkSteering(msgs[2].content, [xGetPost]);
    const out = appendSteeringToLastUserMessage(msgs, note);
    expect(out[0].content).toBe("first");
    expect(out[1].content).toBe("reply");
    expect(out[2].content).toContain("https://x.com/a/status/1");
    expect(out[2].content).toContain("x_get_post");
  });

  it("is a no-op when the note is null", () => {
    const msgs = [{ role: "user", content: "hi" }];
    expect(appendSteeringToLastUserMessage(msgs, null)).toBe(msgs);
  });

  it("does not mutate the input array", () => {
    const msgs = [{ role: "user", content: "https://x.com/a/status/1" }];
    const out = appendSteeringToLastUserMessage(msgs, "NOTE");
    expect(msgs[0].content).toBe("https://x.com/a/status/1");
    expect(out[0].content).toContain("NOTE");
  });

  it("returns the array unchanged when there is no user message", () => {
    const msgs = [{ role: "assistant", content: "only assistant" }];
    expect(appendSteeringToLastUserMessage(msgs, "NOTE")).toBe(msgs);
  });
});
