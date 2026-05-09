import { describe, it, expect } from "vitest";
import { computeHasProfile } from "../constitution-engine.js";

describe("computeHasProfile", () => {
  it("returns false when both sources are null", () => {
    expect(computeHasProfile(null, null)).toBe(false);
  });

  it("returns false when both sources are undefined", () => {
    expect(computeHasProfile(undefined, undefined)).toBe(false);
  });

  it("returns false when both sources are empty strings", () => {
    expect(computeHasProfile("", "")).toBe(false);
  });

  it("returns false when both sources contain only whitespace", () => {
    expect(computeHasProfile("   \n\t  ", "  \n  ")).toBe(false);
  });

  it("returns true when only the legacy DB column has content", () => {
    expect(computeHasProfile(null, "Grant is 17 and loves music.")).toBe(true);
  });

  // Regression test for the bug where firstContact was incorrectly true
  // when the profile lived only on disk (USER.md, the v0.5 preference).
  it("returns true when only the disk-based USER.md has content (profileContent is null)", () => {
    const userMd = "# Grant\n\nGrant is a high-school junior who plays guitar.\n";
    expect(computeHasProfile(userMd, null)).toBe(true);
  });

  it("returns true when only the disk-based USER.md has content (profileContent is empty string)", () => {
    const userMd = "# Grant\n\nGrant is a high-school junior who plays guitar.\n";
    expect(computeHasProfile(userMd, "")).toBe(true);
  });

  it("returns true when both sources have content", () => {
    expect(computeHasProfile("# Grant\n\ndisk profile", "db profile")).toBe(true);
  });

  it("isFirstContact derivation: disk-only profile + non-parent role yields firstContact=false", () => {
    // Mirrors the engine's derivation:
    //   const hasProfile = computeHasProfile(userMd, profileContent);
    //   const isFirstContact = !hasProfile && member.role !== "parent";
    const userMdContent = "# Elsie\n\nElsie is 9 and loves horses.\n";
    const profileContent: string | null = null;
    const role: string = "child";

    const hasProfile = computeHasProfile(userMdContent, profileContent);
    const isFirstContact = !hasProfile && role !== "parent";

    expect(hasProfile).toBe(true);
    expect(isFirstContact).toBe(false);
  });

  it("isFirstContact derivation: empty disk + empty DB + non-parent role yields firstContact=true", () => {
    const role: string = "child";
    const hasProfile = computeHasProfile(null, null);
    const isFirstContact = !hasProfile && role !== "parent";

    expect(hasProfile).toBe(false);
    expect(isFirstContact).toBe(true);
  });
});
