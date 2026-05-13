import { describe, it, expect, vi } from "vitest";
import {
  htmlToText,
  looksLikeHtml,
  pickEmailBody,
  createGmailToolHandler,
  formatAddress,
  decodeBase64Url,
  collectPayloadBodies,
  readPayloadHeader,
} from "../gmail-tools.js";
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

  // ── `gws +read` helper shape ─────────────────────────────────────
  //
  // This is the shape `gmail_read` actually receives in production. PR #70
  // shipped a `payload.parts[]` walker but missed that the higher-level
  // `gws gmail +read --format json` helper decodes the body itself and
  // exposes it as `body_text` / `body_html`. These regressions exercise
  // exactly that shape.
  describe("gws +read helper shape (body_text / body_html)", () => {
    it("uses body_text when present (real gws +read shape)", () => {
      const msg = {
        thread_id: "abc",
        message_id: "xyz",
        from: { name: "Miranda Larsen", email: "mlarsen@blazemedia.com" },
        to: [{ name: "Josh", email: "josh@example.com" }],
        subject: "IT opportunity | Blaze Media | Follow up",
        date: "Tue, 12 May 2026 21:12:14 +0000",
        body_text: "Hi Josh,\r\n\r\nI am reaching out from the recruiting team...",
        body_html: "<html><body>Hi Josh,</body></html>",
      };
      const { text, fromHtml } = pickEmailBody(msg);
      expect(text).toContain("Hi Josh");
      expect(text).toContain("recruiting team");
      expect(fromHtml).toBe(false);
    });

    it("prefers body_text over body_html when both are present", () => {
      const msg = {
        body_text: "Plain version.",
        body_html: "<p>HTML version.</p>",
      };
      const { text, fromHtml } = pickEmailBody(msg);
      expect(text).toBe("Plain version.");
      expect(fromHtml).toBe(false);
    });

    it("falls back to body_html when body_text is empty/whitespace", () => {
      const msg = {
        body_text: "   ",
        body_html: '<p>HTML only <a href="https://x.test">link</a>.</p>',
      };
      const { text, fromHtml } = pickEmailBody(msg);
      expect(text).toContain("HTML only");
      expect(text).toContain("[https://x.test]");
      expect(fromHtml).toBe(true);
    });

    it("falls back to body_html when body_text is missing", () => {
      const msg = { body_html: "<p>HTML body only.</p>" };
      const { text, fromHtml } = pickEmailBody(msg);
      expect(text).toContain("HTML body only.");
      expect(fromHtml).toBe(true);
    });

    it("ignores non-string body_text/body_html values", () => {
      expect(pickEmailBody({ body_text: null, body_html: 42 })).toEqual({
        text: "",
        fromHtml: false,
      });
    });

    it("body_text takes precedence over payload.parts[] walking", () => {
      // If both shapes are somehow present, the pre-decoded helper output is
      // canonical — fall through to payload.parts only when it's missing.
      const msg = {
        body_text: "helper decoded body",
        payload: {
          parts: [
            {
              mimeType: "text/plain",
              body: { data: Buffer.from("payload body", "utf8").toString("base64url") },
            },
          ],
        },
      };
      const { text } = pickEmailBody(msg);
      expect(text).toBe("helper decoded body");
    });
  });
});

