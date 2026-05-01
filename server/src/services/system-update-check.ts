/**
 * System update self-awareness.
 *
 * Compares the local CarsonOS VERSION against the latest version on
 * `origin/main` (raw GitHub fetch — no git side effects, no auth) and
 * writes the result to `instance_settings` so the Chief of Staff can
 * surface pending updates in-voice on the next interaction.
 *
 * Key state rows:
 *   - `system.update_available` — { from, to, fetchedAt, changelogExcerpt }
 *     written when remote > local. Read by the CoS prompt assembler.
 *   - `system.update_pending`   — { from, to, changelogExcerpt, requestedAt }
 *     written by the `apply_system_update` tool RIGHT BEFORE the host
 *     restarts. Read on next boot to drive the in-voice "update applied"
 *     announcement (TODO-3.5).
 *
 * Daily TTL: a successful check sets `last_checked_at`. Subsequent calls
 * within 24h are no-ops unless `force: true` is passed.
 *
 * Failure modes (offline, GitHub 404, malformed VERSION) are caught,
 * logged once, and do not throw — boot/scheduler ticks must not be
 * blocked by transient network errors.
 *
 * The changelog excerpt is a trust-boundary surface: anyone who can edit
 * CHANGELOG.md can inject prompt content. Sanitization (control chars
 * stripped, length capped) lives here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import {
  conversations,
  familyMembers,
  instanceSettings,
  messages,
  staffAgents,
} from "@carsonos/db";

// ── Constants ──────────────────────────────────────────────────────

const REPO_OWNER = "joshdaws";
const REPO_NAME = "carson-os";
const VERSION_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/VERSION`;
const CHANGELOG_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/CHANGELOG.md`;

const FETCH_TIMEOUT_MS = 5_000;
const CHECK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const EXCERPT_MAX_BYTES = 1500;
const VERSION_REGEX = /^\d+\.\d+\.\d+(?:\.\d+)?$/;

const KEY_UPDATE_AVAILABLE = "system.update_available";
const KEY_LAST_CHECKED = "system.update_check.last_checked_at";
export const KEY_UPDATE_PENDING = "system.update_pending";

// ── Public API ─────────────────────────────────────────────────────

export interface UpdateAvailable {
  from: string;
  to: string;
  fetchedAt: string; // ISO 8601
  changelogExcerpt: string;
}

export interface UpdatePending {
  from: string;
  to: string;
  changelogExcerpt: string;
  requestedAt: string; // ISO 8601
  /** Household whose CoS will deliver the post-restart announcement. */
  householdId: string;
  /** Member who requested the update; the post-restart message is sent to them. */
  requestedByMemberId: string;
}

export interface CheckOptions {
  /** When true, ignores the 24h cache and forces a fresh fetch. */
  force?: boolean;
  /** Override the local version (test-only). Defaults to reading VERSION file. */
  currentVersion?: string;
  /** Override the fetcher (test-only). Defaults to global fetch. */
  fetcher?: typeof fetch;
}

/**
 * Run an update check. Idempotent and bounded — safe to call from boot
 * and from the scheduler tick. Returns the resulting UpdateAvailable
 * record (when one exists), or null if up-to-date / errored / cached.
 */
