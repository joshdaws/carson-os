/**
 * Tests for identity-files: USER.md and PERSONALITY.md helpers + the
 * one-time DB → file migration. All tests use a temp data dir.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hasIdentityContent,
  loadPersonalityMd,
  loadUserMd,
  personalityMdPath,
  slugifyName,
  userMdPath,
  writePersonalityMd,
  writeUserMd,
} from "../identity-files.js";

let tmpDataDir: string;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "carsonos-identity-test-"));
});

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("slugifyName", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(slugifyName("Grant Daws")).toBe("grant-daws");
  });
  it("strips non-alphanumeric, non-hyphen characters", () => {
    expect(slugifyName("J.J. O'Brien")).toBe("jj-obrien");
    expect(slugifyName("Becca!")).toBe("becca");
  });
  it("collapses multiple spaces", () => {
    expect(slugifyName("  Hudson   Sr.  ")).toBe("hudson-sr");
  });
});

describe("path helpers", () => {
  it("userMdPath puts USER.md under members/{slug}/", () => {
    expect(userMdPath("/data", "josh")).toBe("/data/members/josh/USER.md");
  });
  it("personalityMdPath puts PERSONALITY.md under agents/{slug}/", () => {
    expect(personalityMdPath("/data", "carson")).toBe(
      "/data/agents/carson/PERSONALITY.md",
    );
  });
});

describe("read helpers", () => {
  it("loadUserMd returns null for missing file", () => {
    expect(loadUserMd(tmpDataDir, "nobody")).toBeNull();
  });
  it("loadUserMd returns content for existing file", () => {
    mkdirSync(join(tmpDataDir, "members", "josh"), { recursive: true });
    writeFileSync(join(tmpDataDir, "members", "josh", "USER.md"), "Hello, Josh.\n");
    expect(loadUserMd(tmpDataDir, "josh")).toBe("Hello, Josh.\n");
  });
  it("loadPersonalityMd returns null for missing file", () => {
    expect(loadPersonalityMd(tmpDataDir, "carson")).toBeNull();
  });
  it("loadPersonalityMd returns content for existing file", () => {
    mkdirSync(join(tmpDataDir, "agents", "carson"), { recursive: true });
    writeFileSync(
      join(tmpDataDir, "agents", "carson", "PERSONALITY.md"),
      "Formal butler.\n",
    );
    expect(loadPersonalityMd(tmpDataDir, "carson")).toBe("Formal butler.\n");
  });
});

describe("write helpers", () => {
  it("writeUserMd creates parent directories", () => {
    writeUserMd(tmpDataDir, "new-member", "Body");
    expect(
      existsSync(join(tmpDataDir, "members", "new-member", "USER.md")),
    ).toBe(true);
    expect(loadUserMd(tmpDataDir, "new-member")).toBe("Body");
  });
  it("writePersonalityMd creates parent directories", () => {
    writePersonalityMd(tmpDataDir, "new-agent", "Body");
    expect(
      existsSync(join(tmpDataDir, "agents", "new-agent", "PERSONALITY.md")),
    ).toBe(true);
    expect(loadPersonalityMd(tmpDataDir, "new-agent")).toBe("Body");
  });
  it("write overwrites existing file", () => {
    writeUserMd(tmpDataDir, "x", "first");
    writeUserMd(tmpDataDir, "x", "second");
    expect(readFileSync(userMdPath(tmpDataDir, "x"), "utf-8")).toBe("second");
  });
});

describe("hasIdentityContent", () => {
  it("false when both sources are null", () => {
    expect(hasIdentityContent(null, null)).toBe(false);
  });
  it("false when both sources are undefined", () => {
    expect(hasIdentityContent(undefined, undefined)).toBe(false);
  });
  it("false when both sources are empty strings", () => {
    expect(hasIdentityContent("", "")).toBe(false);
  });
  it("false when both sources are whitespace only", () => {
    expect(hasIdentityContent("   \n\t ", " \n  ")).toBe(false);
  });
  it("true when only the legacy DB column has content", () => {
    expect(hasIdentityContent(null, "Grant is 17.")).toBe(true);
  });
  // Regression: onboarding checklist falsely reported "Build member profiles"
  // as incomplete when the profile lived only on disk (USER.md), and the
  // analogous bug for "Configure agent personalities" with PERSONALITY.md.
  it("true when only the disk-based file has content (DB null)", () => {
    expect(hasIdentityContent("# Grant\n\nProfile body.", null)).toBe(true);
  });
  it("true when only the disk-based file has content (DB empty string)", () => {
    expect(hasIdentityContent("# Grant\n\nProfile body.", "")).toBe(true);
  });
  it("true when both sources have content", () => {
    expect(hasIdentityContent("# disk", "db")).toBe(true);
  });
});

describe("hasIdentityContent integration with disk reads", () => {
  it("reflects USER.md on disk for a freshly-created member", () => {
    writeUserMd(tmpDataDir, "elsie", "# Elsie\n\nLoves horses.\n");
    const disk = loadUserMd(tmpDataDir, "elsie");
    // DB column is null for a v0.5+ disk-only profile.
    expect(hasIdentityContent(disk, null)).toBe(true);
  });
  it("reflects PERSONALITY.md on disk for a freshly-configured agent", () => {
    writePersonalityMd(tmpDataDir, "mozart", "# Mozart\n\nMusic specialist.\n");
    const disk = loadPersonalityMd(tmpDataDir, "mozart");
    expect(hasIdentityContent(disk, null)).toBe(true);
  });
  it("returns false for a member with neither USER.md nor DB content", () => {
    const disk = loadUserMd(tmpDataDir, "ghost");
    expect(hasIdentityContent(disk, null)).toBe(false);
  });
});
