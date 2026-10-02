import { Database } from "bun:sqlite";
import fs from "node:fs";

import { drizzle } from "drizzle-orm/bun-sqlite";

import type { DrizzleDb } from "./connection";
import * as schema from "./schema";
import { writeFileAtomic, writeFileAtomicSync } from "../lib/atomic-file";
import { open, seal } from "../lib/vault/crypto";
import { VAULT_SNAPSHOT_MAGIC, VAULT_SNAPSHOT_VERSION, snapshotAad } from "../lib/vault/format";
import { assertSchemaVersionSupported, readSchemaVersion } from "../lib/schema-version";

/**
 * The encrypted store (ADR-0008 §4.6). The running database is an in-memory
 * SQLite image; the only database file on disk is the AES-256-GCM snapshot
 * `dokan.db.enc`. Plaintext (and its WAL) never touch the disk: the snapshot is
 * written to a temp file, fsynced and renamed.
 *
 * Durability: the store marks the connection dirty after every committed unit
 * and every mutating store call; `persistIfDirty` serialises, encrypts and
 * replaces the snapshot. It never runs inside an open transaction (the store
 * sets `inTransaction`), so a rolled-back unit can never be persisted.
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
  close(): void;
  /** verify one encrypted snapshot file without touching the live database */
  validateSnapshotFile(filePath: string): boolean;
};

export type EncryptedConnectionOptions = {
  vaultId: string;
  masterKey: Uint8Array;
  snapshotPath: string;
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

/** Build the envelope: magic ‖ version ‖ nonce ‖ ciphertext+tag. */
function sealSnapshot(masterKey: Uint8Array, vaultId: string, image: Uint8Array): Buffer {
  const sealed = seal(masterKey, image, snapshotAad(vaultId));
  return Buffer.concat([VAULT_SNAPSHOT_MAGIC, Buffer.from([VAULT_SNAPSHOT_VERSION]), sealed]);
}

/** Decrypt an envelope; throws on tampering, wrong key, or an unknown format. */
function openSnapshot(masterKey: Uint8Array, vaultId: string, envelope: Uint8Array): Buffer {
  if (envelope.length <= VAULT_SNAPSHOT_MAGIC.length + 1) throw new Error("encrypted database is truncated");
  if (!Buffer.from(envelope.subarray(0, VAULT_SNAPSHOT_MAGIC.length)).equals(VAULT_SNAPSHOT_MAGIC)) {
    throw new Error("not a Dokan encrypted database");
  }
  const version = envelope[VAULT_SNAPSHOT_MAGIC.length];
  if (version !== VAULT_SNAPSHOT_VERSION) throw new Error(`unsupported encrypted database format ${String(version)}`);
  return open(masterKey, envelope.subarray(VAULT_SNAPSHOT_MAGIC.length + 1), snapshotAad(vaultId));
}

/** PRAGMA quick_check on a live connection (one text column). */
function quickCheckIsOk(db: Database): boolean {
  // SAFETY: PRAGMA quick_check returns exactly one row with a "quick_check" text column
  const row = db.query("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  return row?.quick_check === "ok";
}

export function createEncryptedConnection(options: EncryptedConnectionOptions): EncryptedConnection {
  const { vaultId, masterKey, snapshotPath } = options;
  let raw: Database;
  if (options.seedBytes !== undefined) {
    raw = Database.deserialize(options.seedBytes);
  } else if (!options.fresh && fs.existsSync(snapshotPath)) {
    const image = openSnapshot(masterKey, vaultId, fs.readFileSync(snapshotPath));
    raw = Database.deserialize(image);
  } else {
    // a fresh setup owns the path: drop any orphan from a crashed first attempt
    if (fs.existsSync(snapshotPath)) fs.rmSync(snapshotPath, { force: true });
    raw = new Database(":memory:");
  }
  raw.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(raw, { schema });
  let dirty = false;
  let persistQueue: Promise<void> = Promise.resolve();

  const connection: EncryptedConnection = {
    db,
    dbPath: snapshotPath,
    raw,
    inTransaction: false,
    vaultId,
    markDirty() {
      dirty = true;
    },
    async persistIfDirty() {
      if (!dirty) return;
      const run = persistQueue.then(async () => {
        // Re-check inside the queued task: a new transaction may have opened
        // after this call was scheduled, and serializing mid-unit would persist
        // pages a later ROLLBACK undoes. Leaving dirty=true defers the flush to
        // the unit's own COMMIT path.
        if (!dirty || connection.inTransaction) return;
        dirty = false;
        const image = raw.serialize();
        await writeFileAtomic(snapshotPath, sealSnapshot(masterKey, vaultId, image));
      });
      persistQueue = run.catch(() => undefined);
      await run;
    },
    async flush() {
      dirty = true;
      await connection.persistIfDirty();
    },
    checkpoint() {
      // backup/close seam: always materialise the snapshot synchronously so a
      // copyDatabaseTo can never copy a missing or stale file
      dirty = false;
      writeFileAtomicSync(snapshotPath, sealSnapshot(masterKey, vaultId, raw.serialize()));
    },
    close() {
      connection.checkpoint();
      raw.close();
    },
    validateSnapshotFile(filePath: string): boolean {
      let candidate: Database | null = null;
      try {
        const image = openSnapshot(masterKey, vaultId, fs.readFileSync(filePath));
        candidate = Database.deserialize(image);
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
