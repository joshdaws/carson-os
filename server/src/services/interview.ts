/**
 * Interview Engine -- conversational constitution builder.
 *
 * Guides families through a 5-phase interview process to build
 * their household constitution. Carson asks questions, extracts
 * values and boundaries, and generates a constitution document.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { onboardingState, households, staffAgents } from "@carsonos/db";
import type { OnboardingPhase, RichContent, InterviewPhase } from "@carsonos/shared";
import type { Adapter } from "./subprocess-adapter.js";

// -- Types -----------------------------------------------------------

export interface InterviewEngineConfig {
  db: Db;
  adapter: Adapter;
}

export interface InterviewMessage {
  role: "user" | "assistant";
  content: string;
  richContent?: RichContent;
}

interface InterviewState {
  id: string;
  householdId: string;
  phase: OnboardingPhase;
  interviewMessages: InterviewMessage[];
  extractedClauses: unknown[];
  selectedStaff: unknown[];
}

export interface ExtractedMember {
  name: string;
  age: number;
  role: "parent" | "kid";
}

export interface InterviewResult {
  response: string;
  phase: OnboardingPhase;
  interviewPhase: InterviewPhase;
  constitutionDocument?: string;
  members?: ExtractedMember[];
  richContent?: RichContent;
  questionNumber?: number;
  totalQuestions?: number;
}

// -- Helpers -----------------------------------------------------------

/** Strip all LLM markers ([PHASE:...], [CONSTITUTION_START/END], [MEMBERS_START/END]) */
export function cleanResponse(raw: string): string {
  return raw
    .replace(/\[PHASE:\s*\w+\]/g, "")
    .replace(/\[CONSTITUTION_START\][\s\S]*?\[CONSTITUTION_END\]/g, "")
    .replace(/\[MEMBERS_START\][\s\S]*?\[MEMBERS_END\]/g, "")
    .trim();
}

/** Map a granular interview phase to a step counter position (1-7). Returns undefined for non-counted phases. */
const PHASE_STEP_MAP: Partial<Record<InterviewPhase, number>> = {
  values: 1,
  education: 2,
  boundaries: 3,
  interaction_style: 4,
  privacy: 5,
  schedule: 6,
  escalation: 7,
};
const TOTAL_QUESTIONS = 7;

// -- Phase definitions -----------------------------------------------

const PHASE_ORDER: OnboardingPhase[] = [
  "interview",
  "review",
  "staff_setup",
  "telegram_config",
  "complete",
];

const CONSTITUTION_TEMPLATE = `# [Family Name] Household Constitution
### Governing Principles for AI Agents in the [Family Name] Home

---

## I. Household Profile

| Member | Age | Role |
|--------|-----|------|
[FILL: List each family member with age and role (parent, kid)]

**Household structure:** [FILL: Brief description of the family dynamic]

---

## II. Core Values

[FILL: 3-5 values that should shape how agents interact. Examples: education, independence, kindness, creativity, respect, faith]

---

## III. Education & Learning

- **Homework help approach:** [FILL: Should agents give direct answers, coach through problems, or something else?]
- **Learning philosophy:** [FILL: How should agents support the children's education?]
- **Age-specific notes:** [FILL: Any differences by age group?]

---

## IV. Content Boundaries

- **Topics requiring parent involvement:** [FILL: e.g., dating, finances, health decisions]
- **Off-limits topics:** [FILL: Topics agents should never engage with]
- **Age restrictions:** [FILL: Content rules that differ by age]

---

## V. Interaction Style

- **Tone:** [FILL: How should agents speak? Formal, casual, warm, direct?]
- **Pushback:** [FILL: Should agents challenge the kids or be agreeable?]
- **Encouragement:** [FILL: How should agents handle mistakes or struggles?]

---

## VI. Privacy & Safety

- **Information never shared:** [FILL: Financial details, location, schedules, etc.]
- **External communication:** [FILL: Can agents reference outside sources? Social media?]

---

## VII. Schedule & Availability

- **Protected times:** [FILL: Family dinner, weekends, sabbath, bedtime, etc.]
- **Active hours:** [FILL: When should agents be available vs. offline?]

---

## VIII. Escalation Rules

- **When to notify parents:** [FILL: What situations require parent involvement?]
- **Emergency protocol:** [FILL: What should agents do if a child seems distressed?]

---

## IX. Mission Statement

[FILL: 1-2 sentences synthesized by Carson from the interview. What is the purpose of AI agents in this household?]`;

