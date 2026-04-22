/**
 * Prompt Compiler -- pure string builder for agent system prompts.
 *
 * Extracted from the constitution engine to separate prompt construction
 * from clause evaluation. No DB access, no network calls, no side effects.
 *
 * Two modes:
 *   - chat: user-facing conversations (role + soul + member intro + constitution + soft rules + delegation)
 *   - task: internal work execution (role + task brief + instructions + governing rules + progress markers)
 */

// -- Types -----------------------------------------------------------

export interface CompilePromptParams {
  mode: "chat" | "task";
  roleContent: string;
  soulContent: string | null;
  softRules: string;
  constitutionDocument: string;
  memberName?: string;
  memberRole?: string;
  memberAge?: number;
  memberProfile?: string | null;
  // First-contact onboarding (no profile + new conversation)
  firstContact?: boolean;
  conversationTurnCount?: number;
  // Task mode fields
  taskTitle?: string;
  taskDescription?: string;
  // Delegation fields (personal agents only)
  delegationInstructions?: string | null;
  // M1: Memory + operating instructions
  operatingInstructions?: string | null;
  ambientMemory?: string | null;
  memorySchemaInstructions?: string | null;
  // Trust level + enabled skills (for system capability awareness)
  trustLevel?: string | null;
  enabledSkills?: string[] | null;
  // In-loop skill proposals (full-trust agents only)
  enableSkillProposals?: boolean;
  // Household roster (all family members)
  householdName?: string | null;
  householdMembers?: Array<{ name: string; role: string; age: number }> | null;
}

export interface DelegationEdge {
  agentId: string;
  agentName: string;
  staffRole: string;
  specialty: string | null;
}

// -- Constants -------------------------------------------------------

const SKILL_PROPOSAL_INSTRUCTIONS = [
  "After completing any multi-step task, ask yourself: could this happen again?",
  "",
  "If yes — draft a skill proposal. A skill is a reusable procedure that can be",
  "invoked by name in future sessions, saving you and the user from rediscovering",
  "the same steps. You don't need to be asked. Notice the pattern, write the draft,",
  "present it for approval.",
  "",
  "Propose a skill when ALL of these are true:",
  "- The task required 3 or more non-obvious steps",
  "- The same situation could plausibly arise again",
  "- The steps aren't already covered by an installed skill",
  "",
  "Do NOT propose a skill for:",
  "- One-off tasks with unique context (specific event, specific person, one-time setup)",
  "- Tasks fully handled by an existing skill",
  "- Simple single-step requests",
  "",
  "When proposing, draft the SKILL.md frontmatter and a concise procedure body:",
  "",
  "```",
  "---",
  "name: skill-name-in-kebab-case",
  "description: |",
  "  One or two sentences describing what this skill does.",
  "  Use when: [specific trigger situations].",
  "  Triggers: \"phrase 1\", \"phrase 2\", \"phrase 3\".",
  "allowed-tools: Bash, Read",
  "---",
  "",
  "# Skill Name",
  "",
  "Step-by-step procedure...",
  "```",
  "",
  "Present the draft with a one-line pitch: what it does, why it's worth keeping.",
  "The user approves or discards — never write the file without approval.",
].join("\n");

// -- First-contact notice --------------------------------------------

function buildOnboardingInstructions(
  memberName: string,
  memberAge: number,
  _turnCount: number,
): string {
  return [
    `This is your FIRST conversation with ${memberName}. You don't have a profile for them yet.`,
    "",
    `${memberName} is ${memberAge} years old — match their age and energy.`,
    "",
    "Within the first few messages, mention naturally that you don't have a profile on them yet.",
    `Something like: "By the way, I don't have a profile set up for you yet — it's a quick interview that helps me understand how to help you best. Want to do that sometime? Your parents can set it up from the dashboard."`,
    "",
    "Don't push it. Mention it once, then focus on being helpful. The profile interview",
    "happens through the dashboard, not here in chat. Your job right now is just to be a good conversation partner.",
  ].join("\n");
}