export async function checkForUpdate(
  db: Db,
  options: CheckOptions = {},
): Promise<UpdateAvailable | null> {
  // Cache gate: skip the network call if we ran in the last 24h, unless
  // the caller forces a fresh check. The `delta >= 0` clause guards
  // against clock skew — a future `lastAt` (NTP correction backwards,
  // operator setting the system clock forward then back) would otherwise
  // make `delta < TTL` pass and pin the cache until wall-clock catches
  // up, which can be effectively forever.
  if (!options.force) {
    const last = await readSetting(db, KEY_LAST_CHECKED);
    if (last && typeof last === "object" && "at" in last) {
      const lastAt = new Date((last as { at: string }).at).getTime();
      const delta = Date.now() - lastAt;
      if (Number.isFinite(lastAt) && delta >= 0 && delta < CHECK_TTL_MS) {
        // Cache hit. Return the previously-recorded available state if any.
        const cached = await readSetting(db, KEY_UPDATE_AVAILABLE);
        return isUpdateAvailable(cached) ? cached : null;
      }
    }
  }

  const localVersion = options.currentVersion ?? readLocalVersion();
  if (!localVersion) {
    console.warn("[update-check] could not read local VERSION; skipping");
    return null;
  }

  let remoteVersion: string;
  let remoteChangelog: string;
  try {
    [remoteVersion, remoteChangelog] = await Promise.all([
      fetchText(VERSION_URL, options.fetcher),
      fetchText(CHANGELOG_URL, options.fetcher),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[update-check] fetch failed:", msg);
    // Don't update last-checked timestamp on transient network errors;
    // we want the next tick to retry instead of waiting 24h.
    return null;
  }

  remoteVersion = remoteVersion.trim();
  if (!VERSION_REGEX.test(remoteVersion)) {
    console.warn(
      `[update-check] remote VERSION malformed: ${JSON.stringify(remoteVersion).slice(0, 80)}; skipping`,
    );
    return null;
  }

  // Mark the check as done regardless of comparison result so the cache
  // gate works even when we're up-to-date.
  await writeSetting(db, KEY_LAST_CHECKED, { at: new Date().toISOString() });

  let cmp: number;
  try {
    cmp = compareVersions(remoteVersion, localVersion);
  } catch (err) {
    console.warn(
      "[update-check] cannot compare versions:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (cmp <= 0) {
    // We're current or ahead. Clear any stale "available" row so the
    // CoS prompt doesn't keep proposing an update that's already shipped.
    await deleteSetting(db, KEY_UPDATE_AVAILABLE);
    return null;
  }

  const excerpt = sanitizeExcerpt(extractChangelogEntry(remoteChangelog, remoteVersion));
  const update: UpdateAvailable = {
    from: localVersion,
    to: remoteVersion,
    fetchedAt: new Date().toISOString(),
    changelogExcerpt: excerpt,
  };
  await writeSetting(db, KEY_UPDATE_AVAILABLE, update);
  return update;
}

/** Read the current `update_available` row, or null. */
export async function readUpdateAvailable(db: Db): Promise<UpdateAvailable | null> {
  const v = await readSetting(db, KEY_UPDATE_AVAILABLE);
  return isUpdateAvailable(v) ? v : null;
}

/** Read the `update_pending` row written before a restart, or null. */
export async function readUpdatePending(db: Db): Promise<UpdatePending | null> {
  const v = await readSetting(db, KEY_UPDATE_PENDING);
  return isUpdatePending(v) ? v : null;
}

/** Write the `update_pending` row. Called by `apply_system_update` right before spawn. */
export async function writeUpdatePending(db: Db, value: UpdatePending): Promise<void> {
  await writeSetting(db, KEY_UPDATE_PENDING, value);
}

/** Clear the `update_pending` row after the post-restart announcement runs. */
export async function clearUpdatePending(db: Db): Promise<void> {
  await deleteSetting(db, KEY_UPDATE_PENDING);
}

// ── Post-restart announcement (TODO-3.5) ──────────────────────────

/**
 * Inputs the boot path must inject. Mirrors the wakeDelegator wiring in
 * delegation-service.ts: the engine runs an in-voice turn for the CoS,
 * and the sender delivers the result via the matching telegram bot.
 */
export interface AnnounceUpdateAppliedDeps {
  /** ConstitutionEngine.processMessage, narrowed. The channel is chosen
   *  here based on the member's primary push transport: "telegram" when
   *  telegramUserId is set, otherwise "web". The web path doesn't push —
   *  processMessage's persistence into the conversation IS the delivery
   *  (the user sees it on next UI open). */
  processMessage: (input: {
    agentId: string;
    memberId: string;
    householdId: string;
    message: string;
    channel: "telegram" | "web";
  }) => Promise<{ blocked?: boolean; response?: string }>;
  /** multiRelay.sendMessage(agentId, telegramUserId, text). Only invoked
   *  when channel === "telegram"; web members are delivered passively
   *  via the conversation persistence above. Signal-only members fall
   *  through to web for now (TODO-6 handles Signal explicitly). */
  sendToUser: (
    agentId: string,
    telegramUserId: string,
    text: string,
  ) => Promise<unknown>;
  /** Read the version baked into the running process. Lets tests stub. */
  currentVersion?: string;
}

/**
 * Run once on boot, AFTER multiRelay is up. If the previous instance
 * wrote an `update_pending` row before restarting AND we came back up
 * at the expected version, queue a one-shot in-voice announcement from
 * the household's Chief of Staff to the requesting member.
 *
 * If the boot's VERSION is below the requested `to` (the update didn't
 * actually apply, or rolled back), log a warning and clear the pending
 * row so we don't keep trying.
 */
export async function announceUpdateApplied(
  db: Db,
  deps: AnnounceUpdateAppliedDeps,
): Promise<void> {
  const pending = await readUpdatePending(db);
  if (!pending) return;

  const current = deps.currentVersion ?? readLocalVersion();
  if (!current) {
    console.warn(
      "[update-check] post-restart: cannot read local VERSION, skipping announcement",
    );
    return;
  }

  let cmp: number;
  try {
    cmp = compareVersions(current, pending.to);
  } catch (err) {
    console.warn(
      "[update-check] post-restart: cannot compare versions, skipping announcement:",
      err instanceof Error ? err.message : String(err),
    );
    // Don't clear pending — the next boot may have a sane VERSION.
    return;
  }
  if (cmp < 0) {
    console.warn(
      `[update-check] post-restart: requested v${pending.to} but running v${current}; update appears to have failed. Clearing pending row.`,
    );
    await clearUpdatePending(db);
    return;
  }
  if (cmp > 0) {
    // We're AHEAD of pending.to — someone pulled a newer version manually
    // (outside the apply_system_update path) before the post-restart
    // announcement could fire. The cached changelog excerpt is for the
    // version we PASSED, not the version we landed on. Don't announce
    // with stale content; clear the row and let checkForUpdate decide
    // what to surface next.
    console.warn(
      `[update-check] post-restart: running v${current} ahead of pending.to v${pending.to}; clearing stale pending row without announcing (user pulled newer manually).`,
    );
    await clearUpdatePending(db);
    return;
  }

  // Look up the household's CoS and the requesting member.
  const [cos] = await db
    .select({ id: staffAgents.id })
    .from(staffAgents)
    .where(
      and(
        eq(staffAgents.householdId, pending.householdId),
        eq(staffAgents.staffRole, "head_butler"),
      ),
    )
    .limit(1);
  if (!cos) {
    console.warn(
      `[update-check] post-restart: no head_butler agent for household ${pending.householdId}; skipping announcement`,
    );
    await clearUpdatePending(db);
    return;
  }

  const [member] = await db
    .select({
      id: familyMembers.id,
      name: familyMembers.name,
      telegramUserId: familyMembers.telegramUserId,
    })
    .from(familyMembers)
    .where(eq(familyMembers.id, pending.requestedByMemberId))
    .limit(1);
  if (!member) {
    console.warn(
      `[update-check] post-restart: requesting member ${pending.requestedByMemberId} not found; skipping announcement`,
    );
    await clearUpdatePending(db);
    return;
  }
  // Pick the member's primary push channel. Telegram if a telegramUserId
  // is set; otherwise fall back to web — processMessage's persistence
  // into the web conversation IS the delivery (the user sees it on
  // next UI open). Signal-only members fall through to web for now;
  // explicit signal-push delivery is TODO-6.
  const channel: "telegram" | "web" = member.telegramUserId ? "telegram" : "web";

  // Build a plain-prose system trigger. The trigger format mirrors
  // wakeDelegator's pattern: tagged key:value lines, no sentinel format,
  // and a closing instruction telling the agent NOT to echo the trigger.
  const trigger = [
    "System update applied: the CarsonOS update you proposed has finished installing and the host is back up.",
    `- from: v${pending.from}`,
    `- to: v${current}`,
    `- requested by: ${member.name}`,
    "",
    "Tell the user — in your own voice, briefly — that the update is done and what changed. Use the changelog excerpt below to pick out 1-3 user-facing wins worth mentioning. Keep it short, conversational, and don't restate the version numbers in raw form (say 'the latest update' or 'the v0.5.1 release', not 'vN.M.K applied').",
    "",
    "Do not restate this trigger back to the user. Do not list every changelog bullet — pick the 1-3 most relevant.",
    "",
    "## Changelog excerpt",
    "",
    pending.changelogExcerpt || "(no changelog excerpt available — describe v" + pending.to + " generically)",
  ].join("\n");

  try {
    const result = await deps.processMessage({
      agentId: cos.id,
      memberId: member.id,
      householdId: pending.householdId,
      message: trigger,
      channel,
    });
    if (result.blocked) {
      console.warn("[update-check] post-restart: engine blocked the announcement turn");
      // Don't clear pending — we'll retry on next boot in case this was
      // a transient block. If the user reboots without using the app, the
      // announcement will fire then.
      return;
    }
    const text = result.response?.trim();
    if (!text) {
      console.warn("[update-check] post-restart: engine returned empty response");
      return;
    }
    if (channel === "telegram") {
      // member.telegramUserId is non-null here (the channel pick above
      // gates on it). Push via the agent's bot.
      await deps.sendToUser(cos.id, member.telegramUserId!, text);
    } else {
      // For web, processMessage already persisted the assistant response
      // into the web conversation row; no push needed. But it ALSO
      // persisted our trigger as role="user" before generating the
      // response, and the trigger is system-injected — not a real user
      // keystroke. Leaving it in the conversation would show the user a
      // user-bubble with the raw trigger text the next time they open
      // the UI. Strip it. Telegram doesn't need this scrub: the
      // telegram client renders bot replies and doesn't surface the
      // user-side history of bot conversations to its viewer.
      await stripWebChannelTrigger(
        db,
        cos.id,
        member.id,
        pending.householdId,
        trigger,
      );
    }
    await clearUpdatePending(db);
    console.log(
      `[update-check] post-restart announcement delivered to ${member.name} via ${channel} (v${pending.from} → v${current})`,
    );
  } catch (err) {
    console.warn(
      "[update-check] post-restart announcement failed:",
      err instanceof Error ? err.message : String(err),
    );
    // Leave pending in place; next boot will retry.
  }
}

// ── Pure helpers (exported for tests) ──────────────────────────────

/**
 * Compare two CarsonOS versions. Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Handles both 3-digit (legacy) and 4-digit shapes by zero-padding.
 *
 * Throws when either input has a non-numeric segment (e.g. "0.5.1-beta",
 * "0.5.x"). NaN comparisons silently return false, which would have made
 * compareVersions return 0 (equal) for any pair containing a NaN — and a
 * stale-but-equal pending row could fire the post-restart announcement
 * with the wrong content. Callers handle the throw via try/catch and
 * treat it as "can't compare → don't announce / don't claim out-of-date."
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) {
    throw new Error(
      `compareVersions: non-numeric segment in '${a}' vs '${b}'; refusing to silently treat as equal`,
    );
  }
  const max = Math.max(pa.length, pb.length);
  for (let i = 0; i < max; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

/**
 * Pull the changelog entry for a given version out of CHANGELOG.md.
 * The file follows Keep-a-Changelog: each release is a `## [X.Y.Z.W] - YYYY-MM-DD`
 * header followed by sections. We extract from that header up to the next
 * `## [` header (or end of file).
 *
 * Returns an empty string if the entry isn't found — the CoS prompt
 * just proceeds without the body in that case.
 */
export function extractChangelogEntry(changelog: string, version: string): string {
  // Match `## [VERSION]` with the version literal regex-escaped.
  const escaped = version.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
  const headerRe = new RegExp(`^## \\[${escaped}\\][^\\n]*$`, "m");
  const headerMatch = headerRe.exec(changelog);
  if (!headerMatch) return "";
  const start = headerMatch.index + headerMatch[0].length;
  // Find the next `## [` header (start of next entry).
  const tail = changelog.slice(start);
  const nextRe = /^## \[/m;
  const nextMatch = nextRe.exec(tail);
  const body = nextMatch ? tail.slice(0, nextMatch.index) : tail;
  return body.trim();
}

/**
 * Sanitize a changelog excerpt before injecting it into the CoS system
 * prompt. The CHANGELOG is editable by anyone with repo write access, so
 * this is a trust-boundary surface — strip control bytes, cap the size,
 * keep the prompt bounded.
 */
export function sanitizeExcerpt(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  if (stripped.length <= EXCERPT_MAX_BYTES) return stripped;
  return (
    stripped.slice(0, EXCERPT_MAX_BYTES - 32) +
    `\n... [truncated to ${EXCERPT_MAX_BYTES}B]`
  );
}

// ── Internal helpers ───────────────────────────────────────────────

function readLocalVersion(): string | null {
  try {
    const versionPath = join(import.meta.dirname, "..", "..", "..", "VERSION");
    return readFileSync(versionPath, "utf-8").trim();
  } catch {
    return null;
  }
}

async function fetchText(url: string, fetcher?: typeof fetch): Promise<string> {
  const f = fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await f(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`${url}: HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function readSetting(db: Db, key: string): Promise<unknown> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.key, key))
    .limit(1);
  return row?.value ?? null;
}

async function writeSetting(db: Db, key: string, value: unknown): Promise<void> {
  const existing = await db
    .select({ id: instanceSettings.id })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, key))
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(instanceSettings)
      .set({ value })
      .where(eq(instanceSettings.key, key));
    return;
  }
  await db.insert(instanceSettings).values({
    id: crypto.randomUUID(),
    key,
    value,
  });
}

async function deleteSetting(db: Db, key: string): Promise<void> {
  await db.delete(instanceSettings).where(eq(instanceSettings.key, key));
}

/**
 * Remove the system-injected trigger row that processMessage wrote into
 * the web conversation as role="user" before generating its response.
 * Used only on the web announcement path; telegram doesn't need it
 * because the telegram viewer shows bot replies, not the user-side
 * history of bot conversations.
 */
async function stripWebChannelTrigger(
  db: Db,
  agentId: string,
  memberId: string,
  householdId: string,
  trigger: string,
): Promise<void> {
  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.agentId, agentId),
        eq(conversations.memberId, memberId),
        eq(conversations.householdId, householdId),
        eq(conversations.channel, "web"),
      ),
    )
    .limit(1);
  if (!conv) return;
  await db
    .delete(messages)
    .where(
      and(
        eq(messages.conversationId, conv.id),
        eq(messages.role, "user"),
        eq(messages.content, trigger),
      ),
    );
}

function isUpdateAvailable(v: unknown): v is UpdateAvailable {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).from === "string" &&
    typeof (v as Record<string, unknown>).to === "string" &&
    typeof (v as Record<string, unknown>).fetchedAt === "string" &&
    typeof (v as Record<string, unknown>).changelogExcerpt === "string"
  );
}

function isUpdatePending(v: unknown): v is UpdatePending {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).from === "string" &&
    typeof (v as Record<string, unknown>).to === "string" &&
    typeof (v as Record<string, unknown>).changelogExcerpt === "string" &&
    typeof (v as Record<string, unknown>).requestedAt === "string" &&
    typeof (v as Record<string, unknown>).householdId === "string" &&
    typeof (v as Record<string, unknown>).requestedByMemberId === "string"
  );
}
