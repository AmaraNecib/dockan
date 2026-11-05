import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { localDate, localDateTime } from "./logger";
import type { StorePort } from "../store/port";
import { z } from "zod";

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

export type ExternalBackupStatus = {
  destination: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: "disconnected" | "unwritable" | "full" | "invalid" | null;
  lastPath: string | null;
};

const EXTERNAL_BACKUP_SETTINGS = "external-backup.json";
const externalBackupStatusSchema = z.object({
  destination: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.enum(["disconnected", "unwritable", "full", "invalid"]).nullable(),
  lastPath: z.string().nullable(),
});

function externalSettingsPath(dataDir: string): string {
  return path.join(dataDir, EXTERNAL_BACKUP_SETTINGS);
}

/** Read the persisted destination and last outcome without touching the drive. */
export function readExternalBackupStatus(dataDir: string): ExternalBackupStatus {
  try {
    const parsed = externalBackupStatusSchema.safeParse(JSON.parse(fs.readFileSync(externalSettingsPath(dataDir), "utf8")));
    return parsed.success ? parsed.data : { destination: null, lastAttemptAt: null, lastSuccessAt: null, lastError: null, lastPath: null };
  } catch {
    return { destination: null, lastAttemptAt: null, lastSuccessAt: null, lastError: null, lastPath: null };
  }
}

async function persistExternalBackupStatus(dataDir: string, status: ExternalBackupStatus): Promise<void> {
  const settingsPath = externalSettingsPath(dataDir);
  const partial = `${settingsPath}.partial.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    await fs.promises.writeFile(partial, JSON.stringify(status), { flag: "wx" });
    await fs.promises.rename(partial, settingsPath);
  } finally {
    try { await fs.promises.unlink(partial); } catch { /* already renamed or never created */ }
  }
}

/** Save a destination. Null is an explicit cancellation/no-change signal. */
export async function setExternalBackupDestination(dataDir: string, destination: string | null): Promise<ExternalBackupStatus> {
  const current = readExternalBackupStatus(dataDir);
  if (destination === null) return current;
  const selected = path.resolve(destination.trim());
  if (!destination.trim()) throw new Error("BACKUP_DESTINATION_REQUIRED");
  const next = { ...current, destination: selected };
  await persistExternalBackupStatus(dataDir, next);
  return next;
}

/** Make a unique, validated encrypted copy without replacing any existing set. */
export async function createExternalBackup({ store, dataDir, validate }: {
  store: StorePort;
  dataDir: string;
  validate: BackupFileValidator;
}): Promise<ExternalBackupStatus> {
  const current = readExternalBackupStatus(dataDir);
  if (!current.destination) return current;
  const at = localDateTime();
  const targetDir = current.destination;
  const stem = `dokan-${at.replaceAll(":", "-")}-${process.pid}-${crypto.randomBytes(5).toString("hex")}.dknvbak`;
  const dest = path.join(targetDir, stem);
  const partial = `${dest}.partial.${crypto.randomBytes(6).toString("hex")}`;
  let next: ExternalBackupStatus;
  try {
    await fs.promises.access(targetDir, fs.constants.W_OK);
    await store.copyDatabaseTo(partial);
    if (!validate(partial)) throw new Error("BACKUP_INVALID");
    // The destination name includes a cryptographic nonce; rename publishes the
    // already-validated file atomically and never reuses the daily local name.
    await fs.promises.rename(partial, dest);
    next = { ...current, lastAttemptAt: at, lastSuccessAt: at, lastError: null, lastPath: dest };
  } catch (error) {
    const codeValue = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
    const codeResult = z.string().safeParse(codeValue);
    const code = codeResult.success ? codeResult.data : undefined;
    const lastError = error instanceof Error && error.message === "BACKUP_INVALID"
      ? "invalid"
      : code === "ENOSPC" || code === "EDQUOT" ? "full"
        : code === "ENOENT" || code === "ENODEV" || code === "EIO" ? "disconnected" : "unwritable";
    next = { ...current, lastAttemptAt: at, lastError };
  } finally {
    try { await fs.promises.unlink(partial); } catch { /* partial absent or destination was unavailable */ }
  }
  await persistExternalBackupStatus(dataDir, next);
  return next;
}

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
