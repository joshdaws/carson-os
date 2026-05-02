/**
 * HMAC approval-token sign/verify (v0.5.2 / TODO-6).
 *
 * The token is the auth for Signal-deeplink hire approvals — a Signal-
 * only family member can't tap inline buttons, so the proposal card
 * carries two URLs (one per action), each containing a signed token
 * that the redeem endpoint validates before dispatching to
 * delegation-service.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "@carsonos/db";
import {
  signApprovalToken,
  verifyApprovalToken,
} from "../approval-token.js";

describe("approval-token", () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("signs and verifies a valid token round-trip", async () => {
    const token = await signApprovalToken(db, "task-123", "approve");
    const result = await verifyApprovalToken(db, token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.taskId).toBe("task-123");
      expect(result.payload.action).toBe("approve");
      expect(result.payload.expiresAt).toBeGreaterThan(Date.now());
    }
  });

  it("signs distinct tokens for approve vs reject on the same task", async () => {
    const a = await signApprovalToken(db, "task-1", "approve");
    const r = await signApprovalToken(db, "task-1", "reject");
    expect(a).not.toBe(r);

    const va = await verifyApprovalToken(db, a);
    const vr = await verifyApprovalToken(db, r);
    expect(va.ok && va.payload.action).toBe("approve");
    expect(vr.ok && vr.payload.action).toBe("reject");
  });

  it("rejects malformed tokens", async () => {
    const cases = [
      "",
      "no-dots",
      "two.parts",
      "task.invalid-action.123.deadbeef",
      "task.approve.not-a-number.deadbeef",
    ];
    for (const t of cases) {
      const r = await verifyApprovalToken(db, t);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects a tampered signature", async () => {
    const token = await signApprovalToken(db, "task-x", "approve");
    const parts = token.split(".");
    parts[3] = "0".repeat(parts[3].length); // wipe sig
    const tampered = parts.join(".");
    const result = await verifyApprovalToken(db, tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature mismatch");
  });

  it("rejects an expired token", async () => {
    // 1ms TTL — by the time we await + call verify, it's expired.
    const token = await signApprovalToken(db, "task-expired", "approve", 1);
    await new Promise((r) => setTimeout(r, 5));
    const result = await verifyApprovalToken(db, token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("token expired");
  });

  it("rejects a token swapped to a different action (signature is action-bound)", async () => {
    const token = await signApprovalToken(db, "task-swap", "approve");
    // Take the signature from an approve token and try to use it on a
    // forged reject body.
    const parts = token.split(".");
    parts[1] = "reject"; // forge action
    const forged = parts.join(".");
    const result = await verifyApprovalToken(db, forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature mismatch");
  });

  it("rejects a token swapped to a different taskId (signature is task-bound)", async () => {
    const token = await signApprovalToken(db, "task-A", "approve");
    const parts = token.split(".");
    parts[0] = "task-B"; // forge taskId
    const forged = parts.join(".");
    const result = await verifyApprovalToken(db, forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature mismatch");
  });

  it("uses the same secret across calls (tokens stay valid across ::sign+verify)", async () => {
    // Signing creates the secret on first call. A second sign + verify
    // pair must use the same secret so verification still passes.
    const t1 = await signApprovalToken(db, "task-1", "approve");
    const t2 = await signApprovalToken(db, "task-2", "reject");
    expect((await verifyApprovalToken(db, t1)).ok).toBe(true);
    expect((await verifyApprovalToken(db, t2)).ok).toBe(true);
  });

  it("a token signed in one DB does not verify against a different DB (different secret)", async () => {
    const tokenA = await signApprovalToken(db, "task-1", "approve");
    const dbB = createDb(":memory:");
    const result = await verifyApprovalToken(dbB, tokenA);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature mismatch");
  });
});
