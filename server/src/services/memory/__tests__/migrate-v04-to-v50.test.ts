/**
 * Tests for migrate_v04_to_v50: v0.4 flat-memory → v5.0 two-layer
 * migration. Covers idempotency, edge cases (`---` in body, empty
 * files, unknown frontmatter), and the restore-from-backup path.
 *
 * All tests use a temp data dir — never touches `~/.carsonos/`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  migrate,
  migrateFile,
  restoreFromBackup,
} from "../migrate-v04-to-v50.js";

let tmpDataDir: string;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "carsonos-migrate-test-"));
  mkdirSync(join(tmpDataDir, "memory", "household"), { recursive: true });
  mkdirSync(join(tmpDataDir, "memory", "josh"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
});

function plantMemory(collection: string, filename: string, content: string): string {
  const path = join(tmpDataDir, "memory", collection, filename);
  writeFileSync(path, content, "utf-8");
  return path;
}

function silentLog(): (msg: string) => void {
  return () => undefined;
}

// ── Entity-type migration ───────────────────────────────────────────

describe("entity-type migration", () => {
  it("converts a person memory to two-layer with provenance", async () => {
    const filePath = plantMemory(
      "household",
      "2026-04-21-grant-daws.md",
      `---
id: 2026-04-21-grant-daws
type: person
title: Grant Daws
created: 2026-04-21
source: telegram
captured_by: josh
---

# Grant Daws

Eight-year-old. Loves musical theater. Cast as the Hatter in the spring
production of Wonderland.
`,
    );

    await migrate({ dataDir: tmpDataDir, log: silentLog() });

    const after = readFileSync(filePath, "utf-8");

    // Frontmatter contains migration_version + aliases
    expect(after).toMatch(/migration_version:\s*0\.5/);
    expect(after).toMatch(/aliases:\s*\[\]/);
    // Original frontmatter preserved
    expect(after).toMatch(/type:\s*person/);
    expect(after).toMatch(/source:\s*telegram/);
    expect(after).toMatch(/captured_by:\s*josh/);

    // Two-layer split present
    expect(after).toMatch(/^# Grant Daws/m);
    expect(after).toMatch(/Compiled view — provisional/);
    expect(after).toMatch(/^---$/m);

    // Atom carries provenance line
    expect(after).toMatch(
      /### 2026-04-21 \| source: telegram \| by: josh \| importance: 5/,
    );

    // Original body is preserved below the timeline header
    expect(after).toMatch(/Eight-year-old/);
    expect(after).toMatch(/cast as the Hatter/i);
  });

  it("uses migration-v04 / legacy as provenance fallbacks", async () => {
    const filePath = plantMemory(
      "josh",
      "2026-04-22-wonderland.md",
      `---
id: 2026-04-22-wonderland
type: project
title: Wonderland production
created: 2026-04-22
---

# Wonderland production

Spring play that Grant is in.
`,
    );

    await migrate({ dataDir: tmpDataDir, log: silentLog() });
    const after = readFileSync(filePath, "utf-8");

    expect(after).toMatch(
      /### 2026-04-22 \| source: migration-v04 \| by: legacy \| importance: 5/,
    );
  });

  it("recognizes the new v5 concept type as an entity", async () => {
    const filePath = plantMemory(
      "household",
      "2026-04-25-trust-over-permissions.md",
      `---
id: 2026-04-25-trust-over-permissions
type: concept
title: Trust over permissions
created: 2026-04-25
---

# Trust over permissions

We govern via autonomy levels and operating instructions, not ACLs.
`,
    );

    await migrate({ dataDir: tmpDataDir, log: silentLog() });
    const after = readFileSync(filePath, "utf-8");

    expect(after).toMatch(/^---$/m);
    expect(after).toMatch(/Compiled view — provisional/);
    expect(after).toMatch(/aliases:\s*\[\]/);
  });
});

// ── Flat-type migration ─────────────────────────────────────────────

describe("flat-type migration", () => {
  it("adds migration_version without splitting into two layers", async () => {
    const filePath = plantMemory(
      "josh",
      "2026-04-21-becca-tea.md",
      `---
id: 2026-04-21-becca-tea
type: preference
title: Becca prefers tea
created: 2026-04-21
strength: strong
---

# Becca prefers tea

Earl Grey, hot, twice a day.
`,
    );

    await migrate({ dataDir: tmpDataDir, log: silentLog() });
    const after = readFileSync(filePath, "utf-8");

    expect(after).toMatch(/migration_version:\s*0\.5/);
    expect(after).toMatch(/strength:\s*strong/); // existing fm preserved
    // No `---` separator inserted in body for flat types.
    const bodyOnly = after.split(/^---\n[\s\S]*?\n---\n/m)[1] ?? "";
    expect(bodyOnly).not.toMatch(/^---$/m);
    expect(bodyOnly).toMatch(/Earl Grey/);
  });
});

// ── Idempotency ─────────────────────────────────────────────────────

describe("idempotency", () => {
  it("re-running migrate is a no-op once migration_version is set", async () => {
    const filePath = plantMemory(
      "household",
      "2026-04-21-grant-daws.md",
      `---
id: 2026-04-21-grant-daws
type: person
title: Grant Daws
created: 2026-04-21
---

# Grant Daws

Body text.
`,
    );

    await migrate({ dataDir: tmpDataDir, log: silentLog() });
    const firstPass = readFileSync(filePath, "utf-8");

    await migrate({ dataDir: tmpDataDir, log: silentLog() });
    const secondPass = readFileSync(filePath, "utf-8");

    expect(secondPass).toBe(firstPass);
  });

  it("returns 'skipped' from migrateFile when migration_version is already 5.0", () => {
    const filePath = plantMemory(
      "josh",
      "already.md",
      `---
id: already
type: fact
title: Already migrated
created: 2026-04-25
migration_version: "5.0"
---

# Already migrated

Body.
`,
    );

    expect(migrateFile(filePath, false)).toBe("skipped");
  });
});

// ── Edge cases (test plan §Edge cases) ──────────────────────────────

describe("edge cases", () => {
  it("does NOT false-trigger idempotent skip on `---` used as a horizontal rule in body", async () => {
    // v0.4 file with `---` in body content. The eng-review-mandated
    // migration_version field replaces the fragile `---` heuristic;
    // this file must still migrate.
    const filePath = plantMemory(
      "josh",
      "decision-with-rule.md",
      `---
id: decision-with-rule
type: decision
title: Homeschool through 5th
created: 2026-04-15
---

# Homeschool through 5th

Section one talks about the choice.

---

Section two adds context. The horizontal rule above is body content,
not a layer separator.
`,
    );

    expect(migrateFile(filePath, false)).toBe("migrated");
    const after = readFileSync(filePath, "utf-8");
    expect(after).toMatch(/migration_version:\s*0\.5/);
    expect(after).toMatch(/Section one/);
    expect(after).toMatch(/Section two/);
  });

  it("skips empty / zero-byte files without error", async () => {
    plantMemory("josh", "empty.md", "");
    plantMemory("josh", "whitespace.md", "   \n\n\t \n");

    const result = await migrate({ dataDir: tmpDataDir, log: silentLog() });

    expect(result.errors).toEqual([]);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
  });

  it("preserves unknown frontmatter keys", async () => {
    const filePath = plantMemory(
      "josh",
      "weird.md",
      `---
id: weird
type: fact
title: Weird memory
created: 2026-04-20
mystery_field: unique_value
custom_array:
  - one
  - two
---

# Weird memory

Body.
`,
    );

    await migrate({ dataDir: tmpDataDir, log: silentLog() });
    const after = readFileSync(filePath, "utf-8");

    expect(after).toMatch(/mystery_field:\s*unique_value/);
    expect(after).toMatch(/custom_array:/);
    expect(after).toMatch(/^\s+- one$/m);
    expect(after).toMatch(/^\s+- two$/m);
  });

  it("skips operational files (RESOLVER.md, _-prefixed)", async () => {
    plantMemory("household", "RESOLVER.md", "# Resolver template body, not a memory");
    plantMemory(
      "household",
      "_disagreements.md",
      "# Disagreements\n\nNot a memory entry.",
    );
    plantMemory(
      "household",
      "_enrichment-log.md",
      "# Enrichment log\n\nLogs go here.",
    );

    const before = readFileSync(
      join(tmpDataDir, "memory", "household", "RESOLVER.md"),
      "utf-8",
    );

    await migrate({ dataDir: tmpDataDir, log: silentLog() });

    const after = readFileSync(
      join(tmpDataDir, "memory", "household", "RESOLVER.md"),
      "utf-8",
    );
    expect(after).toBe(before);
  });

  it("skips files with no frontmatter at all", async () => {
    const filePath = plantMemory(
      "josh",
      "plain-note.md",
      "# Just a note\n\nNo frontmatter, not a v0.4 memory.\n",
    );
    const before = readFileSync(filePath, "utf-8");

    await migrate({ dataDir: tmpDataDir, log: silentLog() });

    expect(readFileSync(filePath, "utf-8")).toBe(before);
  });
});

// ── Backup + restore ────────────────────────────────────────────────

describe("backup creation", () => {
  it("creates a tarball containing manifest, memory dir, and DB if present", async () => {
    plantMemory(
      "josh",
      "2026-04-21-grant.md",
      `---
id: 2026-04-21-grant
type: person
title: Grant
created: 2026-04-21
---

# Grant

Body.
`,
    );
    writeFileSync(join(tmpDataDir, "carsonos.db"), "fake-db-bytes", "utf-8");

    const result = await migrate({ dataDir: tmpDataDir, log: silentLog() });
    expect(result.backupPath).not.toBeNull();
    expect(existsSync(result.backupPath!)).toBe(true);

    // Tarball lives in {dataDir}/backups/.
    expect(result.backupPath!).toContain(join(tmpDataDir, "backups"));
    expect(result.backupPath!).toMatch(/pre-v50-.*\.tar\.gz$/);
  });

  it("--dry-run skips backup and writes", async () => {
    const filePath = plantMemory(
      "josh",
      "2026-04-21-becca.md",
      `---
id: 2026-04-21-becca
type: person
title: Becca
created: 2026-04-21
---

# Becca

Body.
`,
    );
    const before = readFileSync(filePath, "utf-8");

    const result = await migrate({
      dataDir: tmpDataDir,
      dryRun: true,
      log: silentLog(),
    });

    expect(result.backupPath).toBeNull();
    expect(result.migrated).toBe(1);
    expect(readFileSync(filePath, "utf-8")).toBe(before);
    // No backups dir created on dry-run.
    expect(existsSync(join(tmpDataDir, "backups"))).toBe(false);
  });
});

describe("restore from backup", () => {
  it("reverts the live state to the pre-migration snapshot", async () => {
    const filePath = plantMemory(
      "josh",
      "2026-04-21-grant.md",
      `---
id: 2026-04-21-grant
type: person
title: Grant
created: 2026-04-21
---

# Grant

Original body.
`,
    );
    const original = readFileSync(filePath, "utf-8");

    const result = await migrate({ dataDir: tmpDataDir, log: silentLog() });
    expect(result.backupPath).not.toBeNull();

    // Confirm migration changed the file.
    const migrated = readFileSync(filePath, "utf-8");
    expect(migrated).not.toBe(original);

    // Restore.
    await restoreFromBackup(result.backupPath!, {
      dataDir: tmpDataDir,
      currentVersion: "0.4.2.1",
      log: silentLog(),
    });

    // File content matches the pre-migration original.
    const restored = readFileSync(filePath, "utf-8");
    expect(restored).toBe(original);
  });

  it("rejects a backup from a different CarsonOS version unless forceVersionMismatch", async () => {
    plantMemory(
      "josh",
      "2026-04-21-grant.md",
      `---
id: 2026-04-21-grant
type: person
title: Grant
created: 2026-04-21
---

# Grant

Body.
`,
    );

    const result = await migrate({ dataDir: tmpDataDir, log: silentLog() });
    expect(result.backupPath).not.toBeNull();

    await expect(
      restoreFromBackup(result.backupPath!, {
        dataDir: tmpDataDir,
        currentVersion: "9.9.9.9",
        log: silentLog(),
      }),
    ).rejects.toThrow(/Version mismatch/);

    // forceVersionMismatch lets it through.
    await restoreFromBackup(result.backupPath!, {
      dataDir: tmpDataDir,
      currentVersion: "9.9.9.9",
      forceVersionMismatch: true,
      log: silentLog(),
    });
  });
});

// ── Type translation (gbrain → v5 mapping) ──────────────────────────

describe("type translation", () => {
  it("translates `contact` → `person` and adds 'contact' to topics", async () => {
    const filePath = plantMemory(
      "household",
      "ad-robles.md",
      `---
id: ad-robles
type: contact
title: AD Robles
created: 2026-04-21
---

# AD Robles

YouTube personality, tech recruiter by day.
`,
    );

    await migrate({ dataDir: tmpDataDir, log: silentLog() });
    const after = readFileSync(filePath, "utf-8");

    expect(after).toMatch(/type:\s*person/);
    expect(after).toMatch(/migration_version:\s*0\.5/);
    expect(after).toMatch(/^\s+- contact$/m);
    // Translated to person → entity → two-layer split must appear.
    expect(after).toMatch(/Compiled view — provisional/);
    expect(after).toMatch(/^---$/m);
    // Original body preserved as atom.
    expect(after).toMatch(/YouTube personality/);
  });

  it("translates `meeting` → `event` and adds topic", async () => {
    const filePath = plantMemory(
      "household",
      "2026-04-15-school-meeting.md",
      `---
id: 2026-04-15-school-meeting
type: meeting
title: School parent-teacher meeting
created: 2026-04-15
---

# School parent-teacher meeting

Notes from the meeting.
`,
    );

    await migrate({ dataDir: tmpDataDir, log: silentLog() });
    const after = readFileSync(filePath, "utf-8");

    expect(after).toMatch(/type:\s*event/);
    expect(after).toMatch(/^\s+- meeting$/m);
    // event is a flat type — no two-layer split.
    expect(after).not.toMatch(/Compiled view — provisional/);
  });

  it("translates `insight` → `concept` and adds topic", async () => {
    const filePath = plantMemory(
      "household",
      "trust-over-permissions.md",
      `---
id: trust-over-permissions
type: insight
title: Trust over permissions
created: 2026-04-20
---

# Trust over permissions

Govern via autonomy + operating instructions, not ACLs.
`,
    );

    await migrate({ dataDir: tmpDataDir, log: silentLog() });
    const after = readFileSync(filePath, "utf-8");

    expect(after).toMatch(/type:\s*concept/);
    expect(after).toMatch(/^\s+- insight$/m);
    expect(after).toMatch(/Compiled view — provisional/);
  });

  it("preserves existing topics when adding the translation tag", async () => {
    const filePath = plantMemory(
      "household",
      "ad-robles.md",
      `---
id: ad-robles
type: contact
title: AD Robles
created: 2026-04-21
topics:
  - tech-recruiter
  - friend
---

# AD Robles

Body.
`,
    );

    await migrate({ dataDir: tmpDataDir, log: silentLog() });
    const after = readFileSync(filePath, "utf-8");

    expect(after).toMatch(/^\s+- tech-recruiter$/m);
    expect(after).toMatch(/^\s+- friend$/m);
    expect(after).toMatch(/^\s+- contact$/m);
  });

  it("re-migrates a previously-migrated file when its type is now in the translation table", async () => {
    // Simulate a file that went through an earlier conservative pass:
    // already has `migration_version: 5.0` but type is still `contact`.
    const filePath = plantMemory(
      "household",
      "old-contact.md",
      `---
id: old-contact
type: contact
title: Some contact
created: 2026-04-21
migration_version: "5.0"
---

# Some contact

Body that was preserved by the earlier flat-treatment pass.
`,
    );

    expect(migrateFile(filePath, false)).toBe("migrated");
    const after = readFileSync(filePath, "utf-8");

    expect(after).toMatch(/type:\s*person/);
    expect(after).toMatch(/^\s+- contact$/m);
    // Body is preserved — we don't re-wrap an already-translated file.
    expect(after).toMatch(/Body that was preserved/);
  });

  it("a v5-type file at migration_version 5.0 stays skipped (no false re-migration)", () => {
    const filePath = plantMemory(
      "household",
      "stable-fact.md",
      `---
id: stable-fact
type: fact
title: Stable fact
created: 2026-04-21
migration_version: "5.0"
---

# Stable fact

Body.
`,
    );

    expect(migrateFile(filePath, false)).toBe("skipped");
  });

  it("untranslated unknown type stays as-is (flat treatment)", async () => {
    const filePath = plantMemory(
      "household",
      "weird-type.md",
      `---
id: weird-type
type: sweep
title: Some sweep
created: 2026-04-21
---

# Some sweep

Body.
`,
    );

    await migrate({ dataDir: tmpDataDir, log: silentLog() });
    const after = readFileSync(filePath, "utf-8");

    expect(after).toMatch(/type:\s*sweep/);
    expect(after).toMatch(/migration_version:\s*0\.5/);
    expect(after).not.toMatch(/Compiled view — provisional/);
  });
});

// ── Collection-scoped migration (SPIKE step 2) ──────────────────────

describe("collection scoping", () => {
  it("migrates only files in the named collection when --collection is set", async () => {
    const joshFile = plantMemory(
      "josh",
      "in-scope.md",
      `---
id: in-scope
type: person
title: In scope
created: 2026-04-21
---

# In scope

Body.
`,
    );
    const householdFile = plantMemory(
      "household",
      "out-of-scope.md",
      `---
id: out-of-scope
type: person
title: Out of scope
created: 2026-04-21
---

# Out of scope

Body.
`,
    );

    const result = await migrate({
      dataDir: tmpDataDir,
      collection: "josh",
      log: silentLog(),
    });
    expect(result.migrated).toBe(1);

    expect(readFileSync(joshFile, "utf-8")).toMatch(/migration_version:\s*0\.5/);
    expect(readFileSync(householdFile, "utf-8")).not.toMatch(/migration_version:/);
  });

  it("returns gracefully when the named collection doesn't exist", async () => {
    const result = await migrate({
      dataDir: tmpDataDir,
      collection: "no-such-member",
      log: silentLog(),
    });
    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.backupPath).toBeNull();
  });

  it("still creates a full backup (not just the collection) when --collection is set", async () => {
    plantMemory(
      "josh",
      "in-scope.md",
      `---
id: in-scope
type: fact
title: In scope
created: 2026-04-21
---

# In scope

Body.
`,
    );
    plantMemory(
      "household",
      "out-of-scope.md",
      `---
id: out-of-scope
type: fact
title: Out of scope
created: 2026-04-21
---

# Out of scope

Body.
`,
    );

    const result = await migrate({
      dataDir: tmpDataDir,
      collection: "josh",
      log: silentLog(),
    });
    expect(result.backupPath).not.toBeNull();
    expect(existsSync(result.backupPath!)).toBe(true);
    // Restore should bring back BOTH collections in their pre-migration shape.
    await restoreFromBackup(result.backupPath!, {
      dataDir: tmpDataDir,
      currentVersion: "0.4.2.1",
      log: silentLog(),
    });
    expect(readFileSync(join(tmpDataDir, "memory", "josh", "in-scope.md"), "utf-8"))
      .not.toMatch(/migration_version:/);
    expect(readFileSync(join(tmpDataDir, "memory", "household", "out-of-scope.md"), "utf-8"))
      .not.toMatch(/migration_version:/);
  });
});

// ── Recursive walk ─────────────────────────────────────────────────

describe("recursive walk", () => {
  it("migrates files in nested subdirectories", async () => {
    mkdirSync(join(tmpDataDir, "memory", "josh", "knowledge", "people"), {
      recursive: true,
    });
    const filePath = join(
      tmpDataDir,
      "memory",
      "josh",
      "knowledge",
      "people",
      "grant.md",
    );
    writeFileSync(
      filePath,
      `---
id: nested-grant
type: person
title: Grant (nested)
created: 2026-04-21
---

# Grant (nested)

Lives in a knowledge subtree.
`,
      "utf-8",
    );

    const result = await migrate({ dataDir: tmpDataDir, log: silentLog() });
    expect(result.migrated).toBe(1);

    const after = readFileSync(filePath, "utf-8");
    expect(after).toMatch(/migration_version:\s*0\.5/);
  });

  it("skips hidden directories like .git and .restore-staging", async () => {
    mkdirSync(join(tmpDataDir, "memory", ".git"), { recursive: true });
    writeFileSync(
      join(tmpDataDir, "memory", ".git", "config.md"),
      "should not be touched",
    );
    mkdirSync(join(tmpDataDir, "memory", ".restore-staging"), { recursive: true });

    plantMemory(
      "josh",
      "real.md",
      `---
id: real
type: fact
title: Real memory
created: 2026-04-21
---

# Real memory

Body.
`,
    );

    const result = await migrate({ dataDir: tmpDataDir, log: silentLog() });
    expect(result.migrated).toBe(1);

    // The .git/config.md should be untouched.
    const gitContent = readFileSync(
      join(tmpDataDir, "memory", ".git", "config.md"),
      "utf-8",
    );
    expect(gitContent).toBe("should not be touched");
  });
});