const INTERVIEW_SYSTEM_PROMPT = `You are the Chief of Staff of a household AI governance system called CarsonOS. You are conducting a structured interview to build the family's household constitution.

Your personality: warm but professional, occasionally dry-witted. Dedicated to the family's wellbeing.

You are filling in a SPECIFIC CONSTITUTION TEMPLATE. The template has these sections, each with [FILL] placeholders:

I. Household Profile (who's in the family)
II. Core Values (what matters most to this family -- could be anything: education, independence, kindness, faith, creativity, respect)
III. Education & Learning (homework help approach, learning philosophy)
IV. Content Boundaries (off-limits topics, age restrictions)
V. Interaction Style (tone, pushback, encouragement)
VI. Privacy & Safety (what's never shared)
VII. Schedule & Availability (protected times)
VIII. Escalation Rules (when to notify parents)
IX. Mission Statement (Carson proposes this based on everything above)

YOUR APPROACH:
- Work through the sections IN ORDER, one at a time
- Ask ONE question per response. Never two. One question, then wait.
- For sections II-VIII: briefly acknowledge their answer, then ask the next question
- Be specific: "What values matter most in your family?" not "Tell me about your family"
- Keep it moving. The whole interview should take 8-12 exchanges.
- For section IX (Mission Statement), DO NOT ask the parent to write it. Instead, propose a 1-2 sentence mission statement based on everything they've told you and ask if it sounds right.
- When you have answers for all sections, generate the completed constitution

SECTION I -- FAMILY ROSTER (special handling):
When the parent tells you about their family, you MUST:
1. Acknowledge the family warmly (e.g., "The Smith household. Here's what I have:")
2. Output a structured member list between [MEMBERS_START] and [MEMBERS_END] markers
3. Use [PHASE: family_basics]
4. Do NOT ask the next question yet. The system will show a confirmation UI. Once confirmed, you will receive "Family confirmed" and should then proceed to section II (values).

PHASE MARKERS (include at the end of every response, on its own line):
[PHASE: family_basics] -- section I (who's in the family). ALWAYS use this when you first receive family info.
[PHASE: values] -- section II (core values)
[PHASE: education] -- section III (education & learning)
[PHASE: boundaries] -- section IV (content boundaries)
[PHASE: interaction_style] -- section V (interaction style)
[PHASE: privacy] -- section VI (privacy & safety)
[PHASE: schedule] -- section VII (schedule & availability)
[PHASE: escalation] -- section VIII (escalation rules)
[PHASE: mission] -- section IX (Carson proposes mission, parent approves)
[PHASE: review_complete] -- all sections filled, constitution generated

MEMBER LIST FORMAT (used for family_basics AND review_complete):
[MEMBERS_START]
name|age|role
(one line per person, role is "parent" for adults or "kid" for children of any age)
[MEMBERS_END]

IMPORTANT: Include ALL mentioned family members, even if age is unknown. Use 0 for unknown ages. The confirmation UI lets the parent edit ages, so missing data is fine. Never omit a person just because their age wasn't provided.

Example:
[MEMBERS_START]
John Smith|42|parent
Jane Smith|40|parent
Emma Smith|14|kid
Liam Smith|8|kid
[MEMBERS_END]

Example with unknown ages:
[MEMBERS_START]
John Smith|0|parent
Jane Smith|0|parent
Emma Smith|14|kid
Liam Smith|0|kid
[MEMBERS_END]

When you reach review_complete, output the COMPLETED constitution between these markers:
[CONSTITUTION_START]
(the completed document)
[CONSTITUTION_END]
Also include the [MEMBERS_START/END] block again at review_complete.

FORMATTING RULES for the constitution document:
- Use proper markdown: ## for section headers, **bold** for emphasis, - for bullet lists
- ALWAYS put a blank line before and after every heading
- ALWAYS put a blank line between paragraphs and before lists
- Use --- between major sections for visual separation
- The document must render cleanly as markdown`;

