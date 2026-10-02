import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/bun-sqlite";

import type { DrizzleDb } from "./connection";
import * as schema from "./schema";
import { cleanupStalePartials, writeFileAtomic, writeFileAtomicSync } from "../lib/atomic-file";
import { createVaultBackupBundle, readVaultBackupBundle } from "../lib/vault/backup";
import { open, seal } from "../lib/vault/crypto";
import { VAULT_SNAPSHOT_MAGIC, VAULT_SNAPSHOT_VERSION, parseVaultHeader, snapshotAad } from "../lib/vault/format";
import { assertSchemaVersionSupported, readSchemaVersion } from "../lib/schema-version";

/**
 * The encrypted store (ADR-0008 §4.6). The running database is an in-memory
 * SQLite image; the only database file on disk is the AES-256-GCM snapshot
 * `dokan.db.enc`. Plaintext (and its WAL) never touch the disk: the snapshot is
 * written to a temp file, fsynced and renamed.
 *
 * Durability: the store marks the connection dirty after every committed unit
 * and every mutating store call; `persistIfDirty` serialises, encrypts and
 * replaces the snapshot, and only then reports success. The version counters
 * below mean a failed write is retried instead of being mistaken for saved
 * data, and `inTransaction` keeps a rolled-back unit out of the snapshot.
 *
 * KNOWN DEFERRED (issue #142, do not fix in this lane): two sidecars on the
 * same data dir both hold in-memory images and last-writer-wins the snapshot.
 * A single-writer lock for the vault data dir is the follow-up; the desktop
 * shell runs exactly one sidecar today.
 */

export type EncryptedConnection = {
  db: DrizzleDb;
  /** live database "file" for backup reporting: the encrypted snapshot path */
  dbPath: string;
  raw: Database;
  /** true while an explicit multi-statement unit is open */
  inTransaction: boolean;
  /** the vault this connection belongs to (binds the snapshot AEAD context) */
  vaultId: string;
  markDirty(): void;
  persistIfDirty(): Promise<void>;
  flush(): Promise<void>;
  checkpoint(): void;
  close(): Promise<void>;
  /** verify one encrypted snapshot OR self-contained backup bundle */
  validateSnapshotFile(filePath: string): boolean;
  /** write a self-contained backup (header wraps + snapshot) to destPath */
  writeBackupTo(destPath: string): Promise<void>;
  /**
   * Production fail-stop hook: called when a snapshot write fails after
   * retries. main.ts exits the process here, because a committed SQLite unit
   * that cannot be persisted must never be reported as a failed business
   * operation (the client would retry and duplicate it).
   */
  onFatalError?: (error: Error) => void;
};

export type EncryptedConnectionOptions = {
  vaultId: string;
  masterKey: Uint8Array;
  snapshotPath: string;
  /** header path; required to write self-contained backup bundles */
  headerPath?: string;
  /** decrypted SQLite image to adopt (legacy migration); absent = fresh database */
  seedBytes?: Uint8Array;
  /**
   * First-run semantics: with no seed, any file already at `snapshotPath` is
   * an orphan of an earlier uncommitted attempt (the header does not exist, so
   * its key was discarded) and is overwritten instead of decrypted. Unlock
   * paths never set this: a committed snapshot must authenticate or refuse.
   */
  fresh?: boolean;
};

/** An unlock found a vault header but no encrypted database: the data is gone. */
export class MissingVaultDatabaseError extends Error {
  constructor() {
    super("VAULT_DATABASE_MISSING");
    this.name = "MissingVaultDatabaseError";
  }
}

/**
 * A committed vault's snapshot cannot be read: truncated, tampered, or sealed
 * with a different key/vault than the header unlocked. The master key already
 * authenticated against the header, so this is never a wrong passphrase.
 */
export class VaultCorruptionError extends Error {
  constructor(detail: string) {
    super(`VAULT_CORRUPT: ${detail}`);
    this.name = "VaultCorruptionError";
  }
}

/** A committed unit could not be written to its durable snapshot. */
export class SnapshotPersistenceError extends Error {
  constructor(cause: Error) {
    super(`snapshot persistence failed: ${cause.message}`);
    this.name = "SnapshotPersistenceError";
  }
}

