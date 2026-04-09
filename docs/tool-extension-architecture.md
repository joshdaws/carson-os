# CarsonOS Tool and Extension Architecture

Status: Proposed

Author: Codex

Date: 2026-04-09

## Summary

CarsonOS should not try to model every primitive capability an agent runtime already has.

It should model only Carson-owned extensions:

- connectors
- tools
- skills
- extension packages

This keeps the system useful and local-first without turning CarsonOS into a clone of Claude Code.

The key idea is:

- runtime agents keep their native abilities
- CarsonOS adds installable household capabilities on top
- those capabilities are packaged as extensions
- extensions can come from core packages, generated code, community sources, or imports such as `skills.sh`

## Goals

- Let users install useful integrations such as YNAB, Google Calendar, Gmail, or a local brain.
- Let the head-of-household agent generate new reusable tools and skills.
- Keep the open source repo portable.
- Make extensions visible and manageable in the CarsonOS product.
- Support imports from external ecosystems such as `skills.sh`, OpenClaw, or Hermes without baking those systems into CarsonOS core.

## Non-Goals

- Recreate every built-in runtime ability such as web search, shell access, or file reads.
- Build an enterprise-grade zero-trust permission system.
- Guarantee that all imported community skills are safe.
- Require that every extension be portable across every machine.

CarsonOS is an open source household system that runs locally. The architecture should be disciplined, but it does not need corporate-grade lockdown to be useful.

## Core Model

CarsonOS should distinguish four concepts.

### Connector

A configured service or local data source.

Examples:

- Google Calendar account
- Gmail account
- YNAB budget
- local brain repo
- Todoist account

Connectors are what users turn on and configure in the UI.

### Tool

A callable operation that agents can use.

Examples:

- `list_budget_categories`
- `get_budget_summary`
- `create_budget_transaction`
- `list_calendar_events`
- `search_brain`

Tools are CarsonOS runtime objects, not raw runtime privileges.

### Skill

A higher-level workflow composed from tools.

Examples:

- `weekly_budget_review`
- `prepare_homeschool_week`
- `daily_household_briefing`

Skills are reusable agent workflows. They may be prompt-based, code-based, or mixed.

### Extension

A packaged bundle that may contain connectors, tools, skills, settings UI metadata, and optional setup logic.

Examples:

- `core/google-calendar`
- `community/ynab`
- `generated/family-chore-planner`
- `imported/skills-sh-budget-review`

Extensions are the install and distribution unit.

## Design Principle

When the head-of-household agent "creates a tool," CarsonOS should treat that as generating an extension package, not minting arbitrary new powers.

That means the agent can:

- generate code
- generate manifests
- define settings fields
- define tools and skills
- install the result locally after approval

But CarsonOS should not pretend that generated tools are the same thing as base runtime powers such as shell access.

The product value of a generated tool is that it becomes:

- reusable
- typed
- configurable
- visible in Settings
- assignable to agents

## Manifest Shape

Keep the first version simple.

```ts
type AgentRole = "head" | "staff" | "child" | "automation";
type ExtensionSource = "core" | "community" | "generated" | "imported";
type ConnectorAuthType = "oauth" | "api_key" | "local" | "none";
type ToolRuntime = "typescript" | "shell" | "mcp" | "http";

interface ConnectorManifest {
  id: string;
  name: string;
  version: string;
  auth: ConnectorAuthType;
  configSchema: unknown;
  settingsUi?: {
    displayName: string;
    description?: string;
  };
}

interface ToolManifest {
  id: string;
  name: string;
  version: string;
  connectorId?: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  runtime: ToolRuntime;
  grantedTo: AgentRole[];
  visibleToUser?: boolean;
}

interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  toolIds: string[];
  grantedTo: AgentRole[];
}

interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  source: ExtensionSource;
  description?: string;
  connectors?: ConnectorManifest[];
  tools?: ToolManifest[];
  skills?: SkillManifest[];
}
```

This is intentionally lighter than the earlier governance-heavy sketch.

The primary questions are:

1. Is the extension installed?
2. Is it enabled?
3. Which agent roles get access?

That is enough for a first useful version.

## Filesystem Layout

Keep generated and imported extensions out of the CarsonOS git repo.

Proposed layout:

```text
~/.carson/
  extensions/
    core/
    local/
    generated/
    imported/
  connector-config/
  extension-state.json
```

### Why

- the open source repo stays clean
- generated code is user-local
- private integrations do not pollute git
- community imports can be enabled or removed without editing CarsonOS source

## Runtime Architecture

CarsonOS should load extensions at startup from core plus the user-local extension directories.

Proposed server layout:

```text
server/src/extensions/
  loader.ts
  registry.ts
  manifests.ts
  installer.ts
  generator.ts
  importers/
    skills-sh.ts
    openclaw.ts
    hermes.ts
```

### Responsibilities

- `loader.ts`
  - scans extension directories
  - loads manifests
  - validates shape

- `registry.ts`
  - registers connectors, tools, and skills
  - answers lookup queries for runtime execution

- `installer.ts`
  - installs packaged or imported extensions
  - records enabled state

- `generator.ts`
  - scaffolds extensions the head agent creates

- `importers/*`
  - converts external formats into CarsonOS extension manifests

## Settings Model

The first version should keep permissions simple.

Each extension or connector should have:

- `installed`
- `enabled`
- `grantedTo`

Each configured connector should also have:

- auth state
- account metadata
- optional resource selections

Examples:

