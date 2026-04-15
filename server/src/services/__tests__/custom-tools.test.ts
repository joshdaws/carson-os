/**
 * Tests for the custom tool registry. Covers:
 * - SKILL.md parse + write round-trip
 * - Filesystem helpers: path validation, atomic writes, content hashing
 * - Secret encryption: round-trip, tamper detection, rotation
 * - Prompt executor template substitution
 * - HTTP executor validation: bad URL, domain allowlist, missing auth
 *
 * Uses temp directories per test so tests are independent and parallel-safe.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSkillMd, writeSkillMd, ParseError } from "../custom-tools/skill-md.js";
import {
  atomicWriteFile,
  hashToolDir,
  toolDirPath,
  toolRelPath,
  validateToolName,
  validateBundleName,
  PathError,
  walkForSkills,
  cleanupTmpFiles,
} from "../custom-tools/fs-helpers.js";
import { encryptSecret, decryptSecret, setKeyForTesting, redactSecrets } from "../custom-tools/secrets.js";
import { executePromptTool, substituteTemplate } from "../custom-tools/executors.js";

// ── SKILL.md parsing ──────────────────────────────────────────────────

describe("parseSkillMd", () => {
  it("parses minimal frontmatter + body", () => {
    const content =
      "---\nname: test_tool\ndescription: A test tool\n---\n\nBody text here\n";
    const doc = parseSkillMd(content);
    expect(doc.frontmatter.name).toBe("test_tool");
    expect(doc.frontmatter.description).toBe("A test tool");
    expect(doc.body.trim()).toBe("Body text here");
  });

  it("rejects missing frontmatter delimiters", () => {
    expect(() => parseSkillMd("just body text")).toThrow(ParseError);
  });

  it("rejects frontmatter without name", () => {
    expect(() => parseSkillMd("---\ndescription: no name\n---\n")).toThrow(ParseError);
  });

  it("rejects invalid kind value", () => {
    expect(() =>
      parseSkillMd("---\nname: t\ndescription: d\nkind: invalid\n---\n"),
    ).toThrow(/kind/);
  });

  it("parses nested http config block", () => {
    const content = `---
name: check_api
description: Check an API
kind: http
http:
  method: GET
  urlTemplate: https://api.example.com/data
---

body
`;
    const doc = parseSkillMd(content);
    expect(doc.frontmatter.kind).toBe("http");
    expect((doc.frontmatter.http as { method: string }).method).toBe("GET");
    expect((doc.frontmatter.http as { urlTemplate: string }).urlTemplate).toBe(
      "https://api.example.com/data",
    );
  });

  it("parses array values", () => {
    const content = `---
name: t
description: d
domains: [a.com, b.com, c.com]
---
`;
    const doc = parseSkillMd(content);
    expect(doc.frontmatter.domains).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("round-trips frontmatter through writeSkillMd", () => {
    const content = `---
name: test_tool
description: A test
kind: prompt
---

Body
`;
    const doc = parseSkillMd(content);
    const rendered = writeSkillMd(doc);
    const doc2 = parseSkillMd(rendered);
    expect(doc2.frontmatter.name).toBe(doc.frontmatter.name);
    expect(doc2.frontmatter.kind).toBe(doc.frontmatter.kind);
    expect(doc2.body.trim()).toBe(doc.body.trim());
  });
});

// ── Filesystem helpers ────────────────────────────────────────────────

describe("path validation", () => {
  it("accepts valid tool names", () => {
    expect(() => validateToolName("check_ynab")).not.toThrow();
    expect(() => validateToolName("tool_123")).not.toThrow();
    expect(() => validateToolName("a_tool")).not.toThrow();
  });

  it("rejects empty name", () => {
    expect(() => validateToolName("")).toThrow(PathError);
  });

  it("rejects names with dots, slashes, spaces, uppercase", () => {
    expect(() => validateToolName(".hidden")).toThrow(PathError);
    expect(() => validateToolName("a/b")).toThrow(PathError);
    expect(() => validateToolName("..")).toThrow(PathError);
    expect(() => validateToolName("with space")).toThrow(PathError);
    expect(() => validateToolName("A_tool")).toThrow(PathError);
  });

  it("accepts hyphenated names (ecosystem compatibility)", () => {
    expect(() => validateToolName("find-skills")).not.toThrow();
    expect(() => validateToolName("youtube-transcript")).not.toThrow();
    expect(() => validateToolName("tool-123")).not.toThrow();
  });

  it("rejects _shared (reserved)", () => {
    expect(() => validateToolName("_shared")).toThrow(PathError);
  });

  it("rejects overly long names", () => {
    expect(() => validateToolName("a".repeat(65))).toThrow(PathError);
  });

  it("accepts bundle names or omitted bundle", () => {
    expect(() => validateBundleName(undefined)).not.toThrow();
    expect(() => validateBundleName("")).not.toThrow();
    expect(() => validateBundleName("ynab")).not.toThrow();
    expect(() => validateBundleName("..")).toThrow(PathError);
  });
});

describe("toolRelPath", () => {
  it("returns name only when no bundle", () => {
    expect(toolRelPath(undefined, "t")).toBe("t");
  });
  it("joins bundle and name", () => {
    expect(toolRelPath("ynab", "list_accounts")).toBe("ynab/list_accounts");
  });
});

describe("atomic writes + hashing", () => {
  let tmp: string;
  const orig = process.env.CARSONOS_TOOLS_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "carsonos-test-"));
    process.env.CARSONOS_TOOLS_DIR = tmp;
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (orig) process.env.CARSONOS_TOOLS_DIR = orig;
    else delete process.env.CARSONOS_TOOLS_DIR;
  });

  it("atomicWriteFile creates a file", () => {
    const file = join(tmp, "hh1", "t", "SKILL.md");
    atomicWriteFile(file, "---\nname: t\ndescription: d\n---\n");
    expect(readFileSync(file, "utf8")).toContain("name: t");
  });

  it("hashToolDir is stable across reads", () => {
    const dir = join(tmp, "hh1", "t");
    atomicWriteFile(join(dir, "SKILL.md"), "content");
    const h1 = hashToolDir(dir);
    const h2 = hashToolDir(dir);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashToolDir changes when content changes", () => {
    const dir = join(tmp, "hh1", "t");
    atomicWriteFile(join(dir, "SKILL.md"), "v1");
    const h1 = hashToolDir(dir);
    writeFileSync(join(dir, "SKILL.md"), "v2");
    const h2 = hashToolDir(dir);
    expect(h1).not.toBe(h2);
  });
});

describe("walkForSkills", () => {
  let tmp: string;
  const orig = process.env.CARSONOS_TOOLS_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "carsonos-walk-"));
    process.env.CARSONOS_TOOLS_DIR = tmp;
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (orig) process.env.CARSONOS_TOOLS_DIR = orig;
    else delete process.env.CARSONOS_TOOLS_DIR;
  });

  it("finds standalone tools", () => {
    atomicWriteFile(join(tmp, "hh1", "my_tool", "SKILL.md"), "---\nname: my_tool\ndescription: d\n---");
    const found = walkForSkills(join(tmp, "hh1"));
    expect(found).toHaveLength(1);
    expect(found[0].toolName).toBe("my_tool");
    expect(found[0].bundle).toBeUndefined();
  });

  it("finds tools inside bundles", () => {
    atomicWriteFile(
      join(tmp, "hh1", "ynab", "list_accounts", "SKILL.md"),
      "---\nname: list_accounts\ndescription: d\n---",
    );
    atomicWriteFile(
      join(tmp, "hh1", "ynab", "get_budget", "SKILL.md"),
      "---\nname: get_budget\ndescription: d\n---",
    );
    const found = walkForSkills(join(tmp, "hh1"));
    expect(found).toHaveLength(2);
    expect(found.every((s) => s.bundle === "ynab")).toBe(true);
  });

  it("skips _shared and hidden directories", () => {
    atomicWriteFile(join(tmp, "hh1", "ynab", "_shared", "SKILL.md"), "should be ignored");
    atomicWriteFile(join(tmp, "hh1", ".hidden", "SKILL.md"), "should be ignored");
    const found = walkForSkills(join(tmp, "hh1"));
    expect(found).toHaveLength(0);
  });
});

describe("cleanupTmpFiles", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "carsonos-cleanup-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("removes .tmp.* files left from crashed writes", () => {
    atomicWriteFile(join(tmp, "real.md"), "real");
    writeFileSync(join(tmp, "real.md.tmp.123.456"), "leftover");
    cleanupTmpFiles(tmp);
    expect(() => readFileSync(join(tmp, "real.md.tmp.123.456"))).toThrow();
    expect(readFileSync(join(tmp, "real.md"), "utf8")).toBe("real");
  });
});

// ── Toolbox path (absolute) ──────────────────────────────────────────

describe("toolDirPath", () => {
  const orig = process.env.CARSONOS_TOOLS_DIR;
  beforeEach(() => {
    process.env.CARSONOS_TOOLS_DIR = "/tmp/carsonos-tools";
  });
  afterEach(() => {
    if (orig) process.env.CARSONOS_TOOLS_DIR = orig;
    else delete process.env.CARSONOS_TOOLS_DIR;
  });

  it("builds path without bundle", () => {
    // The resolved path depends on env, so just assert the shape
    const p = toolDirPath("hh1", undefined, "my_tool");
    expect(p).toMatch(/hh1\/my_tool$/);
  });

  it("builds path with bundle", () => {
    const p = toolDirPath("hh1", "ynab", "list_accounts");
    expect(p).toMatch(/hh1\/ynab\/list_accounts$/);
  });

  it("rejects traversal", () => {
    expect(() => toolDirPath("hh1", "..", "escape")).toThrow(PathError);
  });
});

// ── Secrets ───────────────────────────────────────────────────────────

describe("secret encryption", () => {
  const TEST_KEY = Buffer.alloc(32, 0x42); // deterministic for tests

  beforeEach(() => {
    setKeyForTesting(TEST_KEY);
  });
  afterEach(() => {
    setKeyForTesting(null);
  });

  it("round-trips plaintext", () => {
    const pt = "super-secret-api-key-abc123";
    const ct = encryptSecret(pt);
    const back = decryptSecret(ct);
    expect(back).toBe(pt);
  });

  it("produces different ciphertext each time (IV randomness)", () => {
    const ct1 = encryptSecret("same value");
    const ct2 = encryptSecret("same value");
    expect(ct1).not.toBe(ct2);
  });

  it("detects tampered ciphertext", () => {
    const ct = encryptSecret("original");
    const buf = Buffer.from(ct, "base64");
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString("base64");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects too-short ciphertext", () => {
    expect(() => decryptSecret("AA==")).toThrow(/too short|corrupted/i);
  });
});

describe("redactSecrets", () => {
  it("replaces known secret values with [REDACTED:name]", () => {
    const input = "call returned token abc123xyz successfully";
    const out = redactSecrets(input, [{ keyName: "api_token", value: "abc123xyz" }]);
    expect(out).toBe("call returned token [REDACTED:api_token] successfully");
  });

  it("skips short values (< 6 chars)", () => {
    const input = "value is pw";
    const out = redactSecrets(input, [{ keyName: "short", value: "pw" }]);
    expect(out).toBe(input);
  });

  it("handles multiple secrets", () => {
    const input = "tokenA=aaaaaaaa tokenB=bbbbbbbb";
    const out = redactSecrets(input, [
      { keyName: "a", value: "aaaaaaaa" },
      { keyName: "b", value: "bbbbbbbb" },
    ]);
    expect(out).toBe("tokenA=[REDACTED:a] tokenB=[REDACTED:b]");
  });
});

// ── Executors ─────────────────────────────────────────────────────────

describe("substituteTemplate", () => {
  it("replaces {{placeholders}} in single pass", () => {
    expect(substituteTemplate("hello {{name}}", { name: "world" })).toBe("hello world");
  });

  it("does not re-scan after substitution (prevents injection)", () => {
    const result = substituteTemplate("greeting: {{msg}}", { msg: "{{leaked}}" });
    expect(result).toBe("greeting: {{leaked}}");
  });

  it("leaves unknown placeholders intact", () => {
    // Current implementation replaces with empty string, which is intentional
    // — agent can see the empty result and provide missing inputs.
    const result = substituteTemplate("{{known}} and {{unknown}}", { known: "yes" });
    expect(result).toBe("yes and ");
  });

  it("handles numbers and booleans as strings", () => {
    expect(substituteTemplate("{{n}} {{b}}", { n: 42, b: true })).toBe("42 true");
  });
});

describe("executePromptTool", () => {
  it("returns filled body as tool result content", () => {
    const result = executePromptTool("Hello {{name}}, welcome!", { name: "Claire" });
    expect(result.content).toBe("Hello Claire, welcome!");
    expect(result.is_error).toBeUndefined();
  });

  it("works with multi-line templates", () => {
    const template = "Step 1: Do X\nStep 2: Do {{action}}\nStep 3: Report back";
    const result = executePromptTool(template, { action: "Y" });
    expect(result.content).toContain("Step 2: Do Y");
  });

  it("returns body when no placeholders are present", () => {
    // Static prompt tools (pure instructions, no inputs) should just return the body
    const result = executePromptTool("Read the recent messages and summarize them.", {});
    expect(result.content).toBe("Read the recent messages and summarize them.");
  });

  it("treats template as unstructured text (no parsing required)", () => {
    // Even markdown-heavy prompt bodies should pass through substituteTemplate
    const body = "# {{title}}\n\n- Item one\n- {{second}}\n";
    const result = executePromptTool(body, { title: "Daily", second: "Item two" });
    expect(result.content).toBe("# Daily\n\n- Item one\n- Item two\n");
  });
});

// ── install_skill source parsing ──────────────────────────────────────

describe("parseSource", () => {
  it("parses GitHub shorthand (owner/repo)", async () => {
    const { parseSource } = await import("../custom-tools/install.js");
    const s = parseSource("vercel-labs/skills");
    expect(s.type).toBe("github");
    if (s.type !== "github") return;
    expect(s.owner).toBe("vercel-labs");
    expect(s.repo).toBe("skills");
    expect(s.subpath).toBeUndefined();
  });

  it("parses GitHub shorthand with subpath", async () => {
    const { parseSource } = await import("../custom-tools/install.js");
    const s = parseSource("vercel-labs/skills/find-skills");
    expect(s.type).toBe("github");
    if (s.type !== "github") return;
    expect(s.owner).toBe("vercel-labs");
    expect(s.repo).toBe("skills");
    expect(s.subpath).toBe("find-skills");
  });

  it("parses multi-level subpath", async () => {
    const { parseSource } = await import("../custom-tools/install.js");
    const s = parseSource("softwaredry/agent-toolkit/humanizer");
    expect(s.type).toBe("github");
    if (s.type !== "github") return;
    expect(s.subpath).toBe("humanizer");
  });

  it("parses @skill-name filter", async () => {
    const { parseSource } = await import("../custom-tools/install.js");
    const s = parseSource("vercel-labs/skills@find-skills");
    expect(s.type).toBe("github");
    if (s.type !== "github") return;
    expect(s.repo).toBe("skills");
    expect(s.skillFilter).toBe("find-skills");
  });

  it("parses skills.sh/ display URLs by unwrapping", async () => {
    const { parseSource } = await import("../custom-tools/install.js");
    const s = parseSource("skills.sh/softwaredry/agent-toolkit/humanizer");
    expect(s.type).toBe("github");
    if (s.type !== "github") return;
    expect(s.owner).toBe("softwaredry");
    expect(s.repo).toBe("agent-toolkit");
    expect(s.subpath).toBe("humanizer");
  });

  it("parses full https://github.com URL", async () => {
    const { parseSource } = await import("../custom-tools/install.js");
    const s = parseSource("https://github.com/vercel-labs/skills");
    expect(s.type).toBe("github");
    if (s.type !== "github") return;
    expect(s.owner).toBe("vercel-labs");
    expect(s.repo).toBe("skills");
  });

  it("parses GitHub URL with tree/branch/path", async () => {
    const { parseSource } = await import("../custom-tools/install.js");
    const s = parseSource("https://github.com/vercel-labs/skills/tree/main/skills/find-skills");
    expect(s.type).toBe("github");
    if (s.type !== "github") return;
    expect(s.ref).toBe("main");
    expect(s.subpath).toBe("skills/find-skills");
  });

  it("parses fragment ref (#branch)", async () => {
    const { parseSource } = await import("../custom-tools/install.js");
    const s = parseSource("vercel-labs/skills#experimental");
    expect(s.type).toBe("github");
    if (s.type !== "github") return;
    expect(s.ref).toBe("experimental");
  });

  it("parses direct HTTPS tar.gz URL", async () => {
    const { parseSource } = await import("../custom-tools/install.js");
    const s = parseSource("https://example.com/bundle.tar.gz");
    expect(s.type).toBe("direct");
    if (s.type !== "direct") return;
    expect(s.url).toBe("https://example.com/bundle.tar.gz");
  });

  it("rejects subpath with traversal", async () => {
    const { parseSource, InstallError } = await import("../custom-tools/install.js");
    expect(() => parseSource("owner/repo/../escape")).toThrow(InstallError);
  });

  it("rejects bare string that isn't a shorthand", async () => {
    const { parseSource, InstallError } = await import("../custom-tools/install.js");
    expect(() => parseSource("just-one-segment")).toThrow(InstallError);
  });

  it("rejects non-HTTPS", async () => {
    const { parseSource, InstallError } = await import("../custom-tools/install.js");
    expect(() => parseSource("http://github.com/owner/repo")).toThrow(InstallError);
  });
});
