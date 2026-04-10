/**
 * Profile Interview Engine -- conversational member profile builder.
 *
 * Guides parents (or kids themselves) through a structured interview
 * to build a per-person profile document. The profile tells agents
 * who they're serving: personality, interests, goals, learning style,
 * frustration triggers, and what the family expects.
 *
 * Mirrors the constitution InterviewEngine pattern:
 *   - State persisted in profile_interview_state table
 *   - Adapter-driven (Claude subprocess)
 *   - Phase markers in LLM response
 *   - Profile document extracted between markers
 */

import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { familyMembers, profileInterviewState } from "@carsonos/db";
import type { ProfileInterviewPhase } from "@carsonos/shared";
import type { Adapter } from "./subprocess-adapter.js";

// -- Types -----------------------------------------------------------

export interface ProfileInterviewConfig {
  db: Db;
  adapter: Adapter;
}

interface InterviewMessage {
  role: "user" | "assistant";
  content: string;
}

interface ProfileInterviewStateRow {
  id: string;
  memberId: string;
  phase: ProfileInterviewPhase;
  interviewMessages: InterviewMessage[];
}

export interface ProfileInterviewResult {
  response: string;
  phase: ProfileInterviewPhase;
  profileDocument?: string;
}

// -- System prompt ---------------------------------------------------

function buildProfileSystemPrompt(memberName: string, memberAge: number, memberRole: string): string {
  return `You are Carson, the head butler of a household AI governance system called CarsonOS. You are conducting a structured interview to build a personal profile for ${memberName}.

Your personality: dignified, warm but professional, occasionally dry-witted. A proper English butler who cares about the family he serves.

${memberRole === "parent" ? `You are interviewing a parent about themselves. Ask about their interests, work-life balance, communication preferences, and how they'd like their agent to help.` : `A parent is telling you about their ${memberAge}-year-old ${memberRole === "student" ? "student" : "child"}, ${memberName}. You are building a profile that will help ${memberName}'s personal agent understand and serve them well.`}

You are filling in a PROFILE DOCUMENT for ${memberName}. The profile has these sections:

I. Who They Are (personality, temperament, energy level)
II. Interests & Passions (hobbies, subjects, activities they love)
III. Goals & Aspirations (what they're working toward, what motivates them)
IV. Learning Style (how they learn best, attention patterns, what helps them focus)
V. Boundaries & Triggers (what frustrates them, how to handle pushback, when to back off)
VI. Agent Expectations (what the family wants the agent to help with, what to avoid)

YOUR APPROACH:
- Work through the sections IN ORDER, one at a time
- For each section, ask 1-2 SPECIFIC questions
- Briefly acknowledge their answer, then move to the next section
- Be specific: "What does ${memberName} do when they're frustrated or stuck?" not "Tell me about ${memberName}"
- Keep it moving. The whole interview should take 6-8 exchanges, not 15.
- When you have answers for all sections, generate the completed profile

PHASE MARKERS (include at the end of every response, on its own line):
[PHASE: intro] -- section I (personality, temperament)
[PHASE: personality] -- still on section I, or transitioning to II
[PHASE: interests] -- sections II-III
[PHASE: learning] -- section IV
[PHASE: boundaries] -- sections V-VI
[PHASE: review_complete] -- all sections filled, profile generated

When you reach review_complete, output the COMPLETED profile between these markers:
[PROFILE_START]
# About ${memberName}

## Personality & Temperament
(filled from interview)

## Interests & Passions
(filled from interview)

## Goals & Aspirations
(filled from interview)

## Learning Style
(filled from interview)

## Boundaries & Triggers
(filled from interview)

## What the Agent Should Do
(filled from interview)
[PROFILE_END]`;
}

// -- Engine ----------------------------------------------------------

export class ProfileInterviewEngine {
  private db: Db;
  private adapter: Adapter;

  constructor(config: ProfileInterviewConfig) {
    this.db = config.db;
    this.adapter = config.adapter;
  }

