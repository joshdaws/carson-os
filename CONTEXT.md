# CarsonOS

The family AI agent platform. Each family member has a personal AI on Telegram with memory, tools, and personality, governed by a family constitution. The system can modify itself: agents delegate work to specialist agents that produce PRs against CarsonOS' own source.

## Language

### Agents and delegation

**Household**:
The unit of tenancy — a single family. All members, agents, projects, tasks, and memory belong to one household.
_Avoid_: tenant, account, organization

**Member**:
A human family member with a personal agent. Identified by name; carries a profile, role, and trust level.
_Avoid_: user (too generic — also overloaded with the human typing into Telegram), person

**Agent**:
A persona running on the Claude Agent SDK with a constitution, role, personality, memory, and tool access. Distinct kinds: a member's personal agent (e.g. Carson) and hired specialists.
_Avoid_: bot, assistant

**Specialist**:
A hired agent that exists to do delegated work — Developer, Tutor, Scheduler. Lives at the household level, not member level. Has a name (Bob, Alice, Claude-self) and a hired specialty.
_Avoid_: worker, subagent

**Delegator**:
The agent that initiated a delegated run. The party who later receives the **delegator reply**.
_Avoid_: caller, parent agent

**Delegated run**:
The unit of asynchronous handoff: a delegator asks a specialist to do work, the specialist runs in the background, then the specialist's outcome is reported back to the delegator. Identified by `runId`. Persisted as a task row.
_Avoid_: job, task (overloaded — task is the persistence layer; the *unit* is a run)

**Delegator reply**:
The in-voice update from the delegator about the specialist's run. The invariant: delegators always speak about their specialists' work in their own voice; templated machine-shaped messages are a last-resort fallback only.
_Avoid_: notification, completion message

### Workspace and runtime

**Workspace**:
Where a specialist's run executes on disk. Three kinds:
- **Worktree** — a fresh `git worktree` of a registered project, used for any change to existing source. Output is a PR.
- **Sandbox** — an empty scratch directory at `~/.carsonos/sandbox/{runId}/`, used only for brand-new tool/skill creation.
- **System workspace** — sugar for "worktree of the CarsonOS project itself." Auto-resolved by name; no `projectId` needed.

**Project**:
A registered codebase the household can do delegated work in. Has a name and a path to a git checkout. CarsonOS is itself a project (`carson-os`); other projects can be registered.

**Self-modifying runtime**:
The CarsonOS host process can produce changes to its own source through delegated runs. This constrains how the runtime is reloaded — naive file-watch auto-reload is incompatible with self-modification because the act of modifying triggers the cure (restart) that kills the run mid-modification. See [ADR-0001](./docs/adr/0001-no-file-watch-on-live-instance.md).

### Memory and constitution

**Constitution**:
The family-level rules every agent reads first in its system prompt. Edited by the household; not per-agent.
_Avoid_: rules, policy

**Memory**:
Markdown-backed knowledge an agent searches on demand via the `search_memory` tool. 13 typed kinds (people, events, preferences, etc.); QMD-indexed.

## Relationships

- A **Household** has many **Members**, **Agents**, **Specialists**, **Projects**, and **Delegated runs**
- A **Member** has exactly one personal **Agent**
- A **Delegator** (Agent) initiates a **Delegated run** assigned to a **Specialist** (Agent)
- A **Delegated run** executes inside one **Workspace** (worktree, sandbox, or system)
- A **Delegated run** ends with a **Delegator reply** sent to the member on whose behalf it ran

## Example dialogue

> **Member:** "Have Bob fix the gmail tool."
> **Carson** (the **delegator**): kicks off a **delegated run** assigned to **Bob** (the **specialist**), choosing a **system workspace** because the gmail tool lives in CarsonOS.
> **Bob** works in a worktree, opens a PR, hits terminal state.
> **Carson** wakes, sees Bob's result, sends a **delegator reply**: "Bob got that gmail bug sorted — turned out the OAuth refresh token wasn't persisting on retry. PR's up at #42."

## Flagged ambiguities

- "task" was used to mean both the persistence row and the unit of work — resolved: a **delegated run** is the unit; a "task row" is the implementation detail of how the run is persisted. Prefer "run" in design conversation; "task row" only when discussing the schema.
- "user" was used to mean both **member** (family member with an agent) and the human currently typing into Telegram — resolved: prefer **member**; "user" is reserved for the human-in-the-loop generically.
- "boundary" was used informally — resolved: in architectural discussion, use **seam** (per LANGUAGE.md vocabulary) to avoid clashing with DDD's bounded context.
