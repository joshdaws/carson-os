/**
 * Dashboard authentication -- static bearer token stored in instance_settings.
 *
 * Generated once on first boot, persisted in the DB, never changes unless
 * the operator explicitly deletes the DASHBOARD_TOKEN row.  The UI fetches
 * it from /api/bootstrap-token (loopback-only endpoint) and caches it in
 * localStorage, then sends it as an Authorization: Bearer header on every
 * API request.
 */

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { instanceSettings } from "@carsonos/db";

const TOKEN_KEY = "DASHBOARD_TOKEN";

export async function getOrCreateDashboardToken(db: Db): Promise<string> {
  const existing = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.key, TOKEN_KEY))
    .get();

  if (existing?.value && typeof existing.value === "string" && existing.value.length > 0) {
    return existing.value;
  }

  const token = randomBytes(32).toString("hex");

  await db.insert(instanceSettings).values({
    id: TOKEN_KEY,
    key: TOKEN_KEY,
    value: token,
  });

  console.log("[auth] Generated new dashboard access token");
  return token;
}