describe("formatAddress", () => {
  it("returns empty string for nullish input", () => {
    expect(formatAddress(null)).toBe("");
    expect(formatAddress(undefined)).toBe("");
  });

  it("passes through raw RFC 5322 strings", () => {
    expect(formatAddress("Bob Smith <bob@example.com>")).toBe(
      "Bob Smith <bob@example.com>",
    );
    expect(formatAddress("bob@example.com")).toBe("bob@example.com");
  });

  it("renders { name, email } as 'Name <email>'", () => {
    expect(formatAddress({ name: "Bob Smith", email: "bob@example.com" })).toBe(
      "Bob Smith <bob@example.com>",
    );
  });

  it("falls back to email-only when name is missing", () => {
    expect(formatAddress({ email: "bob@example.com" })).toBe("bob@example.com");
    expect(formatAddress({ name: "", email: "bob@example.com" })).toBe(
      "bob@example.com",
    );
  });

  it("falls back to name-only when email is missing", () => {
    expect(formatAddress({ name: "Bob Smith" })).toBe("Bob Smith");
  });

  it("accepts `address` as an alias for `email`", () => {
    expect(formatAddress({ name: "Bob", address: "bob@example.com" })).toBe(
      "Bob <bob@example.com>",
    );
  });

  it("joins arrays with comma separation", () => {
    expect(
      formatAddress([
        { name: "Bob", email: "bob@example.com" },
        { name: "Carol", email: "carol@example.com" },
      ]),
    ).toBe("Bob <bob@example.com>, Carol <carol@example.com>");
  });

  it("never returns '[object Object]'", () => {
    // The original bug — string interpolation gave this for object inputs.
    expect(formatAddress({ name: "Bob", email: "bob@example.com" })).not.toContain(
      "[object Object]",
    );
    expect(formatAddress([{ email: "bob@example.com" }])).not.toContain(
      "[object Object]",
    );
  });

  it("skips empty entries when joining arrays", () => {
    expect(formatAddress([{ email: "bob@example.com" }, null, { name: "" }])).toBe(
      "bob@example.com",
    );
  });
});

describe("decodeBase64Url", () => {
  it("decodes standard base64url content", () => {
    // "Hello, world!" → base64url
    expect(decodeBase64Url("SGVsbG8sIHdvcmxkIQ")).toBe("Hello, world!");
  });

  it("decodes content using `-` and `_` in place of `+` and `/`", () => {
    // The bytes 0xFB 0xEF 0xFF encode as `++//` in base64 and `--__` in base64url.
    const original = Buffer.from([0xfb, 0xef, 0xff]).toString("utf8");
    expect(decodeBase64Url("--__")).toBe(original);
  });

  it("handles missing padding", () => {
    expect(decodeBase64Url("SGk")).toBe("Hi"); // standard would be "SGk="
  });

  it("returns empty string for empty input", () => {
    expect(decodeBase64Url("")).toBe("");
  });

  it("returns empty string for non-base64url input rather than garbled text", () => {
    // `Buffer.from(..., "base64")` silently strips invalid chars and produces
    // mojibake; we want a clean empty string instead.
    expect(decodeBase64Url("not valid base64!@#")).toBe("");
    expect(decodeBase64Url("plain english sentence")).toBe("");
    expect(decodeBase64Url("contains\nnewlines")).toBe("");
  });

  it("accepts trailing `=` padding", () => {
    expect(decodeBase64Url("SGVsbG8=")).toBe("Hello");
    expect(decodeBase64Url("SGk=")).toBe("Hi");
  });
});

