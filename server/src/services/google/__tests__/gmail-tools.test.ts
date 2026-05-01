import { describe, it, expect, vi } from "vitest";
import { htmlToText, looksLikeHtml, pickEmailBody, createGmailToolHandler } from "../gmail-tools.js";
import type { GoogleCalendarProvider } from "../calendar-provider.js";

describe("htmlToText", () => {
  it("returns empty string for empty input", () => {
    expect(htmlToText("")).toBe("");
  });

  it("strips tags and decodes entities", () => {
    const html = "<p>Hello&nbsp;<b>world</b> &amp; friends</p>";
    expect(htmlToText(html)).toBe("Hello world & friends");
  });

  it("preserves paragraphs as separate lines", () => {
    const html = "<p>First paragraph.</p><p>Second paragraph.</p>";
    const text = htmlToText(html);
    expect(text).toContain("First paragraph.");
    expect(text).toContain("Second paragraph.");
    expect(text.indexOf("First")).toBeLessThan(text.indexOf("Second"));
    expect(text.split("\n").filter((l) => l.trim()).length).toBe(2);
  });

  it("renders links in 'text [url]' format", () => {
    const html = '<p>Visit our <a href="https://example.com/sale">summer sale</a> today.</p>';
    const text = htmlToText(html);
    expect(text).toContain("summer sale");
    expect(text).toContain("[https://example.com/sale]");
  });

  it("hides href when link text equals the URL", () => {
    const html = '<a href="https://example.com">https://example.com</a>';
    const text = htmlToText(html);
    expect(text).toBe("https://example.com");
  });

  it("preserves bullet lists with dash markers", () => {
    const html = "<ul><li>Apples</li><li>Oranges</li><li>Pears</li></ul>";
    const text = htmlToText(html);
    expect(text).toMatch(/Apples/);
    expect(text).toMatch(/Oranges/);
    expect(text).toMatch(/Pears/);
    expect(text).toMatch(/[-*]\s+Apples/);
  });

  it("drops <script> and <style> blocks", () => {
    const html = `
      <html>
        <head><style>.foo { color: red; }</style></head>
        <body>
          <script>alert('xss')</script>
          <p>Visible content.</p>
        </body>
      </html>
    `;
    const text = htmlToText(html);
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("alert");
    expect(text).toContain("Visible content.");
  });

  it("drops images entirely (no alt-text noise)", () => {
    const html = '<p>Header</p><img src="data:image/png;base64,AAAA" alt="logo" /><p>Body</p>';
    const text = htmlToText(html);
    expect(text).not.toContain("logo");
    expect(text).not.toContain("data:image");
    expect(text).toContain("Header");
    expect(text).toContain("Body");
  });

  it("collapses excessive blank lines", () => {
    const html = "<p>One</p><br><br><br><br><br><p>Two</p>";
    const text = htmlToText(html);
    expect(text).not.toMatch(/\n{3,}/);
  });

  it("normalizes NBSP (U+00A0) to regular ASCII spaces", () => {
    const html = "<p>Hello&nbsp;there&nbsp;friend</p>";
    const text = htmlToText(html);
    // Output must contain ASCII spaces, not non-breaking spaces.
    expect(text).toBe("Hello there friend");
    expect(text).not.toMatch(/\u00A0/);
  });

  it("preserves heading case (does not uppercase h1)", () => {
    const html = "<h1>Welcome to the Family</h1><p>Body text.</p>";
    const text = htmlToText(html);
    expect(text).toContain("Welcome to the Family");
    expect(text).not.toContain("WELCOME TO THE FAMILY");
  });

  it("preserves heading case across h1-h6", () => {
    const html = `
      <h1>One Heading</h1>
      <h2>Two Heading</h2>
      <h3>Three Heading</h3>
      <h4>Four Heading</h4>
      <h5>Five Heading</h5>
      <h6>Six Heading</h6>
    `;
    const text = htmlToText(html);
    expect(text).toContain("One Heading");
    expect(text).toContain("Two Heading");
    expect(text).toContain("Three Heading");
    expect(text).toContain("Four Heading");
    expect(text).toContain("Five Heading");
    expect(text).toContain("Six Heading");
    // No uppercased duplicates.
    expect(text).not.toContain("ONE HEADING");
  });

  it("flattens layout tables so cells are separated, not concatenated", () => {
    const html = `
      <table>
        <tr><td>Order</td><td>#12345</td></tr>
        <tr><td>Total</td><td>$42.00</td></tr>
      </table>
    `;
    const text = htmlToText(html);
    // Cells must NOT be glued together — there must be whitespace between them.
    expect(text).not.toMatch(/Order#12345/);
    expect(text).not.toMatch(/Total\$42\.00/);
    expect(text).toMatch(/Order\s+#12345/);
    expect(text).toMatch(/Total\s+\$42\.00/);
  });
});

describe("looksLikeHtml", () => {
  it("returns false for empty string", () => {
    expect(looksLikeHtml("")).toBe(false);
  });

  it("returns false for plain text", () => {
    expect(looksLikeHtml("Hello there, this is a normal email body.")).toBe(false);
    expect(looksLikeHtml("Math: 2 < 3 and 5 > 4")).toBe(false);
    expect(looksLikeHtml("Email me at me@example.com")).toBe(false);
  });

  it("detects full HTML documents", () => {
    expect(looksLikeHtml("<html><body><p>hi</p></body></html>")).toBe(true);
  });

  it("detects <!DOCTYPE html> with no <html> wrapper", () => {
    // The original heuristic missed this — only matched on <html>/<body>/etc.
    expect(looksLikeHtml("<!DOCTYPE html><p>Hi there.</p>")).toBe(true);
    expect(looksLikeHtml("<!DOCTYPE html>\nHello world")).toBe(true);
  });

  it("detects HTML comments", () => {
    expect(looksLikeHtml("<!-- generated by Mailchimp -->Some text")).toBe(true);
  });

  it("detects inline-only formatting fragments", () => {
    // The original heuristic missed these.
    expect(looksLikeHtml("Hello <strong>world</strong>")).toBe(true);
    expect(looksLikeHtml("Hello <em>world</em>")).toBe(true);
    expect(looksLikeHtml("Hello <b>world</b>")).toBe(true);
    expect(looksLikeHtml("Hello <i>world</i>")).toBe(true);
    expect(looksLikeHtml("Hello <u>world</u>")).toBe(true);
  });

  it("detects block-level fragments", () => {
    expect(looksLikeHtml("<p>standalone paragraph</p>")).toBe(true);
    expect(looksLikeHtml("<div>standalone div</div>")).toBe(true);
    expect(looksLikeHtml("<table><tr><td>x</td></tr></table>")).toBe(true);
    expect(looksLikeHtml("<blockquote>quoted</blockquote>")).toBe(true);
  });

  it("detects self-closing and attributed tags", () => {
    expect(looksLikeHtml("line1<br/>line2")).toBe(true);
    expect(looksLikeHtml('<a href="https://x.test">link</a>')).toBe(true);
    expect(looksLikeHtml('<img src="x.png" />')).toBe(true);
  });

  it("does not false-positive on angle-bracket-quoted text", () => {
    // Plain text that happens to use angle brackets for emphasis or quoting.
    expect(looksLikeHtml("She said <not really> in a sarcastic tone.")).toBe(false);
    expect(looksLikeHtml("Use <Tab> to indent")).toBe(false);
  });

  it("handles a realistic marketing email", () => {
    const html = `
      <html><body>
        <h1>Big Sale!</h1>
        <p>Our biggest sale of the year is on now.</p>
        <ul>
          <li>50% off shoes</li>
          <li>30% off shirts</li>
        </ul>
        <p>
          <a href="https://shop.example.com/sale">Shop now</a> or
          <a href="https://shop.example.com/unsubscribe?u=123">unsubscribe</a>.
        </p>
      </body></html>
    `;
    const text = htmlToText(html);
    expect(text).toContain("Big Sale!");
    expect(text).toContain("Our biggest sale of the year");
    expect(text).toMatch(/[-*]\s+50% off shoes/);
    expect(text).toMatch(/[-*]\s+30% off shirts/);
    expect(text).toContain("Shop now [https://shop.example.com/sale]");
    expect(text).toContain("unsubscribe [https://shop.example.com/unsubscribe?u=123]");
  });
});

describe("pickEmailBody", () => {
  it("prefers `text` field when both text and html are present", () => {
    const msg = {
      text: "Plain text version.",
      html: "<p>HTML version.</p>",
    };
    const { text, fromHtml } = pickEmailBody(msg);
    expect(text).toBe("Plain text version.");
    expect(fromHtml).toBe(false);
  });

  it("uses `body` field for plain text when text/html are absent", () => {
    const msg = { body: "Hello there." };
    const { text, fromHtml } = pickEmailBody(msg);
    expect(text).toBe("Hello there.");
    expect(fromHtml).toBe(false);
  });

  it("falls back to html when text is empty", () => {
    const msg = {
      text: "   ",
      html: "<p>Only HTML available.</p>",
    };
    const { text, fromHtml } = pickEmailBody(msg);
    expect(text).toContain("Only HTML available.");
    expect(fromHtml).toBe(true);
  });

  it("detects HTML in `body` field and converts it", () => {
    const msg = {
      body: '<html><body><p>HTML in body field.</p><a href="https://x.test">link</a></body></html>',
    };
    const { text, fromHtml } = pickEmailBody(msg);
    expect(text).toContain("HTML in body field.");
    expect(text).toContain("link [https://x.test]");
    expect(fromHtml).toBe(true);
  });

  it("returns empty when no body is available", () => {
    expect(pickEmailBody({})).toEqual({ text: "", fromHtml: false });
    expect(pickEmailBody({ subject: "test" })).toEqual({ text: "", fromHtml: false });
  });

  it("ignores non-string fields", () => {
    // The CLI sometimes returns numeric / null fields for missing parts.
    const msg = { text: null, html: undefined, body: 42 };
    expect(pickEmailBody(msg)).toEqual({ text: "", fromHtml: false });
  });
});

describe("gmail_read handler — re-fetch fallback", () => {
  /** Build a stub provider whose `gws` returns canned stdout for each call. */
  function stubProvider(
    responses: Array<string | (() => string)>,
  ): { provider: GoogleCalendarProvider; calls: string[][] } {
    const calls: string[][] = [];
    let i = 0;
    const provider = {
      gws: vi.fn(async (_member: string, args: string[]) => {
        calls.push(args);
        const r = responses[i++];
        if (typeof r === "function") return r();
        if (r === undefined) throw new Error("no more stub responses");
        return r;
      }),
    } as unknown as GoogleCalendarProvider;
    return { provider, calls };
  }

  it("returns plain body without re-fetch when CLI gives text", async () => {
    const { provider, calls } = stubProvider([
      JSON.stringify({
        from: "x@y.test",
        subject: "Hello",
        date: "2026-04-30",
        text: "This is the plain text body.",
      }),
    ]);
    const handler = createGmailToolHandler(provider, "josh");
    const result = await handler("gmail_read", { id: "abc123" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("This is the plain text body.");
    expect(result.content).not.toContain("HTML email — converted");
    // Only one CLI call — no re-fetch needed.
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("--html");
  });

  it("re-fetches with --html when first call returns no usable body", async () => {
    const { provider, calls } = stubProvider([
      // First call: headers are present but body is empty (HTML-only message
      // where the CLI's default rendering returned nothing).
      JSON.stringify({
        from: "marketing@example.com",
        subject: "Big sale",
        date: "2026-04-30",
        body: "",
      }),
      // Second call (--html): now we get the HTML payload.
      JSON.stringify({
        html: "<html><body><h1>Big Sale!</h1><p>Save 50% today.</p></body></html>",
      }),
    ]);
    const handler = createGmailToolHandler(provider, "josh");
    const result = await handler("gmail_read", { id: "abc123" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("HTML email — converted to text below");
    expect(result.content).toContain("Big Sale!");
    expect(result.content).toContain("Save 50% today.");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--html");
  });

  it("falls back to '(empty …)' if the re-fetch also yields nothing", async () => {
    const { provider, calls } = stubProvider([
      JSON.stringify({ subject: "Empty", body: "" }),
      JSON.stringify({}),
    ]);
    const handler = createGmailToolHandler(provider, "josh");
    const result = await handler("gmail_read", { id: "abc123" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("(empty — could not retrieve message body)");
    expect(calls).toHaveLength(2);
  });

  it("swallows re-fetch errors and reports empty body", async () => {
    const { provider, calls } = stubProvider([
      JSON.stringify({ subject: "Borked", body: "" }),
      () => {
        throw new Error("gws --html exploded");
      },
    ]);
    const handler = createGmailToolHandler(provider, "josh");
    const result = await handler("gmail_read", { id: "abc123" });
    // Re-fetch failure is intentionally swallowed — overall handler still
    // succeeds with an "(empty)" body, not an error.
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("(empty — could not retrieve message body)");
    expect(calls).toHaveLength(2);
  });
});
