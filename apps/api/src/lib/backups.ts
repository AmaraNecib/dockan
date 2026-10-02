import { Database } from "bun:sqlite";
import crypto from "node:crypto";
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
 * How a backup file is checked before it is trusted as today's copy. The
 * legacy database is a SQLite file (`isValidSqliteBackup`); an encrypted
 * snapshot is an AEAD container and is validated by the vault connection.
 * main.ts injects the vault validator in vault mode.
 */
export type BackupFileValidator = (path: string) => boolean;

/**
 * A file only counts as today's backup when it opens as a real SQLite db AND
 * passes `PRAGMA quick_check` — a magic header alone can survive a truncation
 * that cut whole pages off the tail (greptile P1 on the header-probe fix).
 * quick_check is O(db size) but runs once per day at startup, so the cost is
 * bounded by one daily copy of a small shop database.
 */
function isValidSqliteBackup(p: string): boolean {
  let copy: Database | null = null;
  try {
    // readonly: validation must never write to (or create WAL for) the backup
    copy = new Database(p, { readonly: true });
    // SAFETY: PRAGMA quick_check returns exactly one row with a "quick_check" text column
    const row = copy.query("PRAGMA quick_check").get() as
      | { quick_check?: string }
      | undefined;
    return row?.quick_check === "ok";
  } catch {
    return false;
  } finally {
    try {
      copy?.close();
    } catch {
      /* already closed */
    }
    // opening a WAL-mode copy read-only makes SQLite create empty -wal/-shm
    // sidecars beside it; remove them so the backups dir stays
    // one-file-per-day by construction
    for (const suffix of ["-wal", "-shm"] as const) {
      try {
        fs.unlinkSync(`${p}${suffix}`);
      } catch {
        /* sidecar was not created */
      }
    }
  }
}

/**
 * Checkpoint + copy into place safely: write to a unique `.partial` sibling
 * first, then rename over the destination. The partial name carries pid+random
 * bytes so two overlapping exports never race on one temp file (greptile P1:
 * a shared name let request B's rename fail ENOENT after A renamed first).
 * Rename is atomic within the same directory, so a crash mid-copy can never
 * leave a truncated file under the real backup name — only a disposable
 * `.partial.*`. Any pre-existing corrupt destination is overwritten.
 */
async function writeBackupCopy(store: StorePort, dest: string): Promise<void> {
  const partial = `${dest}.partial.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
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
 * full disk) fails the quick_check probe and is rebuilt from the live db.
 * Returns `created: false` when today's valid copy already exists.
 */
export async function ensureDailyBackup({
  store,
  dataDir,
  today = localDate(),
  validate = isValidSqliteBackup,
}: {
  store: StorePort;
  dataDir: string;
  /** injectable for tests */
  today?: string;
  /** backup-file check; defaults to the legacy SQLite quick_check probe */
  validate?: BackupFileValidator;
}): Promise<{ path: string; created: boolean }> {
  const dest = backupFilePath(dataDir, today);
  if (fs.existsSync(dest) && validate(dest)) return { path: dest, created: false };
  await writeBackupCopy(store, dest);
  return { path: dest, created: true };
}
