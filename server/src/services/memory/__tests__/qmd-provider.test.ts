/**
 * Tests for qmd-provider helpers.
 *
 * Currently focuses on `stripLeadingHeading` — added 2026-04-28 to fix a
 * latent duplicate-`# title` bug where save/update emit `# ${title}` while
 * the incoming content (read back from a previous save) already contained
 * its own `# title` line. Surfaced via v5 SPIKE Telegram tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stripLeadingHeading, QmdMemoryProvider } from "../qmd-provider.js";

describe("stripLeadingHeading", () => {
  it("strips a leading `# title` followed by a blank line", () => {
    expect(stripLeadingHeading("# Some Title\n\nBody content")).toBe("Body content");
  });

  it("strips a leading `# title` with no blank line after", () => {
    expect(stripLeadingHeading("# Some Title\nBody content")).toBe("Body content");
  });

  it("does not strip subheadings (## or below)", () => {
    expect(stripLeadingHeading("## Subhead\n\nBody")).toBe("## Subhead\n\nBody");
    expect(stripLeadingHeading("### Deeper\n\nBody")).toBe("### Deeper\n\nBody");
  });

  it("leaves bodies without a leading heading unchanged", () => {
    expect(stripLeadingHeading("Body content")).toBe("Body content");
    expect(stripLeadingHeading("Just a sentence with a # symbol mid-line.")).toBe(
      "Just a sentence with a # symbol mid-line.",
    );
  });

  it("tolerates leading whitespace before the heading", () => {
    expect(stripLeadingHeading("\n\n# Title\n\nBody")).toBe("Body");
  });

  it("strips only the FIRST heading, leaves later headings", () => {
    const input = "# Title\n\n## Section A\n\nBody A\n\n## Section B\n\nBody B";
    const expected = "## Section A\n\nBody A\n\n## Section B\n\nBody B";
    expect(stripLeadingHeading(input)).toBe(expected);
  });

  it("handles two-layer v5 entity bodies — strips the title heading, leaves the compiled-view text and timeline atoms", () => {
    const v5Body = `# CarsonOS: Per-Person Profiles

(Compiled view — provisional. Will regenerate.)

---

## Timeline

### 2026-04-28 | source: Josh | by: Josh | importance: 5

The original atom content here.`;
    const stripped = stripLeadingHeading(v5Body);
    expect(stripped.startsWith("(Compiled view")).toBe(true);
    expect(stripped).toContain("---");
    expect(stripped).toContain("## Timeline");
    expect(stripped).toContain("### 2026-04-28 | source: Josh");
  });

  it("handles empty or whitespace-only input", () => {
    expect(stripLeadingHeading("")).toBe("");
    expect(stripLeadingHeading("   ")).toBe("   ");
  });
});

// ── Per-file mutex (eng-review issue 1A) ─────────────────────────────

describe("per-file mutex on save/update/delete", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "carsonos-mutex-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("serializes concurrent saves to the same collection's directory", async () => {
    const provider = new QmdMemoryProvider(tmpRoot);
    // Manually populate the collections map without invoking QMD CLI.
    // ensureCollection would try to call `qmd collection add` which
    // requires the binary; tests should not depend on that.
    (provider as unknown as { collections: Map<string, string> }).collections.set(
      "test",
      tmpRoot,
    );

    // Fire 5 concurrent saves with the same title (which generates the
    // same id and therefore the same file path). Without the mutex, two
    // saves can race and clobber each other's writes; with it, they
    // serialize and the last one wins cleanly.
    const titles = Array.from({ length: 5 }, () => `concurrent-test`);
    const results = await Promise.all(
      titles.map((title, i) =>
        provider.save("test", {
          type: "fact",
          title,
          content: `body-${i}`,
          frontmatter: { topics: [`tag-${i}`] },
        }),
      ),
    );

    // All five resolved without errors.
    expect(results).toHaveLength(5);
    // All point at the same file path (same generated id from same title + date).
    const filePaths = new Set(results.map((r) => r.filePath));
    expect(filePaths.size).toBe(1);

    // The file is parseable + has frontmatter from the LAST writer that
    // ran. Without serialization, you'd see a half-written or
    // interleaved YAML block here.
    const content = readFileSync(results[0].filePath, "utf-8");
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toMatch(/type: fact/);
    expect(content).toMatch(/^body-\d/m);
  });

  it("does not block writes to different files", async () => {
    const provider = new QmdMemoryProvider(tmpRoot);
    (provider as unknown as { collections: Map<string, string> }).collections.set(
      "test",
      tmpRoot,
    );

    // Two saves to different titles (different file paths) should run
    // concurrently. We don't measure timing; we just assert both finish.
    const [a, b] = await Promise.all([
      provider.save("test", { type: "fact", title: "alpha", content: "a" }),
      provider.save("test", { type: "fact", title: "bravo", content: "b" }),
    ]);
    expect(a.filePath).not.toBe(b.filePath);
  });

  it("a failed save does not poison the lock for subsequent saves", async () => {
    const provider = new QmdMemoryProvider(tmpRoot);
    (provider as unknown as { collections: Map<string, string> }).collections.set(
      "test",
      tmpRoot,
    );

    // First save targets a missing collection — throws. The internal
    // promise chain must recover so the second save succeeds.
    await expect(
      provider.save("nonexistent-collection", {
        type: "fact",
        title: "stuck",
        content: "x",
      }),
    ).rejects.toThrow();

    // Second save to the SAME would-be path should still work.
    const ok = await provider.save("test", {
      type: "fact",
      title: "stuck",
      content: "y",
    });
    expect(readFileSync(ok.filePath, "utf-8")).toMatch(/^y$/m);
  });
});