describe("collectPayloadBodies", () => {
  function b64(s: string): string {
    return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  }

  it("returns empty bodies for non-payload input", () => {
    expect(collectPayloadBodies(null)).toEqual({ plain: "", html: "" });
    expect(collectPayloadBodies(undefined)).toEqual({ plain: "", html: "" });
    expect(collectPayloadBodies("not-an-object")).toEqual({ plain: "", html: "" });
  });

  it("decodes a flat single-part text/plain payload", () => {
    const payload = {
      mimeType: "text/plain",
      body: { data: b64("Hello there.") },
    };
    expect(collectPayloadBodies(payload)).toEqual({
      plain: "Hello there.",
      html: "",
    });
  });

  it("walks multipart/alternative and keeps both plain and html", () => {
    const payload = {
      mimeType: "multipart/alternative",
      body: { size: 0 },
      parts: [
        { mimeType: "text/plain", body: { data: b64("Plain version") } },
        { mimeType: "text/html", body: { data: b64("<p>HTML version</p>") } },
      ],
    };
    expect(collectPayloadBodies(payload)).toEqual({
      plain: "Plain version",
      html: "<p>HTML version</p>",
    });
  });

  it("recurses into nested multipart parts", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64("Nested plain") } },
            { mimeType: "text/html", body: { data: b64("<p>Nested html</p>") } },
          ],
        },
        // Attachment part — has data but a non-text mimeType. Ignored.
        {
          mimeType: "application/pdf",
          body: { data: b64("fake-pdf-bytes") },
        },
      ],
    };
    expect(collectPayloadBodies(payload)).toEqual({
      plain: "Nested plain",
      html: "<p>Nested html</p>",
    });
  });

  it("ignores attachment parts", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: b64("Body") } },
        { mimeType: "image/png", body: { data: b64("PNG-BYTES") } },
      ],
    };
    expect(collectPayloadBodies(payload).plain).toBe("Body");
    expect(collectPayloadBodies(payload).html).toBe("");
  });

  it("ignores text/plain parts marked Content-Disposition: attachment", () => {
    // The bug: an attachment ordered BEFORE the real body would shadow it
    // because both are mimeType text/plain.
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/plain",
          filename: "notes.txt",
          headers: [
            { name: "Content-Disposition", value: 'attachment; filename="notes.txt"' },
          ],
          body: { data: b64("ATTACHED FILE CONTENT — should not win") },
        },
        {
          mimeType: "text/plain",
          body: { data: b64("Real body text.") },
        },
      ],
    };
    expect(collectPayloadBodies(payload)).toEqual({
      plain: "Real body text.",
      html: "",
    });
  });

  it("ignores text/plain attachments detected by filename alone (no header)", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/plain",
          filename: "log.txt",
          body: { data: b64("log content") },
        },
        {
          mimeType: "text/plain",
          body: { data: b64("Body") },
        },
      ],
    };
    expect(collectPayloadBodies(payload).plain).toBe("Body");
  });

  it("matches text/plain even with charset parameter", () => {
    const payload = {
      mimeType: "text/plain; charset=utf-8",
      body: { data: b64("Charset-tagged body") },
    };
    expect(collectPayloadBodies(payload)).toEqual({
      plain: "Charset-tagged body",
      html: "",
    });
  });

  it("matches text/html with charset parameter", () => {
    const payload = {
      mimeType: "text/html; charset=ISO-8859-1",
      body: { data: b64("<p>Charset-tagged html</p>") },
    };
    expect(collectPayloadBodies(payload)).toEqual({
      plain: "",
      html: "<p>Charset-tagged html</p>",
    });
  });

  it("caps recursion depth (pathological deeply-nested payload)", () => {
    // Build a part nested 25 levels deep with text at the leaf. Past depth 10
    // the walker should bail rather than blow the stack or chew CPU.
    let leaf: Record<string, unknown> = {
      mimeType: "text/plain",
      body: { data: b64("buried treasure") },
    };
    for (let i = 0; i < 25; i++) {
      leaf = { mimeType: "multipart/mixed", parts: [leaf] };
    }
    // Should not throw and should not find the leaf body.
    const result = collectPayloadBodies(leaf);
    expect(result.plain).toBe("");
    expect(result.html).toBe("");
  });

  it("still reaches a leaf within the depth cap (sanity)", () => {
    // 5 levels of nesting — well under the cap, body should be found.
    let leaf: Record<string, unknown> = {
      mimeType: "text/plain",
      body: { data: b64("found me") },
    };
    for (let i = 0; i < 5; i++) {
      leaf = { mimeType: "multipart/mixed", parts: [leaf] };
    }
    expect(collectPayloadBodies(leaf).plain).toBe("found me");
  });
});

