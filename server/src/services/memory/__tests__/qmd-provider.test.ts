/**
 * Tests for qmd-provider helpers.
 *
 * Currently focuses on `stripLeadingHeading` — added 2026-04-28 to fix a
 * latent duplicate-`# title` bug where save/update emit `# ${title}` while
 * the incoming content (read back from a previous save) already contained
 * its own `# title` line. Surfaced via v5 SPIKE Telegram tests.
 */

import { describe, it, expect } from "vitest";
import { stripLeadingHeading } from "../qmd-provider.js";

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
