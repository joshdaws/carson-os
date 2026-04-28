/**
 * Tests for the validation predicates exported from conversations.ts.
 *
 * These import the real functions used by the route handlers, so a change
 * to the production guards is visible to the tests. Integration coverage
 * (full request/response via supertest) is a separate follow-up.
 */

import { describe, it, expect } from "vitest";
import {
  validateCreateConversation,
  validateSendMessage,
} from "../conversations.js";

// ── POST /conversations — body validation ──────────────────────────

describe("validateCreateConversation", () => {
  it("rejects when both agentId and memberId are missing", () => {
    const result = validateCreateConversation({});
    expect(result.valid).toBe(false);
    expect((result as { valid: false; error: string }).error).toBe(
      "agentId and memberId are required",
    );
  });

  it("rejects when agentId is missing (memberId present)", () => {
    expect(validateCreateConversation({ memberId: "member-1" }).valid).toBe(false);
  });

  it("rejects when memberId is missing (agentId present)", () => {
    expect(validateCreateConversation({ agentId: "agent-1" }).valid).toBe(false);
  });

  it("rejects empty string agentId", () => {
    expect(
      validateCreateConversation({ agentId: "", memberId: "member-1" }).valid,
    ).toBe(false);
  });

  it("rejects empty string memberId", () => {
    expect(
      validateCreateConversation({ agentId: "agent-1", memberId: "" }).valid,
    ).toBe(false);
  });

  it("accepts valid agentId and memberId", () => {
    expect(
      validateCreateConversation({ agentId: "agent-abc", memberId: "member-xyz" }).valid,
    ).toBe(true);
  });

  it("accepts UUID-shaped IDs (typical DB output)", () => {
    expect(
      validateCreateConversation({
        agentId: "550e8400-e29b-41d4-a716-446655440000",
        memberId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      }).valid,
    ).toBe(true);
  });
});

// ── POST /:id/messages — body validation ──────────────────────────

describe("validateSendMessage", () => {
  it("accepts a non-empty string message field", () => {
    expect(validateSendMessage({ message: "Hello!" })).toBe(true);
  });

  it("rejects when message field is missing", () => {
    expect(validateSendMessage({})).toBe(false);
  });

  it("rejects when message is a number (wrong type)", () => {
    expect(validateSendMessage({ message: 42 })).toBe(false);
  });

  it("rejects when message is null", () => {
    expect(validateSendMessage({ message: null })).toBe(false);
  });

  it("rejects empty string message", () => {
    expect(validateSendMessage({ message: "" })).toBe(false);
  });

  it("rejects a 'content' field (old field name that caused the bug)", () => {
    // The UI previously sent { content, role: "user" } which the server ignored.
    // The correct field is 'message'. This test documents the contract.
    const body = { content: "Hello!", role: "user" } as { message?: unknown };
    expect(validateSendMessage(body)).toBe(false);
  });
});
