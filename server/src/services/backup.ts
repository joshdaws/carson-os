/**
 * Database backup utility.
 *
 * Creates timestamped SQLite backups before migrations and at boot.
 * Keeps the last N backups and prunes older ones.
 *
 * Backups are stored in {dataDir}/backups/ as plain SQLite copies.
 * Restore: cp ~/.carsonos/backups/carsonos-2026-04-12-1400.db ~/.carsonos/carsonos.db
 */

import { copyFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX_BACKUPS = 7;

export function getBackupDir(dataDir: string): string {
  const dir = join(dataDir, "backups");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a timestamped backup of the database file.
 * Returns the backup file path, or null if the source doesn't exist.
 */
export function backupDatabase(dbPath: string, dataDir: string, reason?: string): string | null {
  if (!existsSync(dbPath)) {
    return null;
  }

  const backupDir = getBackupDir(dataDir);
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const suffix = reason ? `-${reason}` : "";
  const backupName = `carsonos-${timestamp}${suffix}.db`;
  const backupPath = join(backupDir, backupName);

  copyFileSync(dbPath, backupPath);
  console.log(`[backup] ${backupName} (${reason ?? "manual"})`);

  pruneOldBackups(backupDir);

  return backupPath;
}

/**
 * Keep only the most recent MAX_BACKUPS files.
 */
function pruneOldBackups(backupDir: string): void {
  const files = readdirSync(backupDir)
    .filter((f) => f.startsWith("carsonos-") && f.endsWith(".db"))
    .sort()
    .reverse();

  for (const file of files.slice(MAX_BACKUPS)) {
    unlinkSync(join(backupDir, file));
  }
}
