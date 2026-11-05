import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { localDate, localDateTime } from "./logger";
import { SnapshotPersistenceError } from "../db/encrypted-connection";
import { readVaultBackupBundle } from "./vault/backup";
import { VaultLockLostError } from "./vault/lock";
import type { StorePort } from "../store/port";
import { z } from "zod";
import type { ExternalBackupStatus } from "@dokan/contracts";

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

const EXTERNAL_BACKUP_SETTINGS = "external-backup.json";
const externalBackupStatusSchema = z.object({
  destination: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.enum(["disconnected", "unwritable", "full", "invalid"]).nullable(),
  lastPath: z.string().nullable(),
});
const emptyExternalBackupStatus: ExternalBackupStatus = {
  destination: null, lastAttemptAt: null, lastSuccessAt: null, lastError: null, lastPath: null,
};
const externalBackupQueues = new Map<string, Promise<void>>();

function externalSettingsPath(dataDir: string): string {
  return path.join(dataDir, EXTERNAL_BACKUP_SETTINGS);
}

/** One queue serializes destination changes, copy outcomes, and metadata writes per data folder. */
async function serializeExternalBackup<T>(dataDir: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(dataDir);
  const previous = externalBackupQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  externalBackupQueues.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (externalBackupQueues.get(key) === queued) externalBackupQueues.delete(key);
  }
}

/** Read the persisted destination and outcome without touching the external drive. */
export function readExternalBackupStatus(dataDir: string): ExternalBackupStatus {
  try {
    const parsed = externalBackupStatusSchema.safeParse(JSON.parse(fs.readFileSync(externalSettingsPath(dataDir), "utf8")));
    return parsed.success ? parsed.data : emptyExternalBackupStatus;
  } catch {
    return emptyExternalBackupStatus;
  }
}

