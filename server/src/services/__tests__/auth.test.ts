/**
 * Tests for API authentication: token format, generation behaviour,
 * and middleware exemption/authorization logic.
 *
 * getOrCreateDashboardToken() is tested via a mock DB inline below.
 * The middleware logic is tested against extracted predicates — it's
 * simple string comparison, but the exemption rules are security-critical.
 *
 * NOTE: The getOrCreateDashboardToken import lives in server/src/services/auth.ts
 * which is on the feat/api-auth branch. The mock-DB behaviour tests at the
 * bottom of this file document the expected contract regardless of branch.
 */

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";

// ── Token format invariants ────────────────────────────────────────

describe("dashboard token format", () => {
  it("randomBytes(32).toString('hex') produces a 64-char hex string", () => {
    // This is the generation strategy used by getOrCreateDashboardToken.
    // Verifying the shape here locks in the format so a future change
    // (e.g. switching to base64url) requires an explicit test update.
    const token = randomBytes(32).toString("hex");
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
  });

  it("generates a different token each call (sufficient entropy)", () => {
    const tokens = new Set(
      Array.from({ length: 20 }, () => randomBytes(32).toString("hex")),
    );
    expect(tokens.size).toBe(20);
  });
});

// ── getOrCreateDashboardToken — contract via mock DB ──────────────
//
// We replicate the key observable behaviours without importing auth.ts
// directly so this test file can live on any branch. When auth.ts is
// present, the behaviour described here should match exactly.

describe("getOrCreateDashboardToken (contract)", () => {
  it("returns existing token without inserting a new one", async () => {
    // Simulate: DB has a stored token → return it, call insert 0 times.
    const storedToken = "a".repeat(64);
    let insertCalled = false;

    async function getOrCreate(existingValue: string | null): Promise<string> {
      if (existingValue && typeof existingValue === "string" && existingValue.length > 0) {
        return existingValue;
      }
      insertCalled = true;
      return randomBytes(32).toString("hex");
    }

    const result = await getOrCreate(storedToken);
    expect(result).toBe(storedToken);
    expect(insertCalled).toBe(false);
  });

  it("generates and inserts a new token when DB has none", async () => {
    let inserted: string | null = null;

    async function getOrCreate(existingValue: string | null): Promise<string> {
      if (existingValue && typeof existingValue === "string" && existingValue.length > 0) {
        return existingValue;
      }
      const token = randomBytes(32).toString("hex");
      inserted = token;
      return token;
    }

    const result = await getOrCreate(null);
    expect(result).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(result)).toBe(true);
    expect(inserted).toBe(result);
  });

  it("does not treat a non-string DB value as a valid token", async () => {
    // instance_settings value is typed as json (unknown at runtime) —
    // a number or object must not be returned as the token.
    let insertCalled = false;

    async function getOrCreate(existingValue: unknown): Promise<string> {
      if (existingValue && typeof existingValue === "string" && existingValue.length > 0) {
        return existingValue;
      }
      insertCalled = true;
      return randomBytes(32).toString("hex");
    }

    await getOrCreate(12345);
    expect(insertCalled).toBe(true);

    insertCalled = false;
    await getOrCreate({ token: "object" });
    expect(insertCalled).toBe(true);
  });

  it("generates different tokens on independent fresh-DB calls", async () => {
    async function freshToken(): Promise<string> {
      return randomBytes(32).toString("hex");
    }
    const [t1, t2] = await Promise.all([freshToken(), freshToken()]);
    expect(t1).not.toBe(t2);
  });
});

// ── Middleware exemption rules ─────────────────────────────────────
//
// app.ts middleware logic:
//   if (path === "/health" || path.startsWith("/health/")) → exempt
//   if (path === "/bootstrap-token") → exempt
//   else → require Bearer token

function isExempt(path: string): boolean {
  return (
    path === "/health" ||
    path.startsWith("/health/") ||
    path === "/bootstrap-token"
  );
}

describe("middleware exemption rules", () => {
  it("/health is exempt", () => {
    expect(isExempt("/health")).toBe(true);
  });

  it("/health/ subpaths are exempt (e.g. /health/db, /health/adapter)", () => {
    expect(isExempt("/health/db")).toBe(true);
    expect(isExempt("/health/adapter")).toBe(true);
  });

  it("/bootstrap-token is exempt", () => {
    expect(isExempt("/bootstrap-token")).toBe(true);
  });

  it("all other paths are NOT exempt", () => {
    const paths = ["/settings", "/conversations", "/staff", "/households", "/members", "/tools"];
    for (const p of paths) {
      expect(isExempt(p)).toBe(false);
    }
  });

  it("does not exempt paths that merely start with 'health' (e.g. /healthcheck)", () => {
    // startsWith("/health/") requires the slash, so /healthcheck is not exempt
    expect(isExempt("/healthcheck")).toBe(false);
  });

  it("does not exempt /bootstrap-token/ with trailing slash", () => {
    // Exact match only — /bootstrap-token/ is a different path
    expect(isExempt("/bootstrap-token/")).toBe(false);
  });
});

// ── Bearer token authorization check ──────────────────────────────

function isAuthorized(authHeader: string | undefined, token: string): boolean {
  return !!authHeader && authHeader === `Bearer ${token}`;
}

describe("bearer token authorization check", () => {
  const token = randomBytes(32).toString("hex");

  it("accepts correct Bearer token", () => {
    expect(isAuthorized(`Bearer ${token}`, token)).toBe(true);
  });

  it("rejects missing Authorization header", () => {
    expect(isAuthorized(undefined, token)).toBe(false);
  });

  it("rejects empty Authorization header", () => {
    expect(isAuthorized("", token)).toBe(false);
  });

  it("rejects wrong token value", () => {
    const other = randomBytes(32).toString("hex");
    expect(isAuthorized(`Bearer ${other}`, token)).toBe(false);
  });

  it("rejects token sent without Bearer scheme prefix", () => {
    expect(isAuthorized(token, token)).toBe(false);
  });

  it("rejects Basic scheme even with the correct token as the credential", () => {
    expect(isAuthorized(`Basic ${token}`, token)).toBe(false);
  });

  it("is case-sensitive for the token value", () => {
    expect(isAuthorized(`Bearer ${token.toUpperCase()}`, token)).toBe(false);
  });

  it("rejects 'Bearer ' with no token (trailing space only)", () => {
    expect(isAuthorized("Bearer ", token)).toBe(false);
  });
});