const TASK_COMPLETION_INSTRUCTIONS = [
  "Complete the task and provide a clear result.",
  'Wrap your final deliverable in a <result status="completed"> block.',
  'If you cannot complete the task, use <result status="failed"> and explain why.',
].join(" ");

const TASK_PROGRESS_INSTRUCTIONS =
  'As you work, emit progress markers: <progress step="N" total="M" message="what you\'re doing"/>';

// -- Public API ------------------------------------------------------

/**
 * Build the full system prompt for an agent interaction.
 *
 * Chat mode assembles: role, soul (if present), member intro, constitution,
 * soft rules, and delegation instructions.
 *
 * Task mode assembles: role, task brief, completion instructions,
 * governing rules, and progress markers.
 */
export function compileSystemPrompt(params: CompilePromptParams): string {
  if (params.mode === "task") {
    return compileTaskPrompt(params);
  }
  return compileChatPrompt(params);
}

/**
 * Generate delegation instructions for a personal agent.
 *
 * Lists available specialist agents and explains the <delegate> syntax.
 * Returns an empty string if no edges are provided.
 */
export function buildDelegationInstructions(edges: DelegationEdge[]): string {
  if (edges.length === 0) {
    return "";
  }

  const agentLines = edges.map((edge) => {
    const specialty = edge.specialty ? ` -- ${edge.specialty}` : "";
    return `- **${edge.agentName}** (${edge.staffRole})${specialty}`;
  });

  const parts: string[] = [
    "You can delegate tasks to specialist agents in this household.",
    "",
    "Available specialists:",
    ...agentLines,
    "",
    "To delegate, use this format:",
    "",
    "```",
    `<delegate agent="{agentName}" task="{brief description of what you need}"/>`,
    "```",
    "",
    "Only delegate when the request clearly matches a specialist's domain. If unsure, handle it yourself.",
  ];

  return parts.join("\n");
}

// -- Internal builders -----------------------------------------------