const WRITE_ATTEMPTS = 3;
const WRITE_RETRY_DELAY_MS = 50;

/** Build the envelope: magic ‖ version ‖ nonce ‖ ciphertext+tag. */
function sealSnapshot(masterKey: Uint8Array, vaultId: string, image: Uint8Array): Buffer {
  const sealed = seal(masterKey, image, snapshotAad(vaultId));
  return Buffer.concat([VAULT_SNAPSHOT_MAGIC, Buffer.from([VAULT_SNAPSHOT_VERSION]), sealed]);
}

/** Decrypt an envelope; structural damage and bad keys are both corruption here. */
function openSnapshot(masterKey: Uint8Array, vaultId: string, envelope: Uint8Array): Buffer {
  if (envelope.length <= VAULT_SNAPSHOT_MAGIC.length + 1) throw new VaultCorruptionError("snapshot is truncated");
  if (!Buffer.from(envelope.subarray(0, VAULT_SNAPSHOT_MAGIC.length)).equals(VAULT_SNAPSHOT_MAGIC)) {
    throw new VaultCorruptionError("snapshot has no Dokan header");
  }
  const version = envelope[VAULT_SNAPSHOT_MAGIC.length];
  if (version !== VAULT_SNAPSHOT_VERSION) throw new VaultCorruptionError(`unsupported snapshot format ${String(version)}`);
  return open(masterKey, envelope.subarray(VAULT_SNAPSHOT_MAGIC.length + 1), snapshotAad(vaultId));
}

