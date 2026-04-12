/**
 * Boot-time update check.
 *
 * Runs `git fetch` + `git rev-list --count HEAD..origin/main` to see
 * if the local checkout is behind. Logs a message if updates are available.
 * Non-blocking — failures are silently ignored.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function checkForUpdates(projectDir: string): Promise<void> {
  try {
    // Quick fetch (refs only, no files)
    await execFileAsync("git", ["fetch", "origin", "--quiet"], {
      cwd: projectDir,
      timeout: 10_000,
    });

    // Count commits behind
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--count", "HEAD..origin/main"],
      { cwd: projectDir, timeout: 5_000 },
    );

    const behind = parseInt(stdout.trim(), 10);
    if (behind > 0) {
      const word = behind === 1 ? "commit" : "commits";
      console.log(
        `[update] ${behind} ${word} behind origin/main — run ./scripts/update-service.sh to update`,
      );
    }
  } catch {
    // Never break boot over an update check
  }
}
