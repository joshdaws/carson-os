/**
 * Seed a test household for M1 smoke testing.
 *
 * Creates: Daws family household, 5 members, 1 personal agent (Carson),
 * staff assignments, a basic constitution, and memory collections.
 *
 * Usage: npx tsx server/src/test/seed-test-household.ts
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { createDb } from "@carsonos/db";
import {
  households,
  familyMembers,
  staffAgents,
  staffAssignments,
  constitutions,
} from "@carsonos/db";

const DATA_DIR = process.env.DATA_DIR ?? join(homedir(), ".carsonos");
const DB_PATH = join(DATA_DIR, "carsonos.db");

async function seed() {
  console.log(`[seed] Opening database at ${DB_PATH}`);
  const db = createDb(DB_PATH);

  // Check if household already exists
  const existing = await db.select().from(households);
  if (existing.length > 0) {
    console.log(`[seed] Household already exists: "${existing[0].name}" (${existing[0].id})`);
    console.log("[seed] Skipping seed to avoid duplicates. Delete DB to re-seed.");
    return;
  }

  const householdId = crypto.randomUUID();
  const joshId = crypto.randomUUID();
  const beccaId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  const claireId = crypto.randomUUID();
  const hudsonId = crypto.randomUUID();
  const carsonId = crypto.randomUUID();

  // 1. Household
  await db.insert(households).values({
    id: householdId,
    name: "The Smith Family",
    timezone: "America/Chicago",
  });
  console.log("[seed] Household created: The Smith Family");

  // 2. Family members
  await db.insert(familyMembers).values([
    {
      id: joshId,
      householdId,
      name: "Josh",
      role: "parent",
      age: 38,
      memoryDir: join(homedir(), "projects/brain"), // Use existing brain
    },
    {
      id: beccaId,
      householdId,
      name: "Becca",
      role: "parent",
      age: 37,
    },
    {
      id: grantId,
      householdId,
      name: "Grant",
      role: "kid",
      age: 17,
      profileContent: [
        "# About Grant",
        "",
        "## Personality & Temperament",
        "Quiet, thoughtful, competitive. Takes his time forming opinions but holds them strongly.",
        "",
        "## Interests & Passions",
        "Basketball, history, video games (especially strategy games). Learning to code.",
        "",
        "## Goals & Aspirations",
        "Wants to study computer science in college. Considering UT Austin or Texas A&M.",
        "",
        "## Learning Style",
        "Prefers short, direct explanations. Learns by doing, not reading. Gets frustrated with long lectures.",
        "",
        "## What the Agent Should Do",
        "Help with homework (especially history and math). Be a study buddy, not a tutor. Keep it casual.",
      ].join("\n"),
    },
    {
      id: claireId,
      householdId,
      name: "Claire",
      role: "kid",
      age: 6,
      profileContent: [
        "# About Claire",
        "",
        "## Personality & Temperament",
        "Energetic, creative, loves to talk. Gets excited easily. Can be dramatic.",
        "",
        "## Interests & Passions",
        "Art (especially drawing), dinosaurs, dance, playing pretend, her pet hamster Mr. Whiskers.",
        "",
        "## Learning Style",
        "Learns through stories and imagination. Responds well to praise and enthusiasm.",
        "",
        "## What the Agent Should Do",
        "Be playful and imaginative. Help with spelling and reading. Match her energy.",
      ].join("\n"),
    },
    {
      id: hudsonId,
      householdId,
      name: "Hudson",
      role: "kid",
      age: 3,
    },
  ]);
  console.log("[seed] 5 family members created");

  // 3. Staff agent: Carson (personal agent for the whole family)
  await db.insert(staffAgents).values({
    id: carsonId,
    householdId,
    name: "Carson",
    staffRole: "personal",
    specialty: null,
    visibility: "family",
    model: "claude-sonnet-4-20250514",
    status: "active",
    isHeadButler: true,
    autonomyLevel: "trusted",
    roleContent: [
      "You are Carson, the family's personal AI assistant.",
      "You help every member of the Daws family with whatever they need.",
      "You're reliable, warm, and practical. You remember things.",
      "For parents: help with scheduling, planning, household management.",
      "For kids: help with homework, answer questions, be a good companion.",
      "Always be age-appropriate. Match the tone to who you're talking to.",
    ].join("\n"),
    soulContent: [
      "You have the manner of a trusted family butler — professional but warm.",
      "You call everyone by their first name. You're not stiff or formal.",
      "With kids, you're playful and patient. With parents, you're efficient and direct.",
      "You have a dry sense of humor. You care genuinely about this family.",
      "You remember what matters to people and bring it up naturally.",
    ].join("\n"),
    operatingInstructions: [
      "- Josh prefers bullet points and short answers",
      "- The family attends church on Sunday mornings — don't schedule anything then",
      "- Grant's basketball practice is Tuesday/Thursday after school",
      "- Claire has dance class on Wednesdays at 4pm",
    ].join("\n"),
  });
  console.log("[seed] Agent created: Carson (head butler)");

  // 4. Staff assignments (Carson → all members)
  await db.insert(staffAssignments).values([
    { agentId: carsonId, memberId: joshId, relationship: "primary" },
    { agentId: carsonId, memberId: beccaId, relationship: "primary" },
    { agentId: carsonId, memberId: grantId, relationship: "primary" },
    { agentId: carsonId, memberId: claireId, relationship: "primary" },
    { agentId: carsonId, memberId: hudsonId, relationship: "primary" },
  ]);
  console.log("[seed] Assignments created: Carson → all 5 members");

  // 5. Constitution
  await db.insert(constitutions).values({
    id: crypto.randomUUID(),
    householdId,
    version: 1,
    isActive: true,
    document: [
      "## The Smith Family Constitution",
      "",
      "### Our Values",
      "We are a Christian family. We value faith, kindness, hard work, and humor.",
      "We treat each other with respect. We tell the truth.",
      "",
      "### Content Boundaries",
      "No content that contradicts our faith. No vulgar or crude language.",
      "Age-appropriate responses always. When in doubt, be more conservative.",
      "",
      "### How We Help",
      "Encourage learning and curiosity. Don't do homework for the kids — help them think through it.",
      "Respect bedtime schedules. Don't engage in long conversations after 8:30pm for the younger kids.",
      "",
      "### Privacy",
      "What kids share stays private from other kids. Parents can see everything.",
      "Don't share family information with anyone outside the household.",
    ].join("\n"),
  });
  console.log("[seed] Constitution created");

  console.log("\n[seed] Done! Test household ready.");
  console.log(`  Household: ${householdId}`);
  console.log(`  Josh:      ${joshId} (parent, memoryDir → ~/projects/brain)`);
  console.log(`  Becca:     ${beccaId} (parent)`);
  console.log(`  Grant:     ${grantId} (kid, 17)`);
  console.log(`  Claire:    ${claireId} (kid, 6)`);
  console.log(`  Hudson:    ${hudsonId} (kid, 3)`);
  console.log(`  Carson:    ${carsonId} (agent)`);
}

seed().catch((err) => {
  console.error("[seed] Fatal:", err);
  process.exit(1);
});
