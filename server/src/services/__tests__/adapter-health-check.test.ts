/**
 * Regression test for the /api/health adapter probe.
 *
 * Before v0.5.1 the Claude Agent SDK adapter's healthCheck() shelled out to
 * `which claude` to verify CLI presence. The SDK adapter doesn't actually
 * use the `claude` CLI at runtime (that's only `ClaudeCodeAdapter`), so the
 * probe was a copy-paste vestige that returned false-negatives on hosts
 * where the CLI was installed outside the launchd service PATH (e.g., the
 * official installer at `~/.local/bin/claude`).
 *
 * The fix at subprocess-adapter.ts ClaudeAgentSdkAdapter.healthCheck()
 * dropped the CLI probe and returns `true` unconditionally — the SDK
 * module already loaded successfully if the adapter constructed.
 *
 * This test pins that contract so a future "let's add a probe back" change
 * has to consciously update both this test and the explanation comment.
 */

import { describe, it, expect } from "vitest";
import { createAdapter } from "../subprocess-adapter.js";

describe("ClaudeAgentSdkAdapter.healthCheck", () => {
  it("returns true unconditionally — does not shell out to `which claude`", async () => {
    const adapter = createAdapter("anthropic-sdk");
    const originalPath = process.env.PATH;
    try {
      // Clear PATH so any vestigial `execFileSync('which', ['claude'])` would
      // fail. If we ever regress the fix and add a CLI probe back, this test
      // will catch it because the adapter would return false here.
      process.env.PATH = "";
      const healthy = await adapter.healthCheck();
      expect(healthy).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("reports the correct adapter name", () => {
    const adapter = createAdapter("anthropic-sdk");
    expect(adapter.name).toBe("claude-agent-sdk");
  });
});
