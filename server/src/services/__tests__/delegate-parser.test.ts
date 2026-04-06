import { describe, it, expect } from "vitest";
import {
  parseDelegateBlocks,
  validateDelegateBlock,
} from "../delegate-parser.js";

describe("parseDelegateBlocks", () => {
  it("parses a single valid delegate block", () => {
    const response = `On it! I'll put together a study plan.

<delegate agent="tutor" type="create_study_plan">
Create a study plan for Grant's history test on Friday.
</delegate>`;

    const result = parseDelegateBlocks(response);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].agent).toBe("tutor");
    expect(result.blocks[0].type).toBe("create_study_plan");
    expect(result.blocks[0].content).toContain("study plan for Grant");
    expect(result.userMessage.trim()).toBe(
      "On it! I'll put together a study plan.",
    );
    expect(result.warnings).toHaveLength(0);
  });

  it("parses multiple delegate blocks", () => {
    const response = `Working on it.

<delegate agent="tutor" type="study_plan">Plan content</delegate>
<delegate agent="scheduler" type="block_time">Block time</delegate>`;

    const result = parseDelegateBlocks(response);

    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].agent).toBe("tutor");
    expect(result.blocks[1].agent).toBe("scheduler");
    expect(result.userMessage.trim()).toBe("Working on it.");
  });

  it("skips blocks with missing agent attribute", () => {
    const response = `<delegate type="study_plan">Content</delegate>`;

    const result = parseDelegateBlocks(response);

    expect(result.blocks).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("missing required");
  });

  it("warns on malformed blocks (unclosed tags)", () => {
    const response = `Hello!
<delegate agent="tutor" type="study">
This is never closed.`;

    const result = parseDelegateBlocks(response);

    expect(result.blocks).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("no closing"))).toBe(true);
  });

  it("does NOT parse delegate blocks inside code fences", () => {
    const response = `Here's an example of how delegation works:

\`\`\`
<delegate agent="tutor" type="example">
This is inside a code fence and should NOT be parsed.
</delegate>
\`\`\`

That's just an example.`;

    const result = parseDelegateBlocks(response);

    expect(result.blocks).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.userMessage).toContain("example of how delegation");
    // Code fence content should be preserved in user message
    expect(result.userMessage).toContain("```");
  });

  it("enforces breadth limit of 10 blocks", () => {
    const blocks = Array.from(
      { length: 12 },
      (_, i) =>
        `<delegate agent="agent${i}" type="task">Content ${i}</delegate>`,
    ).join("\n");
    const response = `Go.\n${blocks}`;

    const result = parseDelegateBlocks(response);

    expect(result.blocks).toHaveLength(10);
    expect(result.warnings.some((w) => w.includes("limit reached"))).toBe(
      true,
    );
  });

  it("strips delegate blocks from user message", () => {
    const response = `Hello! <delegate agent="tutor" type="task">Do work</delegate> Goodbye!`;

    const result = parseDelegateBlocks(response);

    expect(result.userMessage).not.toContain("<delegate");
    expect(result.userMessage).not.toContain("</delegate>");
    expect(result.userMessage).toContain("Hello!");
    expect(result.userMessage).toContain("Goodbye!");
  });

  it("handles mixed text and delegate blocks correctly", () => {
    const response = `I'll take care of that for you!

<delegate agent="tutor" type="study_plan">
Create study plan
</delegate>

Let me know if you need anything else.`;

    const result = parseDelegateBlocks(response);

    expect(result.blocks).toHaveLength(1);
    expect(result.userMessage).toContain("I'll take care of that");
    expect(result.userMessage).toContain("Let me know");
    expect(result.userMessage).not.toContain("<delegate");
  });

  it("returns empty string for response that is only delegate blocks", () => {
    const response = `<delegate agent="tutor" type="task">Content</delegate>`;

    const result = parseDelegateBlocks(response);

    expect(result.blocks).toHaveLength(1);
    expect(result.userMessage.trim()).toBe("");
  });

  it("returns full response when no delegate blocks present", () => {
    const response = "Just a regular response with no delegation.";

    const result = parseDelegateBlocks(response);

    expect(result.blocks).toHaveLength(0);
    expect(result.userMessage).toBe(response);
    expect(result.warnings).toHaveLength(0);
  });

  it("handles single-quoted attributes", () => {
    const response = `<delegate agent='tutor' type='plan'>Content</delegate>`;

    const result = parseDelegateBlocks(response);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].agent).toBe("tutor");
    expect(result.blocks[0].type).toBe("plan");
  });
});

describe("validateDelegateBlock", () => {
  it("validates block with matching agent", () => {
    const result = validateDelegateBlock(
      { agent: "tutor", type: "study_plan", content: "Do work" },
      ["tutor", "coach", "scheduler"],
    );

    expect(result.valid).toBe(true);
  });

  it("rejects block with unknown agent", () => {
    const result = validateDelegateBlock(
      { agent: "unknown_agent", type: "task", content: "Do work" },
      ["tutor", "coach", "scheduler"],
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("unknown_agent");
  });

  it("validates case-insensitively", () => {
    const result = validateDelegateBlock(
      { agent: "TUTOR", type: "study_plan", content: "Do work" },
      ["tutor", "coach"],
    );

    expect(result.valid).toBe(true);
  });
});