// -- Engine ----------------------------------------------------------

export class InterviewEngine {
  private db: Db;
  private adapter: Adapter;

  constructor(config: InterviewEngineConfig) {
    this.db = config.db;
    this.adapter = config.adapter;
  }

  async getOrCreateState(householdId: string): Promise<InterviewState> {
    // Check for existing state
    const [existing] = await this.db
      .select()
      .from(onboardingState)
      .where(eq(onboardingState.householdId, householdId))
      .limit(1);

    if (existing) {
      return {
        id: existing.id,
        householdId: existing.householdId,
        phase: existing.phase as OnboardingPhase,
        interviewMessages: (existing.interviewMessages as InterviewMessage[]) ?? [],
        extractedClauses: (existing.extractedClauses as unknown[]) ?? [],
        selectedStaff: (existing.selectedStaff as unknown[]) ?? [],
      };
    }

    // Ensure household exists
    const [household] = await this.db
      .select()
      .from(households)
      .where(eq(households.id, householdId))
      .limit(1);

    if (!household) {
      throw new Error("Household not found");
    }

    // Create new state
    const [state] = await this.db
      .insert(onboardingState)
      .values({
        householdId,
        phase: "interview",
        interviewMessages: [],
        extractedClauses: [],
        selectedStaff: [],
      })
      .returning();

    return {
      id: state.id,
      householdId: state.householdId,
      phase: state.phase as OnboardingPhase,
      interviewMessages: [],
      extractedClauses: [],
      selectedStaff: [],
    };
  }

  async processMessage(
    householdId: string,
    message: string,
  ): Promise<InterviewResult> {
    const state = await this.getOrCreateState(householdId);

    // Build conversation history
    const interviewMessages = [...state.interviewMessages];

    // If first message, inject the hardcoded greeting so the LLM has context
    if (interviewMessages.length === 0) {
      // Look up the head agent name (or fall back to "your Chief of Staff")
      const headAgent = await this.db
        .select({ name: staffAgents.name })
        .from(staffAgents)
        .where(eq(staffAgents.householdId, householdId))
        .limit(1)
        .get();
      const agentName = headAgent?.name ?? "your Chief of Staff";

      interviewMessages.push({
        role: "assistant",
        content: InterviewEngine.greeting(agentName),
      });
    }

    interviewMessages.push({ role: "user", content: message });

    const messagesForLlm = interviewMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Call the adapter
    const result = await this.adapter.execute({
      systemPrompt: INTERVIEW_SYSTEM_PROMPT,
      messages: messagesForLlm,
    });

    const assistantResponse = result.content;

    // Clean the response before saving (remove all markers)
    const cleanedForStorage = cleanResponse(assistantResponse);
    interviewMessages.push({ role: "assistant", content: cleanedForStorage });

    // Parse phase from response
    const phase = this.parsePhase(assistantResponse);

    // Check for constitution document
    let constitutionDocument: string | undefined;
    const docMatch = assistantResponse.match(
      /\[CONSTITUTION_START\]([\s\S]*?)\[CONSTITUTION_END\]/,
    );
    if (docMatch) {
      constitutionDocument = docMatch[1].trim();
    }

    // Check for structured member list
    let members: ExtractedMember[] | undefined;
    const membersMatch = assistantResponse.match(
      /\[MEMBERS_START\]([\s\S]*?)\[MEMBERS_END\]/,
    );
    if (membersMatch) {
      const lines = membersMatch[1].trim().split("\n").filter((l) => l.includes("|"));
      // Skip header line if it looks like "name|age|role"
      const dataLines = lines.filter((l) => !l.toLowerCase().startsWith("name|"));
      members = dataLines
        .map((line) => {
          const [name, ageStr, role] = line.split("|").map((s) => s.trim());
          const age = parseInt(ageStr, 10);
          if (!name || isNaN(age) || !role) return null;
          const validRole = (["parent", "kid"] as const).find((r) => r === role);
          return validRole ? { name, age, role: validRole } : null;
        })
        .filter((m): m is ExtractedMember => m !== null);
    }

    // Map interview phases to OnboardingPhase
    const onboardingPhase = this.mapToOnboardingPhase(phase);

    // Update state
    await this.db
      .update(onboardingState)
      .set({
        phase: onboardingPhase,
        interviewMessages,
        updatedAt: new Date(),
      })
      .where(eq(onboardingState.id, state.id));

    // Build rich content and step counter for the response
    const interviewPhase = phase as InterviewPhase;
    const stepNumber = PHASE_STEP_MAP[interviewPhase];
    let richContent: RichContent | undefined;
    let questionNumber: number | undefined;
    let totalQuestions: number | undefined;

    if (stepNumber !== undefined) {
      questionNumber = stepNumber;
      totalQuestions = TOTAL_QUESTIONS;
      richContent = {
        type: "step_counter",
        questionNumber: stepNumber,
        totalQuestions: TOTAL_QUESTIONS,
      };
    }

    // If we have extracted members at family_basics, attach member confirmation
    if (members && members.length > 0 && phase === "family_basics") {
      richContent = {
        type: "member_confirmation",
        members: members.map((m) => ({ name: m.name, age: m.age, role: m.role })),
        confirmed: false,
      };
    }

    // Store richContent on the last assistant message for resume support
    if (richContent) {
      const lastMsg = interviewMessages[interviewMessages.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        lastMsg.richContent = richContent;
      }
      // Re-save with richContent
      await this.db
        .update(onboardingState)
        .set({
          interviewMessages,
          updatedAt: new Date(),
        })
        .where(eq(onboardingState.id, state.id));
    }

    return {
      response: cleanResponse(assistantResponse),
      phase: onboardingPhase,
      interviewPhase,
      constitutionDocument,
      members,
      richContent,
      questionNumber,
      totalQuestions,
    };
  }