- Google Calendar connector
  - connected account
  - selected calendars
  - granted to `head` and `staff`

- YNAB connector
  - API token configured
  - granted to `head`

This is enough to make the system understandable in the UI.

## Generated Tool Flow

When a user asks Carson to add support for something new, the head-of-household agent should create an extension, not just answer with ad hoc code.

### Example

User says:

> We use YNAB for our budget. Can you create a tool that gives our agents access to that?

Flow:

1. Carson enters "extension generation" mode.
2. Carson drafts a local extension package:
   - manifest
   - connector definition
   - tool implementations
   - optional setup UI schema
3. Carson shows an install review:
   - extension name
   - what service it connects to
   - what tools it adds
   - which agent roles will get access
   - what configuration is required
4. User approves install.
5. CarsonOS writes the extension to `~/.carson/extensions/generated/...`
6. User configures the connector in Settings.
7. The tools become available to the allowed agents.

## Importing From skills.sh

`skills.sh` should fit as an import source, not as a special system.

The right mental model is:

- `skills.sh` publishes candidate skills
- CarsonOS imports one
- CarsonOS converts it into a Carson extension
- the imported extension is installed locally

### Recommended UX

The user should be able to do either of these:

1. Paste a `skills.sh` URL into a Settings screen.
2. Ask Carson in chat: "Install this skill" and provide the URL.

Both paths should flow through the same importer.

### Import pipeline

1. Fetch or read the remote skill definition.
2. Parse the skill metadata and assets.
3. Convert it into CarsonOS types:
   - imported skill manifest
   - optional tool declarations
   - optional settings metadata
4. Show an install review:
   - title
   - source URL
   - what the skill appears to do
   - what tools or connectors it depends on
   - whether it will only produce a skill or also add executable tools
5. User approves install.
6. CarsonOS writes the normalized package into `~/.carson/extensions/imported/...`
7. Registry reloads the extension.

## Why skills.sh imports are useful

They let users bring in community workflows without making CarsonOS itself own that ecosystem.

CarsonOS only needs to support:

- discovery by URL
- import
- normalization
- installation

That keeps the core small.

## Import Trust Levels

Imported skills should be categorized with a simple trust model.

### Level 1: Skill-only import

The imported package defines prompts, workflows, templates, or code that only uses already-installed Carson tools.

This is the easiest and safest import class.

### Level 2: Tool wrapper import

The imported package defines new Carson tools that still rely on a declared connector or runtime adapter.

Example:

- a `skills.sh` package that adds YNAB read tools once the user provides a YNAB token

This should require install review and explicit enablement.

### Level 3: Raw runtime import

The imported package wants direct shell commands, arbitrary scripts, or unstructured host access.

CarsonOS should support this only as an advanced local-user option and label it clearly as unreviewed or host-trusting.

That matches your stated tradeoff:

- keep the system useful
- do not pretend dangerous imports are safe
- let advanced users opt in on their own machines

## UI Flow

CarsonOS should have an Extensions area in Settings with three entry paths.

### Path 1: Install connector or extension

- browse core extensions
- browse local extensions
- enable or disable installed packages

### Path 2: Import from URL

- paste a `skills.sh` URL
- preview normalized metadata
- approve install

### Path 3: Generate with Carson

- prompt Carson to build a new extension
- review the generated manifest and tools
- approve install

This keeps user mental models simple:

- browse
- import
- generate

## How Imported skills.sh Packages Should Map

The importer should not try to preserve every external concept exactly.

Normalize to CarsonOS concepts:

- external skill metadata becomes `ExtensionManifest` plus `SkillManifest`
- external parameters become connector or settings fields
- external actions become Carson tools when needed
- unsupported capabilities become installer warnings

The importer can attach source metadata for traceability:

```ts
interface ImportedMetadata {
  sourceUrl: string;
  sourceKind: "skills_sh" | "openclaw" | "hermes";
  importedAt: string;
  originalName?: string;
  originalVersion?: string;
}
```

## Relationship to TanStack Code Mode

This extension system and TanStack Code Mode solve different problems.

- extension architecture defines what Carson can install and reuse
- Code Mode defines how an agent executes approved multi-step work

They fit together well:

- imported or generated tools register in the extension registry
- Code Mode receives the allowed tool subset for a task
- skills may call tools through text-only prompts or Code Mode execution

Code Mode is the execution backend.
Extensions are the packaging and lifecycle model.

## Recommended First Version

Build the smallest system that demonstrates the architecture.

### Phase 1

- extension manifest types
- extension loader
- extension registry
- local extension directories under `~/.carson`
- one manually installed core extension

### Phase 2

- Settings UI for installed extensions
- enabled and granted-to state
- one generated extension flow

### Phase 3

- `skills.sh` URL importer
- install preview
- imported extension persistence

### Phase 4

- head-agent extension generator
- TanStack Code Mode integration for skill execution

## Recommended First Example

YNAB is a strong first generated or imported extension because it tests the right things:

- external auth or token config
- structured read tools
- useful household workflows
- clear user value

It is a better architecture test than another generic chat skill.

## Bottom Line

CarsonOS should not try to govern every base runtime capability.

It should govern and package the household-specific capability layer:

- connectors
- tools
- skills
- extension packages

`skills.sh` fits naturally as an import source into that architecture.

The right user experience is:

- install core extensions
- import community skills by URL
- ask Carson to generate new extensions

All three should end up as the same thing on disk:

a normalized CarsonOS extension package loaded from the local extension registry.
