import fs from "node:fs";
import path from "node:path";

import { localDate, localDateTime } from "./logger";
import type { StorePort } from "../store/port";

/**
 * Backups (ticket 13). A backup is a consistent copy of the SQLite file made
 * by checkpointing WAL and copying — the store seam already owns that
 * (`copyDatabaseTo`), so this module only adds naming, location policy and
 * the once-per-day rule. Files live under `<dataDir>/backups/` named
 * `dokan-YYYY-MM-DD.db` (Algeria local date), so a USB-stick copy set is
 * sortable and one-per-day by construction.
 */

/** absolute path of the backups directory for a data dir */
export function backupDirFor(dataDir: string): string {
  return path.join(dataDir, "backups");
}

/** `dokan-YYYY-MM-DD.db` for an Algeria-local date string */
export function backupFileNameFor(localDateString: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDateString)) {
    throw new Error(`backup date must be YYYY-MM-DD, got "${localDateString}"`);
  }
  return `dokan-${localDateString}.db`;
}

/** absolute dest path of today's (or a given day's) backup file */
export function backupFilePath(dataDir: string, localDateString: string = localDate()): string {
  return path.join(backupDirFor(dataDir), backupFileNameFor(localDateString));
}

export type BackupResult = { path: string; createdAt: string };

/**
 * SAFETY: SQLite files start with the 16-byte magic string "SQLite format 3\0"
 * (https://www.sqlite.org/fileformat.html#the_database_header). A truncated or
 * half-written copy virtually never carries it, so this cheap probe rejects
 * incomplete files without running a full integrity_check.
 */
function looksLikeSqliteFile(p: string): boolean {
  try {
    const fd = fs.openSync(p, "r");
    try {
      const header = Buffer.alloc(16);
      const bytes = fs.readSync(fd, header, 0, 16, 0);
      return bytes === 16 && header.toString("latin1") === "SQLite format 3\0";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Checkpoint + copy into place safely: write to a `.partial` sibling first,
 * then rename over the destination. Rename is atomic within the same
 * directory, so a crash mid-copy can never leave a truncated file under the
 * real backup name — only a disposable `.partial`. Any pre-existing corrupt
 * destination (e.g. written by older code) is overwritten.
 */
async function writeBackupCopy(store: StorePort, dest: string): Promise<void> {
  const partial = `${dest}.partial`;
  try {
    await store.copyDatabaseTo(partial);
    await fs.promises.rename(partial, dest);
  } finally {
    // best effort: never leave a stale partial behind after a failed copy
    try {
      fs.unlinkSync(partial);
    } catch {
      /* nothing to clean up */
    }
  }
}

/** Manual export: checkpoint + copy right now, whatever today's file holds. */
export async function createBackup({ store, dataDir }: { store: StorePort; dataDir: string }): Promise<BackupResult> {
  const dest = backupFilePath(dataDir);
  await writeBackupCopy(store, dest);
  return { path: dest, createdAt: localDateTime() };
}

/**
 * Startup daily backup: creates today's file only when a *valid* one does not
 * exist yet, so restarting the app ten times a day never multiplies copies.
 * Existence alone is not trust: a truncated or corrupt file (crash mid-copy,
 * full disk) fails the SQLite-header probe and is rebuilt from the live db.
 * Returns `created: false` when today's valid copy already exists.
 */
export async function ensureDailyBackup({
  store,
  dataDir,
  today = localDate(),
}: {
  store: StorePort;
  dataDir: string;
  /** injectable for tests */
  today?: string;
}): Promise<{ path: string; created: boolean }> {
  const dest = backupFilePath(dataDir, today);
  if (fs.existsSync(dest) && looksLikeSqliteFile(dest)) return { path: dest, created: false };
  await writeBackupCopy(store, dest);
  return { path: dest, created: true };
}