  async getOrCreateState(memberId: string): Promise<ProfileInterviewStateRow> {
    const [existing] = await this.db
      .select()
      .from(profileInterviewState)
      .where(eq(profileInterviewState.memberId, memberId))
      .limit(1);

    if (existing) {
      return {
        id: existing.id,
        memberId: existing.memberId,
        phase: existing.phase as ProfileInterviewPhase,
        interviewMessages: (existing.interviewMessages as InterviewMessage[]) ?? [],
      };
    }

    // Verify member exists
    const [member] = await this.db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, memberId))
      .limit(1);

    if (!member) {
      throw new Error("Family member not found");
    }

    const [state] = await this.db
      .insert(profileInterviewState)
      .values({
        memberId,
        phase: "intro",
        interviewMessages: [],
      })
      .returning();

    return {
      id: state.id,
      memberId: state.memberId,
      phase: state.phase as ProfileInterviewPhase,
      interviewMessages: [],
    };
  }

  async processMessage(
    memberId: string,
    message: string,
  ): Promise<ProfileInterviewResult> {
    const state = await this.getOrCreateState(memberId);

    // Load member info for the system prompt
    const [member] = await this.db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, memberId))
      .limit(1);

    if (!member) {
      throw new Error("Family member not found");
    }

    // Build conversation history
    const interviewMessages = [...state.interviewMessages];

    // If first message, inject the hardcoded greeting so the LLM has context
    if (interviewMessages.length === 0) {
      interviewMessages.push({
        role: "assistant",
        content: ProfileInterviewEngine.greeting(member.name),
      });
    }

    interviewMessages.push({ role: "user", content: message });

    const messagesForLlm = interviewMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Call the adapter
    const systemPrompt = buildProfileSystemPrompt(member.name, member.age, member.role);
    const result = await this.adapter.execute({
      systemPrompt,
      messages: messagesForLlm,
    });

    const assistantResponse = result.content;

    // Clean response before saving (remove phase/profile markers)
    const cleanedForStorage = assistantResponse
      .replace(/\[PHASE:\s*\w+\]/g, "")
      .replace(/\[PROFILE_START\][\s\S]*?\[PROFILE_END\]/g, "")
      .trim();
    interviewMessages.push({ role: "assistant", content: cleanedForStorage });

    // Parse phase from response
    const phase = this.parsePhase(assistantResponse);

    // Check for profile document
    let profileDocument: string | undefined;
    const docMatch = assistantResponse.match(
      /\[PROFILE_START\]([\s\S]*?)\[PROFILE_END\]/,
    );
    if (docMatch) {
      profileDocument = docMatch[1].trim();
    }

    // Map to ProfileInterviewPhase
    const mappedPhase = this.mapPhase(phase);

    // Update interview state
    await this.db
      .update(profileInterviewState)
      .set({
        phase: mappedPhase,
        interviewMessages,
        updatedAt: new Date(),
      })
      .where(eq(profileInterviewState.id, state.id));

    // If profile document was generated, save it to the member record
    if (profileDocument) {
      await this.db
        .update(familyMembers)
        .set({
          profileContent: profileDocument,
          profileUpdatedAt: new Date(),
        })
        .where(eq(familyMembers.id, memberId));
    }

    // Clean the response for the user
    const cleanResponse = assistantResponse
      .replace(/\[PHASE:\s*\w+\]/g, "")
      .replace(/\[PROFILE_START\][\s\S]*?\[PROFILE_END\]/g, "")
      .trim();

    return {
      response: cleanResponse,
      phase: mappedPhase,
      profileDocument,
    };
  }

  static greeting(memberName: string): string {
    return `Good, let's build a profile for ${memberName}. I'll ask a few questions to understand who they are so their agent can serve them well.\n\nLet's start with personality and temperament — how would you describe ${memberName}? Are they more energetic or reserved? Outgoing or introspective?`;
  }

  async resetInterview(memberId: string): Promise<void> {
    // Delete existing interview state so it starts fresh
    await this.db
      .delete(profileInterviewState)
      .where(eq(profileInterviewState.memberId, memberId));
  }

  // -- Private helpers -----------------------------------------------

  private parsePhase(response: string): string {
    const match = response.match(/\[PHASE:\s*(\w+)\]/);
    return match ? match[1] : "intro";
  }

  private mapPhase(rawPhase: string): ProfileInterviewPhase {
    switch (rawPhase) {
      case "intro":
      case "personality":
      case "interests":
      case "learning":
      case "boundaries":
        return rawPhase;
      case "review_complete":
        return "review_complete";
      default:
        return "intro";
    }
  }
}
