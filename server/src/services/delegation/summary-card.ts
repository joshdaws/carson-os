/**
 * Summary card composition for v0.4 delegation.
 *
 * Pure card composition — no DB, no Telegram, no LLM. The dispatcher calls
 * composeSummaryCard() when a Developer task reaches a terminal state, then
 * hands the card to Carson's query() to generate natural follow-up prose
 * (via his own system prompt + personality). The notifier sends the prose
 * to Telegram and stores the structured card alongside for audit.
 *
 * renderSummaryCardText() is a deterministic fallback for cases where we
 * can't or shouldn't invoke an LLM (failure paths, reconciler retries after
 * a host restart).
 */

export type SummaryCardKind = "completion" | "failure" | "cancellation";
export type DeveloperSpecialty = "tools" | "project" | "core";
export type WorkspaceKind = "worktree" | "tool_sandbox";
export type VerificationResult = "passed" | "failed" | "skipped";

export interface SummaryCardVerification {
  result: VerificationResult;
  /** Trimmed command output (last ~2KB) when result='failed'. Optional for 'passed'/'skipped'. */
  output?: string;
  /** The command that ran (e.g. "pnpm test"). Absent when verification was skipped. */
  command?: string;
}

export interface SummaryCard {
  kind: SummaryCardKind;
  taskId: string;
  specialty: string;
  /** The task title — what the Developer was asked to do. */
  goal: string;
  workspaceKind: WorkspaceKind | null;
  /** For workspaceKind='worktree'. */
  branch?: string;
  /** For workspaceKind='worktree' on project/core specialties. */
  prUrl?: string;
  /** Absolute filesystem path of the workspace — used in completion text so
   *  the user knows where to review files. */
  workspacePath?: string;
  /** Relative paths, trimmed to the first ~20 entries. */
  filesChanged?: string[];
  verification?: SummaryCardVerification;
  durationSec: number;
  /** Total tokens across the run (input + output). Best-effort; may be absent. */
  tokensUsed?: number;
  /** For kind='failure' | 'cancellation'. */
  reason?: string;
}

export interface ComposeCardInput {
  kind: SummaryCardKind;
  task: {
    id: string;
    title: string;
    workspaceKind: string | null;
    workspaceBranch: string | null;
    workspacePath?: string | null;
    createdAt: Date;
    completedAt: Date | null;
  };
  specialty: string;
  artifacts?: {
    prUrl?: string;
    filesChanged?: string[];
    verification?: SummaryCardVerification;
    tokensUsed?: number;
  };
  reason?: string;
  /** Defaults to `Date.now()` if completedAt is null. Injected for deterministic tests. */
  now?: Date;
}

export function composeSummaryCard(input: ComposeCardInput): SummaryCard {
  const end = input.task.completedAt ?? input.now ?? new Date();
  const durationSec = Math.max(
    0,
    Math.floor((end.getTime() - input.task.createdAt.getTime()) / 1000),
  );

  const wk = input.task.workspaceKind;
  const workspaceKind: WorkspaceKind | null =
    wk === "worktree" || wk === "tool_sandbox" ? wk : null;

  const filesChanged = input.artifacts?.filesChanged
    ? input.artifacts.filesChanged.slice(0, 20)
    : undefined;

  return {
    kind: input.kind,
    taskId: input.task.id,
    specialty: input.specialty,
    goal: input.task.title,
    workspaceKind,
    branch: input.task.workspaceBranch ?? undefined,
    workspacePath: input.task.workspacePath ?? undefined,
    prUrl: input.artifacts?.prUrl,
    filesChanged,
    verification: input.artifacts?.verification,
    durationSec,
    tokensUsed: input.artifacts?.tokensUsed,
    reason: input.reason,
  };
}

/**
 * Deterministic fallback text for a summary card. Used when Carson's query()
 * can't generate prose (reconciler after restart, test environments). The
 * dispatcher's happy path runs the card through Carson for natural phrasing.
 */
export function renderSummaryCardText(card: SummaryCard): string {
  const lines: string[] = [];
  const goalSummary = summarizeGoal(card.goal);

  if (card.kind === "completion") {
    lines.push(`✅ ${titleForSpecialty(card.specialty)} finished`);
    lines.push(`_${goalSummary}_`);
  } else if (card.kind === "failure") {
    lines.push(`❌ ${titleForSpecialty(card.specialty)} failed`);
    lines.push(`_${goalSummary}_`);
  } else {
    lines.push(`⏹ ${titleForSpecialty(card.specialty)} cancelled`);
    lines.push(`_${goalSummary}_`);
  }

  if (card.prUrl) lines.push(`PR: ${card.prUrl}`);
  if (card.branch) lines.push(`Branch: ${card.branch}`);
  // For tool builds, tell the user where the files live — they need to
  // review before installing.
  if (card.kind === "completion" && card.workspaceKind === "tool_sandbox" && card.workspacePath) {
    lines.push(`Review at: \`${card.workspacePath}\``);
  }

  if (card.verification) {
    if (card.verification.result === "passed") {
      lines.push(`Verification: passed${card.verification.command ? ` (${card.verification.command})` : ""}`);
    } else if (card.verification.result === "failed") {
      lines.push(`Verification: failed${card.verification.command ? ` (${card.verification.command})` : ""}`);
      if (card.verification.output) {
        lines.push("");
        lines.push("```");
        lines.push(card.verification.output.slice(-1000));
        lines.push("```");
      }
    } else {
      lines.push("Verification: skipped (no test_cmd configured)");
    }
  }

  if (card.filesChanged && card.filesChanged.length > 0) {
    lines.push(`Files changed: ${card.filesChanged.length}`);
    for (const f of card.filesChanged.slice(0, 10)) lines.push(`  • ${f}`);
    if (card.filesChanged.length > 10) lines.push(`  … and ${card.filesChanged.length - 10} more`);
  }

  if (card.reason) lines.push(`Reason: ${card.reason}`);
  lines.push(`Duration: ${formatDuration(card.durationSec)}${card.tokensUsed ? ` · ${card.tokensUsed.toLocaleString()} tokens` : ""}`);

  return lines.join("\n");
}

function titleForSpecialty(s: string): string {
  switch (s) {
    case "tools": return "Tool build";
    case "project": return "Project work";
    case "core": return "Core update";
    default: {
      // Capitalize + append " task" for non-Developer specialties
      const pretty = s
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
      return `${pretty} task`;
    }
  }
}

/** Truncate a verbose task prompt to a one-line summary. Cuts on the first
 *  sentence boundary if present, else at ~80 chars. */
function summarizeGoal(goal: string): string {
  const single = goal.replace(/\s+/g, " ").trim();
  // Prefer first sentence when it's reasonable length
  const firstSentenceEnd = single.search(/[.!?](\s|$)/);
  if (firstSentenceEnd > 10 && firstSentenceEnd <= 120) {
    return single.slice(0, firstSentenceEnd + 1);
  }
  if (single.length <= 100) return single;
  // Cut at a word boundary near 90 chars
  const cut = single.slice(0, 90);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 50 ? cut.slice(0, lastSpace) : cut) + "…";
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}
