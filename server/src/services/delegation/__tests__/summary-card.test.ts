import { describe, it, expect } from "vitest";
import {
  composeSummaryCard,
  renderSummaryCardText,
  type ComposeCardInput,
} from "../summary-card.js";

const baseTask: ComposeCardInput["task"] = {
  id: "task-1",
  title: "Build a Todoist tool",
  workspaceKind: "tool_sandbox",
  workspaceBranch: null,
  createdAt: new Date("2026-04-20T10:00:00Z"),
  completedAt: new Date("2026-04-20T10:12:30Z"),
};

describe("composeSummaryCard", () => {
  it("builds a completion card for a tools task", () => {
    const card = composeSummaryCard({
      kind: "completion",
      task: baseTask,
      specialty: "tools",
      artifacts: {
        filesChanged: ["SKILL.md", "handler.ts"],
        verification: { result: "passed", command: "pnpm tsc --noEmit" },
        tokensUsed: 48_231,
      },
    });

    expect(card.kind).toBe("completion");
    expect(card.specialty).toBe("tools");
    expect(card.goal).toBe("Build a Todoist tool");
    expect(card.workspaceKind).toBe("tool_sandbox");
    expect(card.durationSec).toBe(750); // 12m 30s
    expect(card.filesChanged).toEqual(["SKILL.md", "handler.ts"]);
    expect(card.verification?.result).toBe("passed");
    expect(card.tokensUsed).toBe(48_231);
  });

  it("builds a failure card with a reason", () => {
    const card = composeSummaryCard({
      kind: "failure",
      task: { ...baseTask, title: "Fix unit preview bug" },
      specialty: "project",
      reason: "tests still failing after 3 iterations",
      artifacts: {
        verification: {
          result: "failed",
          command: "pnpm test",
          output: "Expected 'Unit 1' but received undefined",
        },
      },
    });

    expect(card.kind).toBe("failure");
    expect(card.reason).toBe("tests still failing after 3 iterations");
    expect(card.verification?.result).toBe("failed");
  });

  it("uses injected now() when completedAt is null", () => {
    const card = composeSummaryCard({
      kind: "cancellation",
      task: { ...baseTask, completedAt: null },
      specialty: "project",
      now: new Date("2026-04-20T10:05:00Z"),
      reason: "cancelled by user",
    });

    expect(card.durationSec).toBe(300); // 5m
    expect(card.reason).toBe("cancelled by user");
  });

  it("coerces unknown workspace_kind to null", () => {
    const card = composeSummaryCard({
      kind: "completion",
      task: { ...baseTask, workspaceKind: "unexpected_value" },
      specialty: "tools",
    });
    expect(card.workspaceKind).toBeNull();
  });

  it("truncates filesChanged to 20 entries", () => {
    const many = Array.from({ length: 50 }, (_, i) => `file-${i}.ts`);
    const card = composeSummaryCard({
      kind: "completion",
      task: baseTask,
      specialty: "core",
      artifacts: { filesChanged: many },
    });
    expect(card.filesChanged).toHaveLength(20);
    expect(card.filesChanged?.[0]).toBe("file-0.ts");
    expect(card.filesChanged?.[19]).toBe("file-19.ts");
  });

  it("passes the PR URL + branch for project work", () => {
    const card = composeSummaryCard({
      kind: "completion",
      task: {
        ...baseTask,
        title: "Fix unit preview bug",
        workspaceKind: "worktree",
        workspaceBranch: "carson/fix-unit-preview-abc123",
      },
      specialty: "project",
      artifacts: {
        prUrl: "https://github.com/josh/homeschool-happy/pull/142",
        verification: { result: "passed", command: "pnpm test" },
      },
    });
    expect(card.branch).toBe("carson/fix-unit-preview-abc123");
    expect(card.prUrl).toContain("pull/142");
  });
});

describe("renderSummaryCardText", () => {
  it("renders a completion with verification + PR + files", () => {
    const text = renderSummaryCardText({
      kind: "completion",
      taskId: "task-1",
      specialty: "project",
      goal: "Fix unit preview",
      workspaceKind: "worktree",
      branch: "carson/fix-preview",
      prUrl: "https://github.com/j/h/pull/142",
      filesChanged: ["src/components/LessonRenderer.tsx", "src/utils/preview.ts"],
      verification: { result: "passed", command: "pnpm test" },
      durationSec: 1320, // 22m
      tokensUsed: 125_000,
    });

    expect(text).toContain("✅");
    expect(text).toContain("Fix unit preview");
    expect(text).toContain("pull/142");
    expect(text).toContain("carson/fix-preview");
    expect(text).toContain("pnpm test");
    expect(text).toContain("Files changed: 2");
    expect(text).toContain("Duration: 22m");
    expect(text).toContain("125,000 tokens");
  });

  it("renders a failure with truncated output + reason", () => {
    const big = "err\n".repeat(500); // > 1000 chars
    const text = renderSummaryCardText({
      kind: "failure",
      taskId: "task-2",
      specialty: "project",
      goal: "Fix flaky nav",
      workspaceKind: "worktree",
      branch: "carson/fix-nav",
      verification: { result: "failed", command: "pnpm test", output: big },
      durationSec: 90,
      reason: "tests failed after 3 iterations",
    });

    expect(text).toContain("❌");
    expect(text).toContain("tests failed after 3 iterations");
    expect(text).toContain("```");
    // Body is truncated to last 1000 chars — "err\n" repeated
    expect(text.match(/err/g)?.length ?? 0).toBeLessThanOrEqual(252);
  });

  it("renders skipped verification when test_cmd is absent", () => {
    const text = renderSummaryCardText({
      kind: "completion",
      taskId: "task-3",
      specialty: "project",
      goal: "Update README",
      workspaceKind: "worktree",
      verification: { result: "skipped" },
      durationSec: 45,
    });
    expect(text).toContain("Verification: skipped (no test_cmd configured)");
    expect(text).toContain("Duration: 45s");
  });

  it("caps the files-changed list to 10 visible + count", () => {
    const files = Array.from({ length: 15 }, (_, i) => `file-${i}.ts`);
    const text = renderSummaryCardText({
      kind: "completion",
      taskId: "task-4",
      specialty: "core",
      goal: "Refactor dispatcher",
      workspaceKind: "worktree",
      filesChanged: files,
      durationSec: 3600,
    });
    expect(text).toContain("Files changed: 15");
    expect(text).toContain("file-0.ts");
    expect(text).toContain("file-9.ts");
    expect(text).not.toContain("file-10.ts"); // trimmed in the visible list
    expect(text).toContain("… and 5 more");
    expect(text).toContain("Duration: 1h");
  });

  it("renders cancellation with the stop symbol + reason", () => {
    const text = renderSummaryCardText({
      kind: "cancellation",
      taskId: "task-5",
      specialty: "tools",
      goal: "Build Todoist tool",
      workspaceKind: "tool_sandbox",
      durationSec: 120,
      reason: "cancelled by user",
    });
    expect(text).toContain("⏹");
    expect(text).toContain("cancelled by user");
  });
});
