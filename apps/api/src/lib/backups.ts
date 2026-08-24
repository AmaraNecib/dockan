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

/** Manual export: checkpoint + copy right now, whatever today's file holds. */
export async function createBackup({ store, dataDir }: { store: StorePort; dataDir: string }): Promise<BackupResult> {
  const dest = backupFilePath(dataDir);
  await store.copyDatabaseTo(dest);
  return { path: dest, createdAt: localDateTime() };
}

/**
 * Startup daily backup: creates today's file only when it does not exist yet,
 * so restarting the app ten times a day never multiplies copies. Returns
 * `created: false` when today's copy already exists.
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
  if (fs.existsSync(dest)) return { path: dest, created: false };
  await store.copyDatabaseTo(dest);
  return { path: dest, created: true };
}
