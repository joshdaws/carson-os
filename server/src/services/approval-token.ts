/**
 * Signed approval tokens for hire-proposal deep-links (v0.5.2 / TODO-6).
 *
 * Signal-only family members can't tap inline buttons (Signal protocol
 * doesn't support callback queries). The Signal hire-proposal card now
 * includes two deep-link URLs — one for approve, one for reject — that
 * carry an HMAC-SHA256-signed token. Tapping a link opens a confirmation
 * page in the family member's browser; the page POSTs the token back to
 * /api/approval/redeem which validates the signature, checks expiry, and
 * dispatches to delegation-service.handleHireApproval / handleHireRejection.
 *
 * Why HMAC and not a session cookie: the user clicks a link from their
 * messaging client. They may or may not be logged in to the web UI. The
 * token IS the auth — server-issued, time-bound, action-bound, taskId-
 * bound. Stealing the link from a notification preview is enough for an
 * attacker who already has Signal access; protecting against compromised
 * messaging clients is out of scope for the family runtime.
 *
 * Secret lifecycle: stored under instance_settings.system.approval_token_secret.
 * Generated lazily on first sign/verify call; persists across restarts.
 * The operator can rotate by deleting the row (next call regenerates,
 * invalidating any in-flight tokens — the user just gets a fresh hire
 * proposal next time the approval window expires).
 */

import { createHmac, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { instanceSettings } from "@carsonos/db";

const SECRET_KEY = "system.approval_token_secret";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type ApprovalAction = "approve" | "reject";

export interface ApprovalTokenPayload {
  taskId: string;
  action: ApprovalAction;
  expiresAt: number;
}

export type VerifyResult =
  | { ok: true; payload: ApprovalTokenPayload }
  | { ok: false; reason: string };

async function getOrCreateSecret(db: Db): Promise<string> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.key, SECRET_KEY))
    .limit(1);
  const value = row?.value as { secret?: string } | null | undefined;
  if (value && typeof value.secret === "string" && value.secret.length >= 32) {
    return value.secret;
  }
  const secret = randomBytes(32).toString("hex");
  if (row) {
    await db
      .update(instanceSettings)
      .set({ value: { secret, generatedAt: new Date().toISOString() } })
      .where(eq(instanceSettings.key, SECRET_KEY));
  } else {
    await db.insert(instanceSettings).values({
      id: crypto.randomUUID(),
      key: SECRET_KEY,
      value: { secret, generatedAt: new Date().toISOString() },
    });
  }
  return secret;
}

function computeSignature(taskId: string, action: ApprovalAction, expiresAt: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${taskId}.${action}.${expiresAt}`)
    .digest("hex");
}

/**
 * Sign a fresh approval token for (taskId, action). Pure of network IO
 * apart from one DB read (cached via the Drizzle query, not by us — the
 * hot path during proposeHire calls this twice per proposal, which is
 * fine).
 */
export async function signApprovalToken(
  db: Db,
  taskId: string,
  action: ApprovalAction,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<string> {
  const secret = await getOrCreateSecret(db);
  const expiresAt = Date.now() + ttlMs;
  const sig = computeSignature(taskId, action, expiresAt, secret);
  return `${taskId}.${action}.${expiresAt}.${sig}`;
}

/**
 * Validate a token's signature, format, and expiry. Returns the embedded
 * payload on success, a structured reason on failure (so the route handler
 * can respond with a precise error code without leaking secret details).
 */
export async function verifyApprovalToken(
  db: Db,
  token: string,
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 4) {
    return { ok: false, reason: "malformed token" };
  }
  const [taskId, actionRaw, expiresAtRaw, sig] = parts;
  if (actionRaw !== "approve" && actionRaw !== "reject") {
    return { ok: false, reason: "invalid action" };
  }
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { ok: false, reason: "invalid expiry" };
  }
  const secret = await getOrCreateSecret(db);
  const expected = computeSignature(taskId, actionRaw, expiresAt, secret);
  if (sig.length !== expected.length) {
    return { ok: false, reason: "signature mismatch" };
  }
  // Constant-time comparison to avoid leaking signature length via timing.
  let diff = 0;
  for (let i = 0; i < sig.length; i++) {
    diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) {
    return { ok: false, reason: "signature mismatch" };
  }
  if (Date.now() > expiresAt) {
    return { ok: false, reason: "token expired" };
  }
  return { ok: true, payload: { taskId, action: actionRaw, expiresAt } };
}
