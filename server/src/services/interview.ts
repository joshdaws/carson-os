/**
 * Interview Engine -- conversational constitution builder.
 *
 * Guides families through a 5-phase interview process to build
 * their household constitution. Carson asks questions, extracts
 * values and boundaries, and generates a constitution document.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { onboardingState, households } from "@carsonos/db";
import type { OnboardingPhase } from "@carsonos/shared";
import type { Adapter } from "./subprocess-adapter.js";

// -- Types -----------------------------------------------------------

export interface InterviewEngineConfig {
  db: Db;
  adapter: Adapter;
}

interface InterviewMessage {
  role: "user" | "assistant";
  content: string;
}

interface InterviewState {
  id: string;
  householdId: string;
  phase: OnboardingPhase;
  interviewMessages: InterviewMessage[];
  extractedClauses: unknown[];
  selectedStaff: unknown[];
}

export interface InterviewResult {
  response: string;
  phase: OnboardingPhase;
  constitutionDocument?: string;
}

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
[FILL: List each family member with age and role (parent, student, child)]

**Household structure:** [FILL: Brief description of the family dynamic]

---

## II. Mission Statement

[FILL: 1-2 sentences. What is the purpose of AI agents in this household? What outcome does the family want?]

---

## III. Core Values

[FILL: 3-5 values that should shape how agents interact. Examples: faith tradition, education philosophy, independence, respect for authority, creativity]

---

## IV. Education & Learning

- **Homework help approach:** [FILL: Should agents give direct answers, coach through problems, or something else?]
- **Learning philosophy:** [FILL: How should agents support the children's education?]
- **Age-specific notes:** [FILL: Any differences by age group?]

---

## V. Content Boundaries

- **Topics requiring parent involvement:** [FILL: e.g., dating, finances, health decisions]
- **Off-limits topics:** [FILL: Topics agents should never engage with]
- **Age restrictions:** [FILL: Content rules that differ by age]

---

## VI. Interaction Style

- **Tone:** [FILL: How should agents speak? Formal, casual, warm, direct?]
- **Pushback:** [FILL: Should agents challenge the kids or be agreeable?]
- **Encouragement:** [FILL: How should agents handle mistakes or struggles?]

---

## VII. Privacy & Safety

- **Information never shared:** [FILL: Financial details, location, schedules, etc.]
- **External communication:** [FILL: Can agents reference outside sources? Social media?]

---

## VIII. Schedule & Availability

- **Protected times:** [FILL: Family dinner, weekends, sabbath, bedtime, etc.]
- **Active hours:** [FILL: When should agents be available vs. offline?]

---

## IX. Escalation Rules

- **When to notify parents:** [FILL: What situations require parent involvement?]
- **Emergency protocol:** [FILL: What should agents do if a child seems distressed?]`;

const INTERVIEW_SYSTEM_PROMPT = `You are Carson, the head butler of a household AI governance system called CarsonOS. You are conducting a structured interview to build the family's household constitution.

Your personality: dignified, warm but professional, occasionally dry-witted. A proper English butler who cares about the family he serves.

You are filling in a SPECIFIC CONSTITUTION TEMPLATE. The template has these sections, each with [FILL] placeholders:

I. Household Profile (who's in the family)
II. Mission Statement (purpose of AI in the home)
III. Core Values (faith, education philosophy, etc.)
IV. Education & Learning (homework help approach, learning philosophy)
V. Content Boundaries (off-limits topics, age restrictions)
VI. Interaction Style (tone, pushback, encouragement)
VII. Privacy & Safety (what's never shared)
VIII. Schedule & Availability (protected times)
IX. Escalation Rules (when to notify parents)

YOUR APPROACH:
- Work through the sections IN ORDER, one at a time
- For each section, ask 1-2 SPECIFIC questions to fill in the placeholders
- Briefly acknowledge their answer, then move to the next section
- Don't ask open-ended "tell me about your family" questions. Be specific: "How many children do you have, and what are their names and ages?"
- Keep it moving. The whole interview should take 8-10 exchanges, not 20.
- When you have answers for all sections, generate the completed constitution

PHASE MARKERS (include at the end of every response, on its own line):
[PHASE: family_basics] -- sections I-II
[PHASE: values] -- section III
[PHASE: boundaries] -- sections IV-V
[PHASE: interaction_style] -- sections VI-VII
[PHASE: schedule] -- sections VIII-IX
[PHASE: review_complete] -- all sections filled, constitution generated

When you reach review_complete, output the COMPLETED constitution (all [FILL] placeholders replaced with real answers) between these markers:
[CONSTITUTION_START]
(the completed document)
[CONSTITUTION_END]`;

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
    interviewMessages.push({ role: "user", content: message });

    // If this is the first message, add an initial greeting context
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

    // Clean the response before saving (remove phase/constitution markers)
    const cleanedForStorage = assistantResponse
      .replace(/\[PHASE:\s*\w+\]/g, "")
      .replace(/\[CONSTITUTION_START\][\s\S]*?\[CONSTITUTION_END\]/g, "")
      .trim();
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

    // Clean the response (remove phase markers and constitution markers)
    const cleanResponse = assistantResponse
      .replace(/\[PHASE:\s*\w+\]/g, "")
      .replace(/\[CONSTITUTION_START\][\s\S]*?\[CONSTITUTION_END\]/g, "")
      .trim();

    return {
      response: cleanResponse,
      phase: onboardingPhase,
      constitutionDocument,
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

  private parsePhase(response: string): string {
    const match = response.match(/\[PHASE:\s*(\w+)\]/);
    return match ? match[1] : "interview";
  }

  private mapToOnboardingPhase(interviewPhase: string): OnboardingPhase {
    switch (interviewPhase) {
      case "family_basics":
      case "values":
      case "boundaries":
      case "interaction_style":
      case "schedule":
        return "interview";
      case "review_complete":
        return "review";
      default:
        return "interview";
    }
  }
}
