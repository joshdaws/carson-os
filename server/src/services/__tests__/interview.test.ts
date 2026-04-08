import { describe, it, expect } from "vitest";
import { cleanResponse } from "../interview.js";

// -- cleanResponse -------------------------------------------------------

describe("cleanResponse", () => {
  it("1. removes [PHASE: xxx] markers", () => {
    const raw = "Here is your answer.\n[PHASE: family_basics]";
    expect(cleanResponse(raw)).toBe("Here is your answer.");
  });

  it("2. removes constitution markers and content", () => {
    const raw = "Here is the result.\n[CONSTITUTION_START]\n# My Doc\n[CONSTITUTION_END]\nDone.";
    expect(cleanResponse(raw)).toBe("Here is the result.\n\nDone.");
  });

  it("3. removes members markers and content", () => {
    const raw = "Got it.\n[MEMBERS_START]\nJosh|40|parent\nBecca|38|parent\n[MEMBERS_END]";
    expect(cleanResponse(raw)).toBe("Got it.");
  });

  it("4. handles all markers in one response", () => {
    const raw = [
      "Your constitution is ready.",
      "[CONSTITUTION_START]# Doc[CONSTITUTION_END]",
      "[MEMBERS_START]Josh|40|parent[MEMBERS_END]",
      "[PHASE: review_complete]",
    ].join("\n");
    expect(cleanResponse(raw)).toBe("Your constitution is ready.");
  });

  it("5. trims whitespace", () => {
    const raw = "   Hello.   [PHASE: values]   ";
    expect(cleanResponse(raw)).toBe("Hello.");
  });

  it("6. returns plain text unchanged", () => {
    const raw = "Tell me about your family.";
    expect(cleanResponse(raw)).toBe("Tell me about your family.");
  });

  it("7. handles empty string", () => {
    expect(cleanResponse("")).toBe("");
  });

  it("8. handles multiple phase markers (takes last)", () => {
    const raw = "Answer.\n[PHASE: values]\n[PHASE: education]";
    expect(cleanResponse(raw)).toBe("Answer.");
  });
});
