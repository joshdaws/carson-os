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
}

export interface DelegationEdge {
  agentId: string;
  agentName: string;
  staffRole: string;
  specialty: string | null;
}

// -- Constants -------------------------------------------------------

// Threshold: after this many assistant turns in onboarding, ask agent to compile
const ONBOARDING_COMPILE_THRESHOLD = 3;

// -- First-contact onboarding ----------------------------------------

function buildOnboardingInstructions(
  memberName: string,
  memberAge: number,
  turnCount: number,
): string {
  const readyToCompile = turnCount >= ONBOARDING_COMPILE_THRESHOLD;

  const parts: string[] = [
    `This is your FIRST conversation with ${memberName}. You don't have a profile for them yet.`,
    "",
    "Your job right now is to get to know them. Be warm and casual. Match their age.",
    `${memberName} is ${memberAge} years old, so talk to them at that level.`,
    "",
    "Naturally learn about:",
    "- What they're into (hobbies, games, subjects, activities)",
    "- How they like to learn or be helped",
    "- What they're working on or excited about",
    "- What frustrates them or what they'd rather not deal with",
    "",
    "Don't interrogate. Have a real conversation. Share a bit about yourself too.",
    "Ask one or two questions at a time, not a list.",
  ];

  if (readyToCompile) {
    parts.push(
      "",
      "You've had enough conversation to build a basic profile now.",
      `At the END of your next response, compile what you've learned about ${memberName} into a profile document.`,
      "Place it between these exact markers (the user won't see this part):",
      "",
      "[PROFILE_START]",
      `# About ${memberName}`,
      "",
      "## Personality & Temperament",
      "(what you've observed)",
      "",
      "## Interests & Passions",
      "(what they told you about)",
      "",
      "## Goals & Aspirations",
      "(what they're working toward, if mentioned)",
      "",
      "## Learning Style",
      "(how they seem to prefer help)",
      "",
      "## What the Agent Should Do",
      "(your best guess at how to help them, based on the conversation)",
      "[PROFILE_END]",
      "",
      "Keep chatting normally above the markers. The profile is extracted automatically.",
    );
  }

  return parts.join("\n");
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
  } = params;

  const sections: string[] = [];

  // 1. Role (always present)
  sections.push(`# Your Role\n\n${roleContent}`);

  // 2. Soul (skip if null -- internal agents won't have one)
  if (soulContent) {
    sections.push(`# Your Personality\n\n${soulContent}`);
  }

  // 3. Member intro
  if (memberName && memberRole != null && memberAge != null) {
    sections.push(
      `# Who You're Talking To\n\n${memberName} is a ${memberAge}-year-old ${memberRole}.`,
    );
  }

  // 3b. First-contact onboarding (no profile yet, new conversation)
  if (firstContact && !memberProfile && memberName && memberAge != null) {
    sections.push(
      `# Getting to Know ${memberName}\n\n${buildOnboardingInstructions(memberName, memberAge, conversationTurnCount ?? 0)}`,
    );
  }

  // 3c. Member profile (detailed knowledge about this person)
  if (memberProfile) {
    sections.push(`# About ${memberName ?? "This Person"}\n\n${memberProfile}`);
  }

  // 4. Constitution document
  if (constitutionDocument) {
    sections.push(`# Family Constitution\n\n${constitutionDocument}`);
  }

  // 5. Soft rules
  if (softRules) {
    sections.push(`# Behavioral Guidelines\n\n${softRules}`);
  }

  // 6. Delegation instructions (personal agents only)
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