describe("readPayloadHeader", () => {
  it("returns empty string when payload is missing or shaped wrong", () => {
    expect(readPayloadHeader(null, "From")).toBe("");
    expect(readPayloadHeader(undefined, "From")).toBe("");
    expect(readPayloadHeader({}, "From")).toBe("");
    expect(readPayloadHeader({ headers: "not-an-array" }, "From")).toBe("");
  });

  it("reads a header value (case-insensitive on name)", () => {
    const payload = {
      headers: [
        { name: "From", value: "Bob <bob@example.com>" },
        { name: "To", value: "josh@example.com" },
        { name: "Subject", value: "Hi" },
      ],
    };
    expect(readPayloadHeader(payload, "From")).toBe("Bob <bob@example.com>");
    expect(readPayloadHeader(payload, "from")).toBe("Bob <bob@example.com>");
    expect(readPayloadHeader(payload, "TO")).toBe("josh@example.com");
    expect(readPayloadHeader(payload, "Subject")).toBe("Hi");
  });

  it("returns empty string when header is absent", () => {
    const payload = { headers: [{ name: "From", value: "x@y.test" }] };
    expect(readPayloadHeader(payload, "Cc")).toBe("");
  });
});

describe("pickEmailBody — Gmail API native payload shape", () => {
  function b64(s: string): string {
    return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  }

  it("extracts text from payload.parts when top-level fields are missing", () => {
    const msg = {
      subject: "Hi",
      payload: {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64("Real body content.") } },
          { mimeType: "text/html", body: { data: b64("<p>Real body content.</p>") } },
        ],
      },
    };
    const { text, fromHtml } = pickEmailBody(msg);
    expect(text).toBe("Real body content.");
    expect(fromHtml).toBe(false);
  });

  it("falls back to text/html part when plain is absent in payload", () => {
    const msg = {
      payload: {
        mimeType: "text/html",
        body: { data: b64("<h1>Marketing</h1><p>Buy now.</p>") },
      },
    };
    const { text, fromHtml } = pickEmailBody(msg);
    expect(text).toContain("Marketing");
    expect(text).toContain("Buy now.");
    expect(fromHtml).toBe(true);
  });

  it("uses Gmail snippet as last-resort fallback", () => {
    const msg = {
      subject: "Bare",
      snippet: "Short preview from Gmail API.",
    };
    const { text, fromHtml } = pickEmailBody(msg);
    expect(text).toBe("Short preview from Gmail API.");
    expect(fromHtml).toBe(false);
  });

  it("prefers top-level text over payload parts when both present", () => {
    const msg = {
      text: "Top-level plain.",
      payload: {
        parts: [{ mimeType: "text/plain", body: { data: b64("Payload plain.") } }],
      },
    };
    expect(pickEmailBody(msg)).toEqual({
      text: "Top-level plain.",
      fromHtml: false,
    });
  });

  it("prefers payload plain over snippet", () => {
    const msg = {
      snippet: "snippet preview",
      payload: {
        parts: [{ mimeType: "text/plain", body: { data: b64("full body") } }],
      },
    };
    expect(pickEmailBody(msg).text).toBe("full body");
  });
});