async function persistExternalBackupStatus(
  dataDir: string,
  status: ExternalBackupStatus,
  writeGuard: () => void,
): Promise<void> {
  writeGuard();
  const settingsPath = externalSettingsPath(dataDir);
  const partial = `${settingsPath}.partial.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
  const handle = await fs.promises.open(partial, "wx");
  try {
    writeGuard();
    await handle.writeFile(JSON.stringify(status));
    writeGuard();
    await handle.sync();
    writeGuard();
    await fs.promises.rename(partial, settingsPath);
    writeGuard();
  } finally {
    await handle.close();
    try {
      writeGuard();
      await fs.promises.unlink(partial);
      writeGuard();
    } catch { /* partial absent or the protected folder is no longer ours */ }
  }
}

function ensureExternalDestinationIsSeparate(dataDir: string, destination: string): string {
  const resolvedData = fs.realpathSync(dataDir);
  const resolvedDestination = fs.realpathSync(destination);
  const relative = path.relative(resolvedData, resolvedDestination);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("BACKUP_DESTINATION_INSIDE_DATA");
  }
  return resolvedDestination;
}

/** Save or cancel a destination. Changing it clears outcome attribution but never touches old backup sets. */
export async function setExternalBackupDestination(
  dataDir: string,
  destination: string | null,
  writeGuard: () => void = () => undefined,
): Promise<ExternalBackupStatus> {
  const selected = destination === null ? null : path.resolve(destination.trim());
  if (destination !== null && !destination.trim()) throw new Error("BACKUP_DESTINATION_REQUIRED");
  return serializeExternalBackup(dataDir, async () => {
    writeGuard();
    const current = readExternalBackupStatus(dataDir);
    if (current.destination === selected) return current;
    const next: ExternalBackupStatus = selected === null
      ? emptyExternalBackupStatus
      : { ...emptyExternalBackupStatus, destination: selected };
    await persistExternalBackupStatus(dataDir, next, writeGuard);
    return next;
  });
}

async function reserveExternalBackupDirectory(parent: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = `dokan-backup-${Date.now()}-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    const directory = path.join(parent, name);
    try {
      await fs.promises.mkdir(directory);
      return directory;
    } catch (error) {
      const codeValue = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
      if (z.string().safeParse(codeValue).success && codeValue === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("BACKUP_DESTINATION_COLLISION");
}

const externalBackupFailureSchema = z.object({ message: z.string().optional(), code: z.string().optional() });
type ExternalBackupFailure = z.infer<typeof externalBackupFailureSchema>;

function classifyExternalBackupError(error: ExternalBackupFailure): ExternalBackupStatus["lastError"] {
  const code = error.code;
  if (error.message === "BACKUP_INVALID") return "invalid";
  if (code === "ENOSPC" || code === "EDQUOT") return "full";
  if (code === "ENOENT" || code === "ENODEV" || code === "EIO") return "disconnected";
  return "unwritable";
}

/**
 * Copy a validated self-contained encrypted vault bundle. A fresh directory is
 * exclusively reserved with mkdir; publication is a same-directory rename to
 * a fixed filename that no prior backup set can contain.
 */
export async function createExternalBackup({ store, dataDir, validate, writeGuard = () => undefined }: {
  store: StorePort;
  dataDir: string;
  validate: BackupFileValidator;
  writeGuard?: () => void;
}): Promise<ExternalBackupStatus> {
  return serializeExternalBackup(dataDir, async () => {
    writeGuard();
    const current = readExternalBackupStatus(dataDir);
    if (!current.destination) return current;
    const at = localDateTime();
    let ownedDirectory: string | undefined;
    let externalPartial: string | undefined;
    const staging = path.join(dataDir, `.external-backup-${process.pid}-${crypto.randomBytes(8).toString("hex")}.partial`);
    let next: ExternalBackupStatus;
    try {
      const targetDir = ensureExternalDestinationIsSeparate(dataDir, current.destination);
      await fs.promises.access(targetDir, fs.constants.W_OK);
      writeGuard();
      await store.copyDatabaseTo(staging);
      writeGuard();
      const encryptedBundle = readVaultBackupBundle(fs.readFileSync(staging));
      if (encryptedBundle === undefined || !validate(staging)) throw new Error("BACKUP_INVALID");
      ownedDirectory = await reserveExternalBackupDirectory(targetDir);
      writeGuard();
      const partial = path.join(ownedDirectory, "dokan-backup.dknvbak.partial");
      externalPartial = partial;
      const finalPath = path.join(ownedDirectory, "dokan-backup.dknvbak");
      await fs.promises.copyFile(staging, partial, fs.constants.COPYFILE_EXCL);
      writeGuard();
      const partialFile = await fs.promises.open(partial, "r+");
      try { await partialFile.sync(); } finally { await partialFile.close(); }
      writeGuard();
      if (readVaultBackupBundle(fs.readFileSync(partial)) === undefined || !validate(partial)) {
        throw new Error("BACKUP_INVALID");
      }
      writeGuard();
      await fs.promises.rename(partial, finalPath);
      writeGuard();
      next = { ...current, lastAttemptAt: at, lastSuccessAt: at, lastError: null, lastPath: finalPath };
    } catch (error) {
      if (error instanceof VaultLockLostError || error instanceof SnapshotPersistenceError) throw error;
      if (ownedDirectory !== undefined) {
        try {
          writeGuard();
          if (externalPartial !== undefined) {
            await fs.promises.unlink(externalPartial);
            writeGuard();
          }
          await fs.promises.rmdir(ownedDirectory);
          writeGuard();
        } catch { /* an unavailable destination may leave only this attempt's partial namespace */ }
      }
      const failure = externalBackupFailureSchema.safeParse(error);
      next = { ...current, lastAttemptAt: at, lastError: classifyExternalBackupError(failure.success ? failure.data : {}) };
    } finally {
      try {
        writeGuard();
        await fs.promises.unlink(staging);
      } catch { /* no staging file or the protected folder is no longer ours */ }
    }
    await persistExternalBackupStatus(dataDir, next, writeGuard);
    return next;
  });
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