  async generateConstitution(householdId: string): Promise<string> {
    const state = await this.getOrCreateState(householdId);

    if (state.interviewMessages.length === 0) {
      throw new Error("No interview data available to generate a constitution");
    }

    // Build a summary prompt
    const summaryPrompt = `Based on the following family interview, generate a complete household constitution document. The document should include:

1. Family Overview
2. Core Values
3. Content Governance Rules (what's allowed/blocked)
4. Age-Appropriate Boundaries
5. Interaction Style Guidelines
6. Escalation Procedures

Format it as a clear, readable document that a family would be proud to have govern their AI interactions.`;

    const interviewTranscript = state.interviewMessages
      .map(
        (m) =>
          `${m.role === "user" ? "Parent" : "Carson"}: ${m.content}`,
      )
      .join("\n\n");

    const result = await this.adapter.execute({
      systemPrompt: summaryPrompt,
      messages: [
        {
          role: "user",
          content: `Here is the interview transcript:\n\n${interviewTranscript}`,
        },
      ],
    });

    return result.content;
  }

  // -- Private helpers -----------------------------------------------

  static greeting(agentName: string): string {
    return `Welcome. I'm ${agentName}, and I'll be heading up your household staff.\n\nBefore we begin, I'll need to learn a bit about your family so I can set things up properly. Let's start with the basics.\n\nWhat are the names and ages of everyone in the household? Parents and children.`;
  }

  private parsePhase(response: string): string {
    const match = response.match(/\[PHASE:\s*(\w+)\]/);
    return match ? match[1] : "interview";
  }

  private mapToOnboardingPhase(interviewPhase: string): OnboardingPhase {
    switch (interviewPhase) {
      case "family_basics":
      case "values":
      case "education":
      case "boundaries":
      case "interaction_style":
      case "privacy":
      case "schedule":
      case "escalation":
      case "mission":
        return "interview";
      case "review_complete":
        return "review";
      default:
        return "interview";
    }
  }
}
