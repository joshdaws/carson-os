/**
 * Workspace provisioning + teardown for v0.4 Developer tasks.
 *
 * Two workspace kinds:
 *   - 'worktree' — per-task git worktree under ~/.carsonos/worktrees/{project}/{runId}/
 *     checked out from the project's default_branch on a fresh branch
 *     named carson/{slug}. Used for `project` and `core` specialties.
 *   - 'tool_sandbox' — plain scratch directory under ~/.carsonos/sandbox/{runId}/.
 *     Used for `tools` specialty (tools aren't in a git project; they're
 *     standalone SKILL.md bundles).
 *
 * Branch-exists policy (eng-review critical test gap):
 * `git worktree add -b <branch>` FAILS if the branch already exists.
 * We keep this as the explicit behavior: provision() throws
 * E_BRANCH_EXISTS. Callers that need to attach to an existing branch
 * (review-iteration loops in v0.5) opt in via a dedicated API. v0.4's
 * worktree-teardown-on-PR-merge keeps this a rare path — normal cancel /
 * completion teardown runs through teardown() which is idempotent and
 * cleans up the branch-side state for future provisions.
 *
 * Teardown is idempotent: if the worktree or sandbox dir is already gone
 * (manual rm, prior teardown, git's own cleanup), teardown returns ok.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, access } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

export type WorkspaceKind = "worktree" | "tool_sandbox";

export interface ProvisionedWorkspace {
  kind: WorkspaceKind;
  path: string; // absolute
  /** Populated for kind='worktree' only. */
  branch?: string;
  /** Absolute path to the parent git repo. Populated for kind='worktree' only.
   * Teardown uses this to run `git -C <repoPath> worktree remove`. */
  repoPath?: string;
}

export interface ProvisionWorktreeInput {
  kind: "worktree";
  /** Slugified project name; becomes a directory segment under worktrees/. */
  projectName: string;
  /** Absolute path to the project's git checkout. */
  projectPath: string;
  defaultBranch: string;
  runId: string;
  /** Task-derived slug used in the branch name: carson/{slug}. */
  slug: string;
}

export interface ProvisionToolSandboxInput {
  kind: "tool_sandbox";
  runId: string;
}

export type ProvisionInput = ProvisionWorktreeInput | ProvisionToolSandboxInput;

export type WorkspaceErrorCode =
  | "E_BRANCH_EXISTS"
  | "E_WORKTREE_EXISTS"
  | "E_DISK_FULL"
  | "E_GIT_FAILED"
  | "E_UNKNOWN";