/** PRAGMA quick_check on a live connection (one text column). */
function quickCheckIsOk(db: Database): boolean {
  // SAFETY: PRAGMA quick_check returns exactly one row with a "quick_check" text column
  const row = db.query("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  return row?.quick_check === "ok";
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createEncryptedConnection(options: EncryptedConnectionOptions): EncryptedConnection {
  const { vaultId, snapshotPath, headerPath } = options;
  // a crashed writer can leave `.dokan.db.enc.tmp-*` behind; drop them before
  // opening so they cannot accumulate or be mistaken for the database
  cleanupStalePartials(path.dirname(snapshotPath), path.basename(snapshotPath));
  // The connection owns an independent copy of the key. The manager zeroes the
  // buffer it handed over when the vault is re-unlocked or closed, and a live
  // connection must never end up sealing with a zeroed reference.
  const connectionKey = Buffer.from(options.masterKey);
  let raw: Database;
  if (options.seedBytes !== undefined) {
    raw = Database.deserialize(options.seedBytes);
  } else if (options.fresh !== true) {
    if (!fs.existsSync(snapshotPath)) {
      connectionKey.fill(0);
      throw new MissingVaultDatabaseError();
    }
    // the master key already authenticated against the header, so ANY failure
    // to open the committed snapshot is corruption, never a wrong passphrase
    let image: Buffer;
    try {
      image = openSnapshot(connectionKey, vaultId, fs.readFileSync(snapshotPath));
    } catch (error) {
      connectionKey.fill(0);
      throw new VaultCorruptionError(error instanceof Error ? error.message : String(error));
    }
    raw = Database.deserialize(image);
  } else {
    // a fresh setup owns the path: drop any orphan from a crashed first attempt
    if (fs.existsSync(snapshotPath)) fs.rmSync(snapshotPath, { force: true });
    raw = new Database(":memory:");
  }
  raw.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(raw, { schema });

  /** increments on every mutation; a snapshot covers the version it serialized */
  let mutationVersion = 0;
  /** the mutation version covered by the last successful snapshot write */
  let persistedVersion = 0;
  let persistQueue: Promise<void> = Promise.resolve();

  async function persistNow(): Promise<void> {
    if (mutationVersion === persistedVersion) return;
    // never serialize an open unit: a later ROLLBACK would be undone by the
    // stored image, so the flush waits for COMMIT (which calls back here)
    if (connection.inTransaction) return;
    const version = mutationVersion;
    const envelope = sealSnapshot(connectionKey, vaultId, raw.serialize());
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
      try {
        await writeFileAtomic(snapshotPath, envelope);
        // only now is the version durable; a mutation during the write set
        // mutationVersion beyond `version` and schedules the next flush
        persistedVersion = version;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < WRITE_ATTEMPTS) await delay(WRITE_RETRY_DELAY_MS);
      }
    }
    throw new SnapshotPersistenceError(lastError ?? new Error("unknown write failure"));
  }

  const connection: EncryptedConnection = {
    db,
    dbPath: snapshotPath,
    raw,
    inTransaction: false,
    vaultId,
    markDirty() {
      mutationVersion += 1;
    },
    async persistIfDirty() {
      if (mutationVersion === persistedVersion) return;
      const run = persistQueue.then(() => persistNow());
      persistQueue = run.catch(() => undefined);
      await run;
    },
    async flush() {
      // force a write even when nothing changed: the first snapshot after setup
      // and explicit checkpoints must never be skipped by version bookkeeping
      mutationVersion += 1;
      await connection.persistIfDirty();
    },
    checkpoint() {
      // Shutdown/backup seam. An open transaction means the last COMMITTED
      // image is already on disk; serializing now would capture uncommitted
      // pages that a ROLLBACK could undo, so skip and leave the dirty version
      // for the post-commit flush.
      if (connection.inTransaction) return;
      if (mutationVersion === persistedVersion && fs.existsSync(snapshotPath)) return;
      writeFileAtomicSync(snapshotPath, sealSnapshot(connectionKey, vaultId, raw.serialize()));
      persistedVersion = mutationVersion;
    },
    async close() {
      // wait for an in-flight async snapshot write, then checkpoint the current
      // version synchronously: a clean shutdown can never lose to the queue
      await persistQueue.catch(() => undefined);
      connection.checkpoint();
      connectionKey.fill(0);
      raw.close();
    },
    validateSnapshotFile(filePath: string): boolean {
      let candidate: Database | null = null;
      try {
        const bytes = fs.readFileSync(filePath);
        const bundle = readVaultBackupBundle(bytes);
        if (bundle !== undefined) {
          // a self-contained backup must belong to this vault's header/keys
          if (parseVaultHeader(bundle.headerText).vaultId !== vaultId) return false;
          candidate = Database.deserialize(openSnapshot(connectionKey, vaultId, bundle.snapshot));
        } else {
          candidate = Database.deserialize(openSnapshot(connectionKey, vaultId, bytes));
        }
        return quickCheckIsOk(candidate);
      } catch {
        return false;
      } finally {
        try {
          candidate?.close();
        } catch {
          /* already closed */
        }
      }
    },
    async writeBackupTo(destPath: string): Promise<void> {
      connection.checkpoint();
      if (headerPath === undefined) throw new Error("this vault connection has no header path; cannot build a backup");
      const headerText = fs.readFileSync(headerPath, "utf8");
      const snapshot = fs.readFileSync(snapshotPath);
      await writeFileAtomic(destPath, createVaultBackupBundle(headerText, snapshot));
    },
  };
  return connection;
}

/** A legacy plaintext database read into a serialised image for migration. */
export type LegacyDatabaseImage = { image: Buffer; schemaVersion: number };

/**
 * Read a legacy plaintext database into a serialised image for migration.
 * Checkpoints the WAL and switches off WAL first: `serialize()` on a WAL-mode
 * database produces an image the in-memory deserialiser refuses. The schema
 * version is checked BEFORE any write (a newer database is refused untouched).
 */
export function readLegacyDatabaseImage(legacyPath: string): LegacyDatabaseImage {
  if (!fs.existsSync(legacyPath)) throw new Error(`legacy database not found at ${legacyPath}`);
  const db = new Database(legacyPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const schemaVersion = readSchemaVersion(db);
    assertSchemaVersionSupported(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.exec("PRAGMA journal_mode = DELETE;");
    if (!quickCheckIsOk(db)) throw new Error("legacy database failed quick_check; refusing to migrate it");
    const image = db.serialize();
    if (image.subarray(0, 16).toString("utf8") !== "SQLite format 3\u0000") {
      throw new Error("legacy database is not a SQLite file");
    }
    return { image, schemaVersion };
  } finally {
    db.close();
  }
}
