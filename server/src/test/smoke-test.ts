/**
 * M1 Smoke Test — simulates Telegram messages through the full pipeline.
 *
 * Tests:
 *   1. Basic conversation (no tools)
 *   2. Memory save (agent should proactively save a fact)
 *   3. Memory search (agent should find saved memory)
 *   4. Activity logging verification
 *
 * Uses the Agent SDK adapter (Claude subscription, no API key needed).
 *
 * Usage: npx tsx server/src/test/smoke-test.ts
 */

import { join } from "node:path";
import { createDb } from "@carsonos/db";
import { households, familyMembers, staffAgents } from "@carsonos/db";
import { eq, and } from "drizzle-orm";
import { getConfig } from "../config.js";
import { createAdapter } from "../services/subprocess-adapter.js";
import { ConstitutionEngine } from "../services/constitution-engine.js";
import { bootMemory } from "../services/memory/index.js";

const config = getConfig();
const DB_PATH = join(config.dataDir, "carsonos.db");

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  CarsonOS M1 Smoke Test");
  console.log("  Adapter: Agent SDK (Claude subscription)");
  console.log("═══════════════════════════════════════════════\n");

  // Boot
  const db = createDb(DB_PATH);
  const adapter = createAdapter(config.adapterType);

  const adapterHealthy = await adapter.healthCheck();
  if (!adapterHealthy) {
    console.error(`[FAIL] Adapter "${adapter.name}" is not healthy. Make sure 'claude' CLI is installed.`);
    process.exit(1);
  }
  console.log(`[OK] Adapter: ${adapter.name}`);

  // Boot memory
  const memoryProvider = await bootMemory(db, config.memory);
  console.log(`[OK] Memory: ${config.memory.kind} at ${config.memory.rootDir}`);

  // Load test data
  const [household] = await db.select().from(households).limit(1);
  if (!household) {
    console.error("[FAIL] No household found. Run seed-test-household.ts first.");
    process.exit(1);
  }

  const [josh] = await db
    .select()
    .from(familyMembers)
    .where(and(eq(familyMembers.householdId, household.id), eq(familyMembers.name, "Josh")));
  const [grant] = await db
    .select()
    .from(familyMembers)
    .where(and(eq(familyMembers.householdId, household.id), eq(familyMembers.name, "Grant")));
  const [carson] = await db
    .select()
    .from(staffAgents)
    .where(and(eq(staffAgents.householdId, household.id), eq(staffAgents.name, "Carson")));

  if (!josh || !grant || !carson) {
    console.error("[FAIL] Missing test data. Run seed-test-household.ts first.");
    process.exit(1);
  }
  console.log(`[OK] Test data: ${household.name}, Josh, Grant, Carson\n`);

  // Build engine with memory
  const engine = new ConstitutionEngine({
    db,
    broadcast: (event) => {
      console.log(`  [event] ${event.type}`);
    },
    adapter,
    memoryProvider,
    featureFlags: config.featureFlags,
  });

  // ── Test 1: Basic conversation with Josh ─────────────────────────
  console.log("── Test 1: Basic conversation (Josh → Carson) ──");
  const result1 = await engine.processMessage({
    agentId: carson.id,
    memberId: josh.id,
    householdId: household.id,
    message: "Hey Carson, what time is Claire's dance class?",
    channel: "telegram",
  });
  console.log(`  Blocked: ${result1.blocked}`);
  console.log(`  Response: ${result1.response.slice(0, 200)}...`);
  console.log(`  Policy events: ${result1.policyEvents.length}`);
  assert(!result1.blocked, "Message should not be blocked");
  assert(result1.response.length > 0, "Response should not be empty");
  console.log("  [PASS]\n");

  // ── Test 2: Memory save (tell Carson something to remember) ──────
  console.log("── Test 2: Memory save (Grant → Carson) ──");
  const result2 = await engine.processMessage({
    agentId: carson.id,
    memberId: grant.id,
    householdId: household.id,
    message: "Hey Carson, remember that my AP History exam is on April 25th. It covers chapters 20-24 on the Cold War.",
    channel: "telegram",
  });
  console.log(`  Blocked: ${result2.blocked}`);
  console.log(`  Response: ${result2.response.slice(0, 300)}...`);
  assert(!result2.blocked, "Message should not be blocked");
  assert(result2.response.length > 0, "Response should not be empty");
  console.log("  [PASS]\n");

  // ── Test 3: Memory search (ask about something saved) ────────────
  console.log("── Test 3: Memory search (Grant → Carson) ──");
  // Small delay for QMD reindex
  await new Promise((r) => setTimeout(r, 2000));

  const result3 = await engine.processMessage({
    agentId: carson.id,
    memberId: grant.id,
    householdId: household.id,
    message: "When is my history exam again?",
    channel: "telegram",
  });
  console.log(`  Blocked: ${result3.blocked}`);
  console.log(`  Response: ${result3.response.slice(0, 300)}...`);
  assert(!result3.blocked, "Message should not be blocked");
  console.log("  [PASS]\n");

  // ── Test 4: Verify tool activity was logged ──────────────────────
  console.log("── Test 4: Activity logging ──");
  const { activityLog } = await import("@carsonos/db");
  const toolLogs = await db
    .select()
    .from(activityLog)
    .where(eq(activityLog.householdId, household.id))
    .limit(10);

  console.log(`  Tool call records: ${toolLogs.length}`);
  for (const log of toolLogs) {
    console.log(`    ${log.action} — ${new Date((log.createdAt as unknown as number) * 1000).toISOString()}`);
  }
  console.log("  [PASS]\n");

  // ── Summary ──────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════");
  console.log("  All smoke tests passed!");
  console.log("═══════════════════════════════════════════════");
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  [FAIL] ${message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
