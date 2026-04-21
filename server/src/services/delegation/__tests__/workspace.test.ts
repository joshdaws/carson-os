import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  WorkspaceProvider,
  WorkspaceError,
  slugify,
} from "../workspace.js";

const execFileAsync = promisify(execFile);

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function initRepo(path: string): Promise<void> {
  await execFileAsync("git", ["-C", path, "init", "-q", "--initial-branch=main"]);
  await execFileAsync("git", ["-C", path, "config", "user.email", "test@test"]);
  await execFileAsync("git", ["-C", path, "config", "user.name", "test"]);
  await writeFile(join(path, "README.md"), "# test\n");
  await execFileAsync("git", ["-C", path, "add", "."]);
  await execFileAsync("git", ["-C", path, "commit", "-q", "-m", "init"]);
}

describe("slugify", () => {
  it("lowercases and dash-separates", () => {
    expect(slugify("Fix the unit preview bug")).toBe("fix-the-unit-preview-bug");
  });

  it("strips punctuation", () => {
    expect(slugify("Build a Todoist tool!")).toBe("build-a-todoist-tool");
  });

  it("falls back to 'task' when title has no word chars", () => {
    expect(slugify("!!!")).toBe("task");
  });

  it("caps to 40 chars at a word boundary", () => {
    const out = slugify(
      "Please refactor the entire notification subsystem to use channels",
    );
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).not.toMatch(/-$/);
    expect(out.startsWith("please-refactor-the-entire")).toBe(true);
  });
});

describe("WorkspaceProvider — tool sandbox", () => {
  let base: string;
  let provider: WorkspaceProvider;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "carson-ws-"));
    provider = new WorkspaceProvider({ baseDir: base });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("provisions a fresh sandbox directory", async () => {
    const ws = await provider.provision({ kind: "tool_sandbox", runId: "run-1" });
    expect(ws.kind).toBe("tool_sandbox");
    expect(ws.path).toBe(join(base, "sandbox", "run-1"));
    expect(ws.branch).toBeUndefined();
    expect(await pathExists(ws.path)).toBe(true);
  });

  it("refuses to provision when the sandbox path already exists", async () => {
    const ws = await provider.provision({ kind: "tool_sandbox", runId: "run-1" });
    await writeFile(join(ws.path, "scratch.ts"), "// content\n");
    await expect(
      provider.provision({ kind: "tool_sandbox", runId: "run-1" }),
    ).rejects.toMatchObject({ code: "E_WORKTREE_EXISTS" });
  });

  it("teardown removes the sandbox and is idempotent", async () => {
    const ws = await provider.provision({ kind: "tool_sandbox", runId: "run-2" });
    await writeFile(join(ws.path, "file.ts"), "// body\n");
    await provider.teardown(ws);
    expect(await pathExists(ws.path)).toBe(false);
    // second teardown is a no-op, not an error
    await provider.teardown(ws);
  });
});

describe("WorkspaceProvider — git worktree", () => {
  let base: string;
  let repoPath: string;
  let provider: WorkspaceProvider;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "carson-ws-"));
    repoPath = await mkdtemp(join(tmpdir(), "carson-repo-"));
    await initRepo(repoPath);
    provider = new WorkspaceProvider({ baseDir: base });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(repoPath, { recursive: true, force: true });
  });

  it("provisions a worktree on a new branch", async () => {
    const ws = await provider.provision({
      kind: "worktree",
      projectName: "homeschool-happy",
      projectPath: repoPath,
      defaultBranch: "main",
      runId: "run-a",
      slug: "fix-unit-preview",
    });

    expect(ws.kind).toBe("worktree");
    expect(ws.branch).toBe("carson/fix-unit-preview");
    expect(ws.path).toBe(
      join(base, "worktrees", "homeschool-happy", "run-a"),
    );
    expect(await pathExists(ws.path)).toBe(true);
    // Worktree is registered with git
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoPath,
      "worktree",
      "list",
    ]);
    expect(stdout).toContain(ws.path);
  });

  it("refuses to provision when branch already exists (E_BRANCH_EXISTS)", async () => {
    await execFileAsync("git", [
      "-C",
      repoPath,
      "branch",
      "carson/fix-unit-preview",
    ]);

    const err = await provider
      .provision({
        kind: "worktree",
        projectName: "proj",
        projectPath: repoPath,
        defaultBranch: "main",
        runId: "run-b",
        slug: "fix-unit-preview",
      })
      .then(() => null)
      .catch((e) => e);

    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).code).toBe("E_BRANCH_EXISTS");
  });

  it("branchExists reports correctly", async () => {
    expect(await provider.branchExists(repoPath, "not-a-branch")).toBe(false);
    await execFileAsync("git", ["-C", repoPath, "branch", "real-branch"]);
    expect(await provider.branchExists(repoPath, "real-branch")).toBe(true);
  });

  it("teardown removes the worktree + leaves the repo clean", async () => {
    const ws = await provider.provision({
      kind: "worktree",
      projectName: "p",
      projectPath: repoPath,
      defaultBranch: "main",
      runId: "run-c",
      slug: "s",
    });
    expect(await pathExists(ws.path)).toBe(true);

    await provider.teardown(ws);
    expect(await pathExists(ws.path)).toBe(false);
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoPath,
      "worktree",
      "list",
    ]);
    expect(stdout).not.toContain(ws.path);
    // Repo dir remains intact
    const entries = await readdir(repoPath);
    expect(entries).toContain("README.md");
  });

  it("teardown is idempotent when the worktree dir is already gone", async () => {
    const ws = await provider.provision({
      kind: "worktree",
      projectName: "p",
      projectPath: repoPath,
      defaultBranch: "main",
      runId: "run-d",
      slug: "s2",
    });
    // Manually nuke the directory (simulates a prior teardown or manual rm)
    await rm(ws.path, { recursive: true, force: true });
    // teardown must not throw
    await provider.teardown(ws);
  });
});
