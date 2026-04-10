/**
 * Personality Interview Engine -- conversational agent soul builder.
 *
 * Guides the user through a structured interview to define an agent's
 * personality, tone, humor style, boundaries, and communication style.
 * The resulting "soul document" is injected into every system prompt.
 *
 * Mirrors the ProfileInterviewEngine pattern:
 *   - State persisted in personality_interview_state table
 *   - Adapter-driven (Claude subprocess)
 *   - Phase markers in LLM response
 *   - Soul document extracted between markers
 */

import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { staffAgents, personalityInterviewState } from "@carsonos/db";
import type { PersonalityInterviewPhase } from "@carsonos/shared";
import type { Adapter } from "./subprocess-adapter.js";

// -- Types -----------------------------------------------------------

export interface PersonalityInterviewConfig {
  db: Db;
  adapter: Adapter;
}

interface InterviewMessage {
  role: "user" | "assistant";
  content: string;
}

interface PersonalityInterviewStateRow {
  id: string;
  agentId: string;
  phase: PersonalityInterviewPhase;
  interviewMessages: InterviewMessage[];
}

export interface PersonalityInterviewResult {
  response: string;
  phase: PersonalityInterviewPhase;
  soulDocument?: string;
}

// -- System prompt ---------------------------------------------------

function buildPersonalitySystemPrompt(agentName: string, agentRole: string): string {
  return `You are helping a family configure the personality of their AI agent named ${agentName} (role: ${agentRole}). You are conducting a structured interview to build a "soul document" — the personality profile that shapes how ${agentName} communicates.

Your approach: friendly, collaborative, and specific. You're helping them craft something personal. Use examples to illustrate options.

The soul document has these sections:

I. Voice & Tone (formal vs casual, warm vs crisp, how they address people)
II. Humor & Personality (dry wit, playful, serious, pop culture references)
III. Communication Style (concise vs detailed, bullet points vs paragraphs, proactive vs reactive)
IV. Boundaries & Guardrails (topics to avoid, sensitivity, when to escalate)
V. Special Touches (catchphrases, sign-offs, cultural references, unique personality traits)

YOUR APPROACH:
- Work through the sections IN ORDER, one at a time
- For each section, ask 1-2 SPECIFIC questions with concrete examples
- Briefly acknowledge their answer, then move to the next section
- Be specific: "Should ${agentName} use humor? Like dry wit ('I see you've opted for the ambitious approach') or more playful?" not "What personality should they have?"
- Keep it moving. The whole interview should take 6-8 exchanges, not 15.
- When you have answers for all sections, generate the completed soul document

PHASE MARKERS (include at the end of every response, on its own line):
[PHASE: intro] -- warming up, explaining the process
[PHASE: voice] -- section I (voice & tone)
[PHASE: humor] -- section II (humor & personality)
[PHASE: boundaries] -- sections III-IV (communication style & boundaries)
[PHASE: style] -- section V (special touches)
[PHASE: review_complete] -- all sections filled, soul document generated

When you reach review_complete, output the COMPLETED soul document between these markers:
[SOUL_START]
# ${agentName}'s Personality

## Voice & Tone
(filled from interview)

## Humor & Personality
(filled from interview)

## Communication Style
(filled from interview)

## Boundaries & Guardrails
(filled from interview)

## Special Touches
(filled from interview)
[SOUL_END]`;
}

// -- Engine ----------------------------------------------------------

export class PersonalityInterviewEngine {
  private db: Db;
  private adapter: Adapter;

  constructor(config: PersonalityInterviewConfig) {
    this.db = config.db;
    this.adapter = config.adapter;
  }

