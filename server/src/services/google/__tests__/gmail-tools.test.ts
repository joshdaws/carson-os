import { describe, it, expect } from "vitest";
import { htmlToText, pickEmailBody } from "../gmail-tools.js";

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
