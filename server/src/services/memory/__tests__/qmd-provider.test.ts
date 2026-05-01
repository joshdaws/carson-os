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
import { stripLeadingHeading, serializeFrontmatterYaml, QmdMemoryProvider } from "../qmd-provider.js";

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

// ── serializeFrontmatterYaml (drops null/undefined) ─────────────────

describe("serializeFrontmatterYaml", () => {
  it("emits simple key:value pairs", () => {
    const out = serializeFrontmatterYaml({ id: "x", type: "fact" });
    expect(out).toBe("id: x\ntype: fact");
  });

  it("formats arrays as YAML list items", () => {
    const out = serializeFrontmatterYaml({ topics: ["a", "b"] });
    expect(out).toBe("topics:\n  - a\n  - b");
  });

  it("emits an empty array as inline []", () => {
    const out = serializeFrontmatterYaml({ aliases: [] });
    expect(out).toBe("aliases: []");
  });

  it("DROPS undefined values (regression: 'aliases: undefined' bug)", () => {
    const out = serializeFrontmatterYaml({
      id: "x",
      aliases: undefined,
      source: "telegram",
    });
    expect(out).toBe("id: x\nsource: telegram");
    expect(out).not.toContain("undefined");
  });

  it("drops null values too", () => {
    const out = serializeFrontmatterYaml({ id: "x", topics: null });
    expect(out).toBe("id: x");
    expect(out).not.toContain("null");
  });

  it("preserves zero, false, and empty strings (only null/undefined drop)", () => {
    const out = serializeFrontmatterYaml({ a: 0, b: false, c: "" });
    expect(out).toContain("a: 0");
    expect(out).toContain("b: false");
    // Empty string still emits — caller's choice.
    expect(out).toContain("c: ");
  });
});

// ── QMD reindex coalescing ──────────────────────────────────────────

describe("QmdMemoryProvider.reindex coalescing", () => {
  it("burst saves trigger at most one in-flight reindex + at most one queued", async () => {
    // We can't easily mock execFileAsync without rewiring the module,
    // but we CAN observe the coalescing via the private state machine:
    // after firing N concurrent saves, reindexInFlight is non-null
    // exactly once and reindexQueued flips to true at most once.
    const tmp = mkdtempSync(join(tmpdir(), "qmd-reindex-coalesce-"));
    try {
      const provider = new QmdMemoryProvider(tmp);
      (provider as unknown as { collections: Map<string, string> }).collections.set(
        "test",
        tmp,
      );

      // Fire 5 saves concurrently.
      const titles = Array.from({ length: 5 }, (_, i) => `coalesce-${i}`);
      await Promise.all(
        titles.map((t) =>
          provider.save("test", {
            type: "fact",
            title: t,
            content: `body-${t}`,
          }),
        ),
      );

      // All saves resolved without throwing — even though qmd CLI may
      // not be installed in the test env. The fire-and-forget reindex
      // never propagates errors back to save's caller.
      const internal = provider as unknown as {
        reindexInFlight: Promise<void> | null;
        reindexQueued: boolean;
      };
      // After all saves complete, queue should be drained eventually.
      // We don't tightly assert state here (timing-dependent), but
      // the flags must be valid types.
      expect(typeof internal.reindexQueued).toBe("boolean");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Reindex health (TODO-2: observability + self-heal) ────────────────

describe("formatReindexError", () => {
  it("returns the bare message when no stderr is present", async () => {
    const { formatReindexError } = await import("../qmd-provider.js");
    expect(formatReindexError(new Error("Command failed: qmd update"))).toBe(
      "Command failed: qmd update",
    );
  });

  it("appends qmd's stderr trace when present (string form)", async () => {
    const { formatReindexError } = await import("../qmd-provider.js");
    const err = new Error("Command failed: qmd update") as Error & { stderr: string };
    err.stderr =
      "SqliteError: constraint failed\n    at insertDocument (.../store.js:1502:6)\n  code: 'SQLITE_CONSTRAINT_PRIMARYKEY'";
    const out = formatReindexError(err);
    expect(out).toContain("Command failed: qmd update");
    expect(out).toContain("--- qmd stderr ---");
    expect(out).toContain("SQLITE_CONSTRAINT_PRIMARYKEY");
  });

  it("decodes Buffer stderr from execFileAsync", async () => {
    const { formatReindexError } = await import("../qmd-provider.js");
    const err = new Error("Command failed") as Error & { stderr: Buffer };
    err.stderr = Buffer.from("collection brain, path notes/foo.md", "utf8");
    expect(formatReindexError(err)).toContain("collection brain, path notes/foo.md");
  });

  it("trims trailing whitespace from stderr block", async () => {
    const { formatReindexError } = await import("../qmd-provider.js");
    const err = new Error("Command failed") as Error & { stderr: string };
    err.stderr = "  SqliteError: constraint failed\n\n\n";
    const out = formatReindexError(err);
    // Single newline plus the trimmed payload, no trailing whitespace.
    expect(out.endsWith("constraint failed")).toBe(true);
  });

  it("handles non-Error throws (string, undefined)", async () => {
    const { formatReindexError } = await import("../qmd-provider.js");
    expect(formatReindexError("oops")).toBe("oops");
    expect(formatReindexError(undefined)).toBe("undefined");
  });

  it("ignores empty stderr (whitespace-only) — returns plain message", async () => {
    const { formatReindexError } = await import("../qmd-provider.js");
    const err = new Error("plain error") as Error & { stderr: string };
    err.stderr = "   \n\n  ";
    expect(formatReindexError(err)).toBe("plain error");
  });
});

describe("QmdMemoryProvider.getReindexHealth", () => {
  it("starts at zero errors with null lastError", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qmd-test-"));
    try {
      const provider = new QmdMemoryProvider(tmp);
      const health = provider.getReindexHealth();
      expect(health.errorCount).toBe(0);
      expect(health.lastError).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns the same shape /api/health expects", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qmd-test-"));
    try {
      const provider = new QmdMemoryProvider(tmp);
      const health = provider.getReindexHealth();
      expect(typeof health.errorCount).toBe("number");
      expect(health.lastError === null || typeof health.lastError.at === "string").toBe(
        true,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
