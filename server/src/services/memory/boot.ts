/**
 * Memory boot — initializes QMD collections at startup.
 *
 * Creates a "household" collection for shared family memory,
 * plus one collection per family member. Members can override
 * their memory directory (e.g., to point at an existing brain).
 */

import { eq } from "drizzle-orm";
import type { Db } from "@carsonos/db";
import { familyMembers, households } from "@carsonos/db";
import type { MemoryConfig } from "../../config.js";
import { QmdMemoryProvider } from "./qmd-provider.js";

/**
 * Boot the memory system: create QMD provider and register
 * collections for the household + each family member.
 */
export async function bootMemory(
  db: Db,
  config: MemoryConfig,
): Promise<QmdMemoryProvider> {
  const provider = new QmdMemoryProvider(config.rootDir);

  // Find all households (typically just one)
  const allHouseholds = await db.select().from(households);

  for (const household of allHouseholds) {
    // Shared household collection
    await provider.ensureCollection("household");

    // Per-member collections
    const members = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.householdId, household.id));

    for (const member of members) {
      const slug = member.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      const dirOverride = member.memoryDir ?? undefined;
      await provider.ensureCollection(slug, dirOverride);
    }
  }

  return provider;
}
