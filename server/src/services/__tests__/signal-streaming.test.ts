import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  markdownToSignalText,
  chunkSignalMessage,
  createSignalStream,
} from "../signal-streaming.js";

describe("markdownToSignalText", () => {
  it("strips bold markers", () => {
    expect(markdownToSignalText("**bold** text")).toBe("bold text");
    expect(markdownToSignalText("__also bold__ here")).toBe("also bold here");
  });

  it("strips italic markers", () => {
    expect(markdownToSignalText("*italic* text")).toBe("italic text");
    expect(markdownToSignalText("_also italic_ here")).toBe("also italic here");
  });

  it("strips strikethrough markers", () => {
    expect(markdownToSignalText("~~struck~~ out")).toBe("struck out");
  });

  it("strips inline code backticks while preserving content", () => {
    expect(markdownToSignalText("run `pnpm test` now")).toBe("run pnpm test now");
  });

  it("preserves fenced code block content without fences", () => {
    const input = "before\n```ts\nconst x = 1;\nconst y = 2;\n```\nafter";
    const output = markdownToSignalText(input);
    expect(output).toContain("const x = 1;");
    expect(output).toContain("const y = 2;");
    expect(output).not.toContain("```");
  });

  it("keeps fenced code content verbatim (does not strip markdown inside)", () => {
    // Signal has no formatting, so contents still get processed — but the fence
    // itself must go. Verify that fence markers are removed regardless of language tag.
    const withLang = markdownToSignalText("```python\nprint('hi')\n```");
    const withoutLang = markdownToSignalText("```\nplain\n```");
    expect(withLang).not.toContain("```");
    expect(withoutLang).not.toContain("```");
    expect(withLang).toContain("print('hi')");
    expect(withoutLang).toContain("plain");
  });

  it("drops empty fenced code blocks entirely", () => {
    // Empty fence replaced with "" leaves "before\n\nafter" — the fence markers
    // are gone but the paragraph separation remains. Content of the fence is
    // what matters here, not exact whitespace.
    const result = markdownToSignalText("before\n```\n\n```\nafter");
    expect(result).not.toContain("```");
    expect(result).toContain("before");
    expect(result).toContain("after");
  });

  it("strips ATX headers but keeps header text", () => {
    expect(markdownToSignalText("# Heading 1")).toBe("Heading 1");
    expect(markdownToSignalText("### Heading 3")).toBe("Heading 3");
    expect(markdownToSignalText("###### Heading 6")).toBe("Heading 6");
  });

  it("converts horizontal rules to unicode dash line", () => {
    expect(markdownToSignalText("above\n---\nbelow")).toBe("above\n─────────────\nbelow");
    expect(markdownToSignalText("above\n***\nbelow")).toBe("above\n─────────────\nbelow");
  });

  it("strips blockquote markers", () => {
    expect(markdownToSignalText("> quoted line")).toBe("quoted line");
    expect(markdownToSignalText("> line one\n> line two")).toBe("line one\nline two");
  });

  it("normalizes unordered list markers to bullet", () => {
    expect(markdownToSignalText("- one\n- two")).toBe("• one\n• two");
    expect(markdownToSignalText("* one\n* two")).toBe("• one\n• two");
    expect(markdownToSignalText("+ one\n+ two")).toBe("• one\n• two");
  });

  it("preserves ordered list numbering", () => {
    expect(markdownToSignalText("1. first\n2. second\n10. tenth")).toBe(
      "1. first\n2. second\n10. tenth",
    );
  });

  it("collapses 3+ consecutive newlines to 2", () => {
    expect(markdownToSignalText("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims leading and trailing whitespace", () => {
    expect(markdownToSignalText("   \n\nhello\n\n   ")).toBe("hello");
  });

  it("handles mixed markdown in a realistic LLM response", () => {
    const input = [
      "# Summary",
      "",
      "Here's what I found:",
      "",
      "- **Important:** check `config.json`",
      "- Also review *logs*",
      "",
      "```bash",
      "pnpm test",
      "```",
      "",
      "> Note: this is a blockquote",
    ].join("\n");

    const output = markdownToSignalText(input);

    expect(output).not.toContain("**");
    expect(output).not.toContain("*"); // italic stripped
    expect(output).not.toContain("`");
    expect(output).not.toContain("```");
    expect(output).not.toContain("#");
    expect(output).not.toContain(">");
    expect(output).toContain("Summary");
    expect(output).toContain("Important:");
    expect(output).toContain("config.json");
    expect(output).toContain("• ");
    expect(output).toContain("pnpm test");
    expect(output).toContain("Note: this is a blockquote");
  });

  it("returns empty string for empty input", () => {
    expect(markdownToSignalText("")).toBe("");
    expect(markdownToSignalText("   \n   ")).toBe("");
  });

  it("leaves plain text untouched (aside from trim)", () => {
    expect(markdownToSignalText("Just a normal sentence.")).toBe(
      "Just a normal sentence.",
    );
  });
});

describe("chunkSignalMessage", () => {
  it("returns a single chunk for text under the limit", () => {
    const text = "short message";
    expect(chunkSignalMessage(text)).toEqual([text]);
  });

  it("returns a single chunk for text exactly at the limit", () => {
    const text = "x".repeat(4000);
    const chunks = chunkSignalMessage(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(4000);
  });

  it("splits on paragraph boundaries when possible", () => {
    const para = "x".repeat(2500);
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = chunkSignalMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4000);
    }
  });

  it("preserves paragraph separators within chunks", () => {
    const small = "short para";
    const text = `${small}\n\n${small}\n\n${small}`;
    const chunks = chunkSignalMessage(text, 4000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("\n\n");
  });

  it("hard-splits a paragraph longer than maxChars on word boundary", () => {
    const words = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");
    // words is ~3500 chars, force a 100-char limit to trigger hard-split
    const chunks = chunkSignalMessage(words, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
      // Each chunk should either end mid-word at the limit, or end on a full word.
      // Verify no chunk has leading/trailing whitespace from the split.
      expect(c).toBe(c.trim());
    }
  });

  it("falls back to hard-cut when no word boundary exists within the limit", () => {
    const noSpaces = "x".repeat(300);
    const chunks = chunkSignalMessage(noSpaces, 100);
    expect(chunks).toHaveLength(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
    }
    expect(chunks.join("")).toBe(noSpaces);
  });

  it("filters out empty chunks produced by paragraph splits", () => {
    // Mix real content with empty paragraphs, forced into split mode by a tiny
    // maxChars. Every returned chunk should contain non-whitespace text.
    const text = "alpha\n\n\n\nbeta\n\n\n\ngamma";
    const chunks = chunkSignalMessage(text, 6);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.trim().length).toBeGreaterThan(0);
    }
  });

  it("respects a custom maxChars argument", () => {
    const text = "a".repeat(50);
    const chunks = chunkSignalMessage(text, 20);
    expect(chunks.every((c) => c.length <= 20)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps ordering stable across paragraph splits", () => {
    // Use paragraph markers that are both (a) distinct per paragraph so we can
    // track order, and (b) each paragraph fits under maxChars so none require
    // hard-splitting. That way chunks always preserve paragraph identity.
    const markers = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO"];
    const paragraphs = markers.map((m) => `${m} ${"x".repeat(1500)}`);
    const text = paragraphs.join("\n\n");
    const chunks = chunkSignalMessage(text, 4000);

    expect(chunks.length).toBeGreaterThan(1);

    const rejoined = chunks.join("\n\n");
    for (const m of markers) {
      expect(rejoined).toContain(m);
    }
    // Markers must appear in their original order.
    for (let i = 0; i < markers.length - 1; i++) {
      expect(rejoined.indexOf(markers[i])).toBeLessThan(rejoined.indexOf(markers[i + 1]));
    }
  });
});

describe("createSignalStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("accumulates deltas and sends formatted text once on finish", async () => {
    const sendTyping = vi.fn(async (): Promise<void> => {});
    const onComplete = vi.fn(async (_text: string): Promise<void> => {});
    const stream = createSignalStream(sendTyping, onComplete);

    stream.onDelta("Hello ");
    stream.onDelta("**world**");
    stream.onDelta("!");

    const result = await stream.finish();

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("Hello world!");
    expect(result.text).toBe("Hello **world**!");
  });

  it("strips thinking blocks from accumulated text before sending", async () => {
    const sendTyping = vi.fn(async (): Promise<void> => {});
    const onComplete = vi.fn(async (_text: string): Promise<void> => {});
    const stream = createSignalStream(sendTyping, onComplete);

    stream.onDelta("<thinking>hidden reasoning</thinking>");
    stream.onDelta("visible answer");
    await stream.finish();

    expect(onComplete).toHaveBeenCalledTimes(1);
    const sent = String(onComplete.mock.calls[0]?.[0] ?? "");
    expect(sent).not.toContain("hidden reasoning");
    expect(sent).toContain("visible answer");
  });

  it("starts typing indicator immediately at construction", () => {
    // Changed from the old "start on first delta" behavior: users were
    // seeing 5-15s of dead air before the indicator appeared because Claude
    // in thinking mode produces no text until the end. Starting at
    // construction gives immediate feedback that the message was received.
    const sendTyping = vi.fn(async (): Promise<void> => {});
    const onComplete = vi.fn(async (_text: string): Promise<void> => {});
    createSignalStream(sendTyping, onComplete);

    expect(sendTyping).toHaveBeenCalledTimes(1);
  });

  it("does not re-trigger typing on each delta", () => {
    const sendTyping = vi.fn(async (): Promise<void> => {});
    const onComplete = vi.fn(async (_text: string): Promise<void> => {});
    const stream = createSignalStream(sendTyping, onComplete);

    // One call from construction. Deltas do not add more.
    expect(sendTyping).toHaveBeenCalledTimes(1);
    stream.onDelta("a");
    stream.onDelta("b");
    stream.onDelta("c");
    expect(sendTyping).toHaveBeenCalledTimes(1);
  });

  it("refreshes typing indicator on 4s interval while streaming", () => {
    const sendTyping = vi.fn(async (): Promise<void> => {});
    const onComplete = vi.fn(async (_text: string): Promise<void> => {});
    createSignalStream(sendTyping, onComplete);

    // Immediate call from construction.
    expect(sendTyping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(4_000);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(4_000);
    expect(sendTyping).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(4_000);
    expect(sendTyping).toHaveBeenCalledTimes(4);
  });

  it("stops the typing interval on finish()", async () => {
    const sendTyping = vi.fn(async (): Promise<void> => {});
    const onComplete = vi.fn(async (_text: string): Promise<void> => {});
    const stream = createSignalStream(sendTyping, onComplete);

    stream.onDelta("start");
    vi.advanceTimersByTime(4_000);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    await stream.finish();

    // After finish(), no further typing calls even after long elapsed time.
    vi.advanceTimersByTime(20_000);
    expect(sendTyping).toHaveBeenCalledTimes(2);
  });

  it("ignores deltas that arrive after finish()", async () => {
    const sendTyping = vi.fn(async (): Promise<void> => {});
    const onComplete = vi.fn(async (_text: string): Promise<void> => {});
    const stream = createSignalStream(sendTyping, onComplete);

    stream.onDelta("before finish");
    await stream.finish();

    stream.onDelta("after finish — should be dropped");

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("before finish");
  });

  it("swallows sendTyping errors so they do not abort the stream", async () => {
    const sendTyping = vi.fn(async (): Promise<void> => {
      throw new Error("signal typing endpoint down");
    });
    const onComplete = vi.fn(async (_text: string): Promise<void> => {});
    const stream = createSignalStream(sendTyping, onComplete);

    // Must not throw even though sendTyping rejects.
    stream.onDelta("first");
    stream.onDelta("second");
    await vi.advanceTimersByTimeAsync(4_000);

    // finish() must still send the accumulated text normally.
    await expect(stream.finish()).resolves.toEqual({ text: "firstsecond" });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("firstsecond");
  });

  it("does not call onComplete when the accumulated text is empty", async () => {
    const sendTyping = vi.fn(async (): Promise<void> => {});
    const onComplete = vi.fn(async (_text: string): Promise<void> => {});
    const stream = createSignalStream(sendTyping, onComplete);

    // No deltas before finish.
    const result = await stream.finish();

    expect(onComplete).not.toHaveBeenCalled();
    expect(result.text).toBe("");
  });

  it("does not call onComplete when only thinking blocks were accumulated", async () => {
    const sendTyping = vi.fn(async (): Promise<void> => {});
    const onComplete = vi.fn(async (_text: string): Promise<void> => {});
    const stream = createSignalStream(sendTyping, onComplete);

    stream.onDelta("<thinking>just reasoning, no answer</thinking>");
    await stream.finish();

    expect(onComplete).not.toHaveBeenCalled();
  });

  it("catches onComplete errors so finish() still resolves", async () => {
    const sendTyping = vi.fn(async (): Promise<void> => {});
    const onComplete = vi.fn(async (_text: string): Promise<void> => {
      throw new Error("signal send failed");
    });
    const stream = createSignalStream(sendTyping, onComplete);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    stream.onDelta("hello");

    await expect(stream.finish()).resolves.toEqual({ text: "hello" });
    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorLogCall = consoleErrorSpy.mock.calls[0] ?? [];
    expect(String(errorLogCall[0] ?? "")).toContain("Failed to deliver");
  });

  it("returns raw accumulated text in result, not the formatted version", async () => {
    const sendTyping = vi.fn(async (): Promise<void> => {});
    const onComplete = vi.fn(async (_text: string): Promise<void> => {});
    const stream = createSignalStream(sendTyping, onComplete);

    stream.onDelta("**bold** text");
    const result = await stream.finish();

    // The formatted version (markdown stripped) went to onComplete.
    expect(onComplete).toHaveBeenCalledWith("bold text");
    // The raw accumulated version is returned — callers that want to log the
    // model output can see what was actually produced.
    expect(result.text).toBe("**bold** text");
  });
});