  async getOrCreateState(agentId: string): Promise<PersonalityInterviewStateRow> {
    const [existing] = await this.db
      .select()
      .from(personalityInterviewState)
      .where(eq(personalityInterviewState.agentId, agentId))
      .limit(1);

    if (existing) {
      return {
        id: existing.id,
        agentId: existing.agentId,
        phase: existing.phase as PersonalityInterviewPhase,
        interviewMessages: (existing.interviewMessages as InterviewMessage[]) ?? [],
      };
    }

    // Verify agent exists
    const [agent] = await this.db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, agentId))
      .limit(1);

    if (!agent) {
      throw new Error("Staff agent not found");
    }

    const [state] = await this.db
      .insert(personalityInterviewState)
      .values({
        agentId,
        phase: "intro",
        interviewMessages: [],
      })
      .returning();

    return {
      id: state.id,
      agentId: state.agentId,
      phase: state.phase as PersonalityInterviewPhase,
      interviewMessages: [],
    };
  }

  async processMessage(
    agentId: string,
    message: string,
  ): Promise<PersonalityInterviewResult> {
    const state = await this.getOrCreateState(agentId);

    // Load agent info for the system prompt
    const [agent] = await this.db
      .select()
      .from(staffAgents)
      .where(eq(staffAgents.id, agentId))
      .limit(1);

    if (!agent) {
      throw new Error("Staff agent not found");
    }

    // Build conversation history
    const interviewMessages = [...state.interviewMessages];

    // If first message, inject the hardcoded greeting so the LLM has context
    if (interviewMessages.length === 0) {
      interviewMessages.push({
        role: "assistant",
        content: PersonalityInterviewEngine.greeting(agent.name),
      });
    }

    interviewMessages.push({ role: "user", content: message });

    const messagesForLlm = interviewMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Call the adapter
    const systemPrompt = buildPersonalitySystemPrompt(agent.name, agent.staffRole);
    const result = await this.adapter.execute({
      systemPrompt,
      messages: messagesForLlm,
    });

    const assistantResponse = result.content;

    // Clean response before saving (remove phase/soul markers)
    const cleanedForStorage = assistantResponse
      .replace(/\[PHASE:\s*\w+\]/g, "")
      .replace(/\[SOUL_START\][\s\S]*?\[SOUL_END\]/g, "")
      .trim();
    interviewMessages.push({ role: "assistant", content: cleanedForStorage });

    // Parse phase from response
    const phase = this.parsePhase(assistantResponse);

    // Check for soul document
    let soulDocument: string | undefined;
    const docMatch = assistantResponse.match(
      /\[SOUL_START\]([\s\S]*?)\[SOUL_END\]/,
    );
    if (docMatch) {
      soulDocument = docMatch[1].trim();
    }

    // Map to PersonalityInterviewPhase
    const mappedPhase = this.mapPhase(phase);

    // Update interview state
    await this.db
      .update(personalityInterviewState)
      .set({
        phase: mappedPhase,
        interviewMessages,
        updatedAt: new Date(),
      })
      .where(eq(personalityInterviewState.id, state.id));

    // If soul document was generated, save it to the agent record
    if (soulDocument) {
      await this.db
        .update(staffAgents)
        .set({
          soulContent: soulDocument,
          updatedAt: new Date(),
        })
        .where(eq(staffAgents.id, agentId));
    }

    // Clean the response for the user
    const cleanResponse = assistantResponse
      .replace(/\[PHASE:\s*\w+\]/g, "")
      .replace(/\[SOUL_START\][\s\S]*?\[SOUL_END\]/g, "")
      .trim();

    return {
      response: cleanResponse,
      phase: mappedPhase,
      soulDocument,
    };
  }

  static greeting(agentName: string): string {
    return `Let's define ${agentName}'s personality. I'll walk you through five areas: voice & tone, humor, communication style, boundaries, and any special touches.\n\nFirst up — voice and tone. Should ${agentName} be formal or casual? Warm and friendly, or more crisp and professional?`;
  }

  async resetInterview(agentId: string): Promise<void> {
    await this.db
      .delete(personalityInterviewState)
      .where(eq(personalityInterviewState.agentId, agentId));
  }

  // -- Private helpers -----------------------------------------------

  private parsePhase(response: string): string {
    const match = response.match(/\[PHASE:\s*(\w+)\]/);
    return match ? match[1] : "intro";
  }

  private mapPhase(rawPhase: string): PersonalityInterviewPhase {
    switch (rawPhase) {
      case "intro":
      case "voice":
      case "humor":
      case "boundaries":
      case "style":
        return rawPhase;
      case "review_complete":
        return "review_complete";
      default:
        return "intro";
    }
  }
}