describe("gmail_read handler — From/To rendering", () => {
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

  it("renders object-shaped from/to as 'Name <email>', not [object Object]", async () => {
    const { provider } = stubProvider([
      JSON.stringify({
        from: { name: "Tyler Coach", email: "tyler@example.com" },
        to: { name: "Josh Daws", email: "josh@example.com" },
        subject: "Saturday game",
        date: "2026-05-13",
        text: "See you at 9am.",
      }),
    ]);
    const handler = createGmailToolHandler(provider, "josh");
    const result = await handler("gmail_read", { id: "abc123" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("From: Tyler Coach <tyler@example.com>");
    expect(result.content).toContain("To: Josh Daws <josh@example.com>");
    expect(result.content).not.toContain("[object Object]");
  });

  it("renders array-of-recipients To header", async () => {
    const { provider } = stubProvider([
      JSON.stringify({
        from: { email: "boss@example.com" },
        to: [
          { name: "Alice", email: "alice@example.com" },
          { name: "Bob", email: "bob@example.com" },
        ],
        subject: "Team update",
        text: "Body.",
      }),
    ]);
    const handler = createGmailToolHandler(provider, "josh");
    const result = await handler("gmail_read", { id: "abc123" });
    expect(result.content).toContain("To: Alice <alice@example.com>, Bob <bob@example.com>");
  });

  it("still handles raw RFC 5322 string headers", async () => {
    const { provider } = stubProvider([
      JSON.stringify({
        from: "Tyler <tyler@example.com>",
        to: "josh@example.com",
        subject: "Old shape",
        text: "Body.",
      }),
    ]);
    const handler = createGmailToolHandler(provider, "josh");
    const result = await handler("gmail_read", { id: "abc123" });
    expect(result.content).toContain("From: Tyler <tyler@example.com>");
    expect(result.content).toContain("To: josh@example.com");
  });

  it("falls back to payload.headers[] when top-level header fields are missing", async () => {
    // Pure Gmail API payload shape: From/To/Subject/Date live only inside
    // payload.headers[]. The `gws` CLI used to flatten these onto the top
    // level; if it stops, gmail_read must still render them.
    const b64 = (s: string) =>
      Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    const { provider } = stubProvider([
      JSON.stringify({
        id: "abc",
        payload: {
          headers: [
            { name: "From", value: "Tyler <tyler@example.com>" },
            { name: "To", value: "josh@example.com" },
            { name: "Cc", value: "coach@example.com" },
            { name: "Subject", value: "Saturday game" },
            { name: "Date", value: "Mon, 13 May 2026 10:00:00 -0700" },
          ],
          mimeType: "text/plain",
          body: { data: b64("See you at 9am.") },
        },
      }),
    ]);
    const handler = createGmailToolHandler(provider, "josh");
    const result = await handler("gmail_read", { id: "abc" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("From: Tyler <tyler@example.com>");
    expect(result.content).toContain("To: josh@example.com");
    expect(result.content).toContain("Cc: coach@example.com");
    expect(result.content).toContain("Subject: Saturday game");
    expect(result.content).toContain("Date: Mon, 13 May 2026 10:00:00 -0700");
    expect(result.content).toContain("See you at 9am.");
  });

  // Regression: PR #70 added a payload.parts[] walker but missed the
  // higher-level `gws gmail +read` helper shape (snake_case body_text /
  // body_html, thread_id, from/to as { name, email } objects). That's what
  // gmail_read actually receives in production — the Miranda Larsen email
  // from Blaze Media (msg id 19e1e08c28e6bef0, sent 2026-05-12) reproduces
  // it exactly. The body was coming back as "(empty)" even though the body
  // text was right there in `body_text`.
  it("reads body_text from real `gws +read` helper response (Miranda Larsen regression)", async () => {
    const { provider, calls } = stubProvider([
      JSON.stringify({
        thread_id: "19e1e08c28e6bef0",
        message_id:
          "CYXP220MB11280737209AF5DDF037B77BCB392@CYXP220MB1128.NAMP220.PROD.OUTLOOK.COM",
        references: [],
        from: { name: "Miranda Larsen", email: "mlarsen@blazemedia.com" },
        reply_to: null,
        to: [{ name: "jdaws47@gmail.com", email: "jdaws47@gmail.com" }],
        cc: null,
        subject: "IT opportunity | Blaze Media | Follow up",
        date: "Tue, 12 May 2026 21:12:14 +0000",
        body_text:
          "Hi Josh,\r\n\r\nI am reaching out from the recruiting team at Blaze to connect as things continue to take shape on our end following conversations with Tyler recently.\r\n\r\nGiven the scope of what Blaze is looking to build, I'd love to spend some time with you this week...\r\n\r\nBest,\r\nMiranda",
        body_html: "<html><body>Hi Josh,</body></html>",
      }),
    ]);
    const handler = createGmailToolHandler(provider, "josh");
    const result = await handler("gmail_read", { id: "19e1e08c28e6bef0" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("From: Miranda Larsen <mlarsen@blazemedia.com>");
    expect(result.content).toContain(
      "Subject: IT opportunity | Blaze Media | Follow up",
    );
    // The critical assertion: real body text actually appears in the output.
    expect(result.content).toContain("Hi Josh");
    expect(result.content).toContain("recruiting team at Blaze");
    expect(result.content).toContain("Best,");
    expect(result.content).toContain("Miranda");
    expect(result.content).not.toContain("(empty — could not retrieve message body)");
    // No re-fetch — body_text was satisfied on the first call.
    expect(calls).toHaveLength(1);
  });

  it("reads body from Gmail API native payload.parts shape", async () => {
    const b64 = (s: string) =>
      Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    const { provider, calls } = stubProvider([
      JSON.stringify({
        from: { name: "Sender", email: "s@example.com" },
        to: { email: "josh@example.com" },
        subject: "Real message",
        date: "2026-05-13",
        // No top-level text/body/html — only Gmail's native payload tree.
        payload: {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64("This is the body.") } },
            {
              mimeType: "text/html",
              body: { data: b64("<p>This is the body.</p>") },
            },
          ],
        },
      }),
    ]);
    const handler = createGmailToolHandler(provider, "josh");
    const result = await handler("gmail_read", { id: "abc123" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("This is the body.");
    // No re-fetch needed — payload had the body.
    expect(calls).toHaveLength(1);
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

describe("gmail_reply handler — defensive coercion of original message", () => {
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

  it("reads object-shaped From through formatAddress, not raw interpolation", async () => {
    const { provider, calls } = stubProvider([
      // First call: read original
      JSON.stringify({
        from: { name: "Tyler Coach", email: "tyler@example.com" },
        subject: "Saturday game",
        threadId: "thread-xyz",
      }),
      // Second call: create draft
      JSON.stringify({ id: "draft-1" }),
    ]);
    const handler = createGmailToolHandler(provider, "josh");
    const result = await handler("gmail_reply", {
      messageId: "abc123",
      body: "Sounds good, see you at 9.",
    });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("Reply draft created");
    // The raw MIME the draft was built from must use the formatted address
    // and the Re: subject — never `[object Object]` or `undefined`.
    // The --upload temp file path is in args[7] of the create call; we can't
    // read it back, but we can verify the create call happened and the read
    // call happened in the right order.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("+read");
    expect(calls[1]).toContain("create");
  });

  it("falls back to payload.headers[] when From/Subject not flattened", async () => {
    const { provider, calls } = stubProvider([
      JSON.stringify({
        threadId: "thread-pure",
        payload: {
          headers: [
            { name: "From", value: "Tyler <tyler@example.com>" },
            { name: "Subject", value: "Re: Saturday game" },
          ],
        },
      }),
      JSON.stringify({ id: "draft-2" }),
    ]);
    const handler = createGmailToolHandler(provider, "josh");
    const result = await handler("gmail_reply", {
      messageId: "abc123",
      body: "Confirmed.",
    });
    expect(result.is_error).toBeFalsy();
    expect(calls).toHaveLength(2);
  });

  it("does not crash when subject is missing entirely (no `.startsWith` on undefined)", async () => {
    const { provider } = stubProvider([
      JSON.stringify({
        from: { email: "x@y.test" },
        // subject intentionally absent
      }),
      JSON.stringify({ id: "draft-3" }),
    ]);
    const handler = createGmailToolHandler(provider, "josh");
    const result = await handler("gmail_reply", {
      messageId: "abc",
      body: "ok",
    });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("Reply draft created");
  });

  it("does not crash when subject is non-string (e.g. null)", async () => {
    const { provider } = stubProvider([
      JSON.stringify({
        from: { email: "x@y.test" },
        subject: null,
      }),
      JSON.stringify({ id: "draft-4" }),
    ]);
    const handler = createGmailToolHandler(provider, "josh");
    const result = await handler("gmail_reply", {
      messageId: "abc",
      body: "ok",
    });
    expect(result.is_error).toBeFalsy();
  });
});