function compileChatPrompt(params: CompilePromptParams): string {
  const {
    roleContent,
    soulContent,
    constitutionDocument,
    softRules,
    memberName,
    memberRole,
    memberAge,
    memberProfile,
    firstContact,
    conversationTurnCount,
    delegationInstructions,
    operatingInstructions,
    ambientMemory,
    memorySchemaInstructions,
  } = params;

  const sections: string[] = [];

  // 0. Current-time grounding — without this the LLM has no idea what time
  // it is or how long the conversation has been idle. Matters for honoring
  // "[time note: Nh since previous message]" markers in history + answering
  // "what time is it" naturally. Triple-stated (abbrev + long + IANA) so
  // the LLM can't misread "EDT" as "Central" or similar.
  const now = new Date();
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clock = now.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const tzShort = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "short",
  }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "";
  const tzLong = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "long",
  }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "";
  sections.push(
    [
      "# Current Time",
      "",
      `${clock} ${tzShort}`,
      `Time zone: **${tzLong}** (${tzShort}, IANA \`${tzName}\`)`,
      "",
      "When the user asks what time it is or how long ago something happened,",
      "answer using this exact time and zone. Do not paraphrase the zone",
      "(e.g. if it says Eastern, do not say Central).",
    ].join("\n"),
  );

  // 1. Family Constitution — THE FRAME (always first)
  if (constitutionDocument) {
    sections.push(`# Family Constitution\n\n${constitutionDocument}`);
  }

  // 1b. Soft rules (behavioral guidelines from constitution clauses)
  if (softRules) {
    sections.push(`# Behavioral Guidelines\n\n${softRules}`);
  }

  // 2. Your Family (household roster — who you serve)
  if (params.householdMembers && params.householdMembers.length > 0) {
    const roster = params.householdMembers
      .map((m) => `- **${m.name}** — ${m.role}, age ${m.age}`)
      .join("\n");
    const heading = params.householdName ? `# ${params.householdName}` : "# Your Family";
    sections.push(`${heading}\n\n${roster}`);
  }

  // 3. Your Role (always present)
  sections.push(`# Your Role\n\n${roleContent}`);

  // 3. Your Personality (skip if null — internal agents won't have one)
  if (soulContent) {
    sections.push(`# Your Personality\n\n${soulContent}`);
  }

  // 4. Operating Instructions (self-maintained behavioral notes)
  if (operatingInstructions) {
    sections.push(`# Operating Instructions\n\n${operatingInstructions}`);
  }

  // 5. About [Member Name] — combined intro line + profile
  if (memberName && memberRole != null && memberAge != null) {
    const introLine = `${memberName} is a ${memberAge}-year-old ${memberRole}.`;

    if (memberProfile) {
      sections.push(`# About ${memberName}\n\n${introLine}\n\n${memberProfile}`);
    } else if (firstContact && memberAge != null) {
      sections.push(
        `# Getting to Know ${memberName}\n\n${introLine}\n\n${buildOnboardingInstructions(memberName, memberAge, conversationTurnCount ?? 0)}`,
      );
    } else {
      sections.push(`# About ${memberName}\n\n${introLine}`);
    }
  }

  // 6. What You Know — ambient memory (recent/relevant entries)
  if (ambientMemory) {
    sections.push(`# What You Know\n\n${ambientMemory}`);
  }

  // 7. How to Use Memory — from memory schema
  if (memorySchemaInstructions) {
    sections.push(`# How to Use Memory\n\n${memorySchemaInstructions}`);
  }

  // 8. Your Capabilities (trust level + skills)
  if (params.trustLevel) {
    const capLines: string[] = [];
    if (params.trustLevel === "full") {
      capLines.push("You have full system access including Bash, Read, Write, Edit, Glob, Grep, WebFetch, and WebSearch.");
      capLines.push("You can run commands, read files, search the web, and investigate errors or issues directly.");
    } else if (params.trustLevel === "standard") {
      capLines.push("You have read-only system access: Read, Glob, Grep, WebFetch, and WebSearch.");
    }
    if (params.enabledSkills && params.enabledSkills.length > 0) {
      const skillList = params.enabledSkills.map((s) => `- ${s}`).join("\n");
      capLines.push(
        `\nYou have access to these installed skills:\n${skillList}\n\n` +
        `Skill loading rules:\n` +
        `- When a request matches or is even partially relevant to a skill, you MUST invoke it using the Skill tool before proceeding.\n` +
        `- Skills contain specialized knowledge — proven workflows, domain-specific commands, and context that outperform general-purpose approaches. Load the skill even if you think you could handle the task with basic tools.\n` +
        `- Err on the side of loading. It is always better to have context you don't need than to miss critical steps, pitfalls, or established workflows.\n` +
        `- Only proceed without invoking a skill if genuinely none are relevant.`
      );
    }
    if (capLines.length > 0) {
      sections.push(`# Your Capabilities\n\n${capLines.join("\n")}`);
    }
  }

  // 9. Skill proposals (full-trust agents only — act, notice, write, reuse)
  if (params.enableSkillProposals && params.trustLevel === "full") {
    sections.push(`# Proposing New Skills\n\n${SKILL_PROPOSAL_INSTRUCTIONS}`);
  }

  // 10. Delegation instructions (personal agents only)
  if (delegationInstructions) {
    sections.push(`# Delegation\n\n${delegationInstructions}`);
  }

  return sections.join("\n\n");
}

function compileTaskPrompt(params: CompilePromptParams): string {
  const { roleContent, taskTitle, taskDescription, softRules } = params;

  const sections: string[] = [];

  // 1. Role
  sections.push(`# Your Role\n\n${roleContent}`);

  // 2. Task brief
  if (taskTitle) {
    const descriptionBlock = taskDescription ? `\n\n${taskDescription}` : "";
    sections.push(
      `# Task\n\nYou are executing: "${taskTitle}"${descriptionBlock}`,
    );
  }

  // 3. Completion instructions
  sections.push(`# Instructions\n\n${TASK_COMPLETION_INSTRUCTIONS}`);

  // 4. Governing rules (soft clauses still apply to task execution)
  if (softRules) {
    sections.push(`# Governing Rules\n\n${softRules}`);
  }

  // 5. Progress markers
  sections.push(`# Progress\n\n${TASK_PROGRESS_INSTRUCTIONS}`);

  return sections.join("\n\n");
}
