import { describe, it, expect } from "vitest";
import {
  compileSystemPrompt,
  buildDelegationInstructions,
} from "../prompt-compiler.js";

describe("compileSystemPrompt", () => {
  describe("chat mode", () => {
    it("includes role and soul content", () => {
      const prompt = compileSystemPrompt({
        mode: "chat",
        roleContent: "You are a personal assistant for Grant.",
        soulContent: "Be warm, encouraging, and use humor.",
        softRules: "",
        constitutionDocument: "",
        memberName: "Grant",
        memberRole: "student",
        memberAge: 17,
      });

      expect(prompt).toContain("personal assistant for Grant");
      expect(prompt).toContain("warm, encouraging");
      expect(prompt).toContain("Grant");
      expect(prompt).toContain("17");
    });

    it("omits soul section when soulContent is null", () => {
      const prompt = compileSystemPrompt({
        mode: "chat",
        roleContent: "You are a tutor.",
        soulContent: null,
        softRules: "",
        constitutionDocument: "",
        memberName: "Ethan",
        memberRole: "child",
        memberAge: 12,
      });

      expect(prompt).toContain("tutor");
      expect(prompt).not.toContain("Personality");
    });

    it("includes constitution document when present", () => {
      const prompt = compileSystemPrompt({
        mode: "chat",
        roleContent: "You are a coach.",
        soulContent: "Be energetic.",
        softRules: "",
        constitutionDocument: "Our family values hard work and kindness.",
        memberName: "Huddy",
        memberRole: "student",
        memberAge: 15,
      });

      expect(prompt).toContain("hard work and kindness");
    });

    it("includes delegation instructions for personal agents", () => {
      const prompt = compileSystemPrompt({
        mode: "chat",
        roleContent: "You are Grant's personal assistant.",
        soulContent: "Friendly and direct.",
        softRules: "",
        constitutionDocument: "",
        memberName: "Grant",
        memberRole: "student",
        memberAge: 17,
        delegationInstructions: "Available specialists:\n- Tutor: academic help",
      });

      expect(prompt).toContain("specialists");
      expect(prompt).toContain("Tutor");
    });

    it("omits delegation section when null", () => {
      const prompt = compileSystemPrompt({
        mode: "chat",
        roleContent: "You are a tutor.",
        soulContent: "Patient.",
        softRules: "",
        constitutionDocument: "",
        memberName: "Ethan",
        memberRole: "child",
        memberAge: 12,
        delegationInstructions: null,
      });

      expect(prompt).not.toContain("Delegation");
    });

    it("includes member profile in combined About section", () => {
      const prompt = compileSystemPrompt({
        mode: "chat",
        roleContent: "You are Claire's personal assistant.",
        soulContent: "Warm and playful.",
        softRules: "",
        constitutionDocument: "Family values: kindness first.",
        memberName: "Claire",
        memberRole: "child",
        memberAge: 6,
        memberProfile: "Claire loves art and dinosaurs. She learns best through stories.",
      });

      expect(prompt).toContain("About Claire");
      expect(prompt).toContain("loves art and dinosaurs");
      // Constitution should come first (THE FRAME), then role, then about
      const constitutionIdx = prompt.indexOf("Family Constitution");
      const roleIdx = prompt.indexOf("Your Role");
      const aboutIdx = prompt.indexOf("About Claire");
      expect(constitutionIdx).toBeLessThan(roleIdx);
      expect(roleIdx).toBeLessThan(aboutIdx);
    });

    it("shows basic intro when memberProfile is null (no profile details)", () => {
      const prompt = compileSystemPrompt({
        mode: "chat",
        roleContent: "You are a tutor.",
        soulContent: "Patient.",
        softRules: "",
        constitutionDocument: "",
        memberName: "Grant",
        memberRole: "student",
        memberAge: 17,
        memberProfile: null,
      });

      // About section exists with just the intro line
      expect(prompt).toContain("About Grant");
      expect(prompt).toContain("17-year-old");
    });

    it("injects first-contact onboarding when no profile and firstContact is true", () => {
      const prompt = compileSystemPrompt({
        mode: "chat",
        roleContent: "You are Claire's personal assistant.",
        soulContent: "Warm and playful.",
        softRules: "",
        constitutionDocument: "",
        memberName: "Claire",
        memberRole: "child",
        memberAge: 6,
        memberProfile: null,
        firstContact: true,
        conversationTurnCount: 0,
      });

      expect(prompt).toContain("Getting to Know Claire");
      expect(prompt).toContain("FIRST conversation");
      // Combined intro: age is in the intro line
      expect(prompt).toContain("6-year-old");
      // Should NOT include profile compilation instructions yet (0 turns)
      expect(prompt).not.toContain("PROFILE_START");
    });

    it("includes profile compilation markers after enough onboarding turns", () => {
      const prompt = compileSystemPrompt({
        mode: "chat",
        roleContent: "You are Ethan's personal assistant.",
        soulContent: "Chill and direct.",
        softRules: "",
        constitutionDocument: "",
        memberName: "Ethan",
        memberRole: "student",
        memberAge: 12,
        memberProfile: null,
        firstContact: true,
        conversationTurnCount: 4,
      });

      expect(prompt).toContain("Getting to Know Ethan");
      expect(prompt).toContain("PROFILE_START");
      expect(prompt).toContain("PROFILE_END");
      expect(prompt).toContain("compile what you've learned");
    });

    it("skips onboarding when member already has a profile", () => {
      const prompt = compileSystemPrompt({
        mode: "chat",
        roleContent: "You are Grant's personal assistant.",
        soulContent: "Friendly.",
        softRules: "",
        constitutionDocument: "",
        memberName: "Grant",
        memberRole: "student",
        memberAge: 17,
        memberProfile: "Grant loves coding and basketball.",
        firstContact: true,
        conversationTurnCount: 0,
      });

      expect(prompt).not.toContain("Getting to Know");
      expect(prompt).toContain("About Grant");
      expect(prompt).toContain("loves coding");
    });

    it("skips onboarding when firstContact is false", () => {
      const prompt = compileSystemPrompt({
        mode: "chat",
        roleContent: "You are Claire's personal assistant.",
        soulContent: "Warm.",
        softRules: "",
        constitutionDocument: "",
        memberName: "Claire",
        memberRole: "child",
        memberAge: 6,
        memberProfile: null,
        firstContact: false,
      });

      expect(prompt).not.toContain("Getting to Know");
    });

    it("includes operating instructions when provided", () => {
      const prompt = compileSystemPrompt({
        mode: "chat",
        roleContent: "You are Josh's personal assistant.",
        soulContent: "Professional.",
        softRules: "",
        constitutionDocument: "",
        memberName: "Josh",
        memberRole: "parent",
        memberAge: 38,
        operatingInstructions: "- Josh prefers bullet points\n- Never suggest pork recipes",
      });

      expect(prompt).toContain("Operating Instructions");
      expect(prompt).toContain("bullet points");
    });

    it("includes ambient memory in What You Know section", () => {
      const prompt = compileSystemPrompt({
        mode: "chat",
        roleContent: "You are Grant's personal assistant.",
        soulContent: "Friendly.",
        softRules: "",
        constitutionDocument: "",
        memberName: "Grant",
        memberRole: "kid",
        memberAge: 17,
        ambientMemory: "Grant has soccer practice Tuesdays at 5pm.\nGrant's favorite subject is history.",
      });

      expect(prompt).toContain("What You Know");
      expect(prompt).toContain("soccer practice");
    });

    it("includes memory schema instructions", () => {
      const prompt = compileSystemPrompt({
        mode: "chat",
        roleContent: "You are a personal assistant.",
        soulContent: "Helpful.",
        softRules: "",
        constitutionDocument: "",
        memorySchemaInstructions: "Use search_memory to find relevant memories.",
      });

      expect(prompt).toContain("How to Use Memory");
      expect(prompt).toContain("search_memory");
    });

    it("puts constitution before role before about in final order", () => {
      const prompt = compileSystemPrompt({
        mode: "chat",
        roleContent: "You are a personal assistant.",
        soulContent: "Warm.",
        softRules: "",
        constitutionDocument: "We value kindness.",
        memberName: "Josh",
        memberRole: "parent",
        memberAge: 38,
        operatingInstructions: "Use bullet points.",
        ambientMemory: "Josh likes coffee.",
        memorySchemaInstructions: "Use save_memory.",
      });

      const order = [
        prompt.indexOf("Family Constitution"),
        prompt.indexOf("Your Role"),
        prompt.indexOf("Your Personality"),
        prompt.indexOf("Operating Instructions"),
        prompt.indexOf("About Josh"),
        prompt.indexOf("What You Know"),
        prompt.indexOf("How to Use Memory"),
      ];

      // Each section should come after the previous one
      for (let i = 1; i < order.length; i++) {
        expect(order[i]).toBeGreaterThan(order[i - 1]);
      }
    });
  });

  describe("task mode", () => {
    it("includes role and task instructions, omits soul", () => {
      const prompt = compileSystemPrompt({
        mode: "task",
        roleContent: "You create study plans and practice problems.",
        soulContent: "This should be ignored in task mode.",
        softRules: "",
        constitutionDocument: "",
        taskTitle: "Create Study Plan",
        taskDescription: "Make a study plan for Grant's history test on chapters 12-14.",
      });

      expect(prompt).toContain("study plans");
      expect(prompt).toContain("Create Study Plan");
      expect(prompt).toContain("chapters 12-14");
      expect(prompt).not.toContain("Personality");
      expect(prompt).toContain("<result");
      expect(prompt).toContain("<progress");
    });

    it("includes soft rules when present", () => {
      const prompt = compileSystemPrompt({
        mode: "task",
        roleContent: "You are a scheduler.",
        soulContent: null,
        softRules: "Never schedule events during church on Sunday.",
        constitutionDocument: "",
        taskTitle: "Block Study Time",
        taskDescription: "Block Wed and Thu evenings for study.",
      });

      expect(prompt).toContain("church on Sunday");
    });
  });
});

describe("buildDelegationInstructions", () => {
  it("generates instructions with specialist list", () => {
    const instructions = buildDelegationInstructions([
      { agentId: "abc", agentName: "Ms. Hughes", staffRole: "tutor", specialty: "academics" },
      { agentId: "def", agentName: "Mr. Barrow", staffRole: "coach", specialty: "athletics" },
    ]);

    expect(instructions).toContain("Ms. Hughes");
    expect(instructions).toContain("tutor");
    expect(instructions).toContain("Mr. Barrow");
    expect(instructions).toContain("coach");
    expect(instructions).toContain("<delegate");
    expect(instructions).toContain("Only delegate when");
  });

  it("returns empty string for empty edges", () => {
    const instructions = buildDelegationInstructions([]);
    expect(instructions).toBe("");
  });
});