export class WorkspaceError extends Error {
  constructor(
    public readonly code: WorkspaceErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface WorkspaceProviderOptions {
  /** Defaults to ~/.carsonos. Injected as tmpdir for tests. */
  baseDir?: string;
  /** Injected git executable; defaults to PATH lookup. */
  gitBin?: string;
}

export class WorkspaceProvider {
  private readonly baseDir: string;
  private readonly gitBin: string;

  constructor(options: WorkspaceProviderOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".carsonos");
    this.gitBin = options.gitBin ?? "git";
  }

  async provision(input: ProvisionInput): Promise<ProvisionedWorkspace> {
    return input.kind === "worktree"
      ? this.provisionWorktree(input)
      : this.provisionToolSandbox(input);
  }

  async teardown(workspace: ProvisionedWorkspace): Promise<void> {
    if (!workspace.path) return;
    if (workspace.kind === "worktree") {
      await this.teardownWorktree(workspace);
    } else {
      await this.teardownToolSandbox(workspace);
    }
  }

  /** Check whether a branch exists in the given repo. Useful for pre-flighting. */
  async branchExists(repoPath: string, branch: string): Promise<boolean> {
    try {
      await execFileAsync(this.gitBin, [
        "-C",
        repoPath,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  private worktreeRoot(projectName: string): string {
    return join(this.baseDir, "worktrees", projectName);
  }

  private sandboxRoot(): string {
    return join(this.baseDir, "sandbox");
  }

  private async provisionWorktree(
    input: ProvisionWorktreeInput,
  ): Promise<ProvisionedWorkspace> {
    // Defense-in-depth against a projectName that slipped past route validation
    // (e.g., direct service call, test, or future migration). Resolve the final
    // path and require it stays inside the worktrees root.
    const root = join(this.baseDir, "worktrees");
    const parent = this.worktreeRoot(input.projectName);
    const path = join(parent, input.runId);
    const resolvedRoot = resolve(root) + sep;
    const resolvedPath = resolve(path);
    if (!resolvedPath.startsWith(resolvedRoot)) {
      throw new WorkspaceError(
        "E_GIT_FAILED",
        `Worktree path escape: ${resolvedPath} is outside ${resolvedRoot}`,
      );
    }
    const branch = `carson/${input.slug}`;

    if (await this.branchExists(input.projectPath, branch)) {
      throw new WorkspaceError(
        "E_BRANCH_EXISTS",
        `Branch ${branch} already exists in ${input.projectPath}. ` +
          `Reuse requires an explicit attach API (v0.5).`,
      );
    }

    if (await pathExists(resolvedPath)) {
      throw new WorkspaceError(
        "E_WORKTREE_EXISTS",
        `Worktree path ${resolvedPath} already exists. Clean up before provisioning.`,
      );
    }

    await mkdir(parent, { recursive: true });

    try {
      await execFileAsync(this.gitBin, [
        "-C",
        input.projectPath,
        "worktree",
        "add",
        "-b",
        branch,
        resolvedPath,
        input.defaultBranch,
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new WorkspaceError(
        "E_GIT_FAILED",
        `git worktree add failed: ${message}`,
        err,
      );
    }

    return { kind: "worktree", path: resolvedPath, branch, repoPath: input.projectPath };
  }

  private async teardownWorktree(
    workspace: ProvisionedWorkspace,
  ): Promise<void> {
    // Preferred: `git -C <repo> worktree remove --force <path>` — cleans
    // both the directory and the parent repo's admin state in one call.
    if (workspace.repoPath) {
      try {
        await execFileAsync(this.gitBin, [
          "-C",
          workspace.repoPath,
          "worktree",
          "remove",
          "--force",
          workspace.path,
        ]);
        return;
      } catch {
        // Fall through to fs cleanup + prune fallback below.
      }
    }

    // Fallback: directory may already be gone (manual rm, prior teardown).
    // Remove the dir idempotently, then prune the parent repo's admin state
    // if we know where it lives so we don't leave "prunable" entries.
    await rm(workspace.path, { recursive: true, force: true });
    if (workspace.repoPath) {
      try {
        await execFileAsync(this.gitBin, [
          "-C",
          workspace.repoPath,
          "worktree",
          "prune",
        ]);
      } catch {
        // Non-fatal: prune failures are a hygiene miss, not a correctness one.
      }
    }
  }

  private async provisionToolSandbox(
    input: ProvisionToolSandboxInput,
  ): Promise<ProvisionedWorkspace> {
    const path = join(this.sandboxRoot(), input.runId);
    if (await pathExists(path)) {
      throw new WorkspaceError(
        "E_WORKTREE_EXISTS",
        `Sandbox path ${path} already exists. Tool sandbox run ids must be unique.`,
      );
    }
    await mkdir(path, { recursive: true });
    return { kind: "tool_sandbox", path };
  }

  private async teardownToolSandbox(
    workspace: ProvisionedWorkspace,
  ): Promise<void> {
    await rm(workspace.path, { recursive: true, force: true });
  }
}

/**
 * Convert a task title into a branch-safe slug.
 * "Fix the unit preview bug" → "fix-the-unit-preview-bug"
 * "Build a Todoist tool!" → "build-a-todoist-tool"
 * Caps at 40 chars so the full `carson/{slug}` branch name stays readable.
 */
export function slugify(title: string, maxLen = 40): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length <= maxLen) return cleaned || "task";
  // Cut at the nearest dash before the cap so we don't end on a partial word.
  const cut = cleaned.slice(0, maxLen);
  const lastDash = cut.lastIndexOf("-");
  return lastDash > maxLen / 2 ? cut.slice(0, lastDash) : cut;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
