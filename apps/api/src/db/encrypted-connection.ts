import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/bun-sqlite";

import type { DrizzleDb } from "./connection";
import * as schema from "./schema";
import { cleanupStalePartials, writeFileAtomic, writeFileAtomicSync } from "../lib/atomic-file";
import { createVaultBackupBundle, readVaultBackupBundle } from "../lib/vault/backup";
import { open, seal } from "../lib/vault/crypto";
import {
  MAX_SNAPSHOT_STAMP_BYTES,
  SNAPSHOT_FENCE_PREFIX_BYTES,
  VAULT_SNAPSHOT_LEGACY_VERSION,
  VAULT_SNAPSHOT_MAGIC,
  VAULT_SNAPSHOT_VERSION,
  fencedSnapshotAad,
  parseVaultHeader,
  readSnapshotFence,
  snapshotAad,
  type VaultWrap,
} from "../lib/vault/format";
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
 * Single writer (issue #142): the vault data folder is guarded by an exclusive
 * lock file (`lib/vault/lock.ts`) acquired before this connection opens, so two
 * sidecars on one folder can no longer load separate in-memory images and
 * last-writer-win the snapshot.
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
  /**
   * Re-read the fence on disk NOW (#292) and say whether the bytes there are
   * still this holder's. The holder's heartbeat calls it, so a snapshot a
   * zombie replaced while this holder was idle is detected within one
   * heartbeat instead of at the next persist, checkpoint or close. A foreign
   * stamp makes the version not durable, and it is logged: a silent case that
   * is at least named becomes diagnosable.
   */
  recheckFence(): void;
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
  /**
   * Called immediately before (and just after) every snapshot write; it must
   * throw when this process no longer owns the vault folder. The heartbeat
   * alone leaves a window in which a persist queued before the theft still
   * overwrites the new owner's snapshot (ADR-0012 clause 3).
   */
  writeGuard?: () => void;
  /**
   * The current holder's single-writer lock token, stamped into every snapshot
   * this connection writes (#280). A snapshot whose stamp is not this value was
   * written by another holder, so the bytes are not this connection's and its
   * version is not durable. Absent = unfenced: the legacy envelope is written
   * and read, exactly the pre-#280 behaviour.
   */
  writeStamp?: () => string;
  /**
   * Where the connection reports a fence it could not verify (#280): a snapshot
   * stamped by a former holder, the unstamped legacy envelope, or a fence that
   * would not read. Both are warnings, never refusals — an unverifiable
   * snapshot is rewritten rather than rejected — so the log is the only signal
   * that the bytes being served may be older than the last acknowledged
   * transaction.
   */
  logger?: { warn(event: string, message: string): void };
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
/** Ask twice: one retry absorbs a transient EBUSY. A decidable fence cannot change by asking again. */
const FENCE_READ_ATTEMPTS = 2;

/**
 * Build the envelope. With a holder stamp it is the fenced format (#280):
 * `magic ‖ 2 ‖ stampLen ‖ stamp ‖ sealed`, and the stamp is bound into the AAD
 * so a reader can trust whose bytes it holds. Without one it is the legacy
 * format, exactly what every released build wrote.
 */
function sealSnapshot(masterKey: Uint8Array, vaultId: string, image: Uint8Array, stamp: string | undefined): Buffer {
  if (stamp === undefined) {
    const sealed = seal(masterKey, image, snapshotAad(vaultId));
    return Buffer.concat([VAULT_SNAPSHOT_MAGIC, Buffer.from([VAULT_SNAPSHOT_LEGACY_VERSION]), sealed]);
  }
  const stampBytes = Buffer.from(stamp, "utf8");
  if (stampBytes.length === 0 || stampBytes.length > MAX_SNAPSHOT_STAMP_BYTES) {
    throw new Error(`the snapshot holder stamp must be 1..${MAX_SNAPSHOT_STAMP_BYTES} bytes`);
  }
  const sealed = seal(masterKey, image, fencedSnapshotAad(vaultId, stamp));
  return Buffer.concat([
    VAULT_SNAPSHOT_MAGIC,
    Buffer.from([VAULT_SNAPSHOT_VERSION]),
    Buffer.from([stampBytes.length]),
    stampBytes,
    sealed,
  ]);
}

/**
 * Public wrapper for callers that migrate a legacy plaintext database (e.g. a
 * historical backup) into the vault's encrypted format. Passing a holder stamp
 * fences the result; omitting it writes the legacy format.
 */
export function buildEncryptedSnapshot(masterKey: Uint8Array, vaultId: string, image: Uint8Array, stamp?: string): Buffer {
  return sealSnapshot(masterKey, vaultId, image, stamp);
}

/** A decrypted snapshot plus the fence it carried (undefined on the legacy format). */
type OpenedSnapshot = { image: Buffer; stamp: string | undefined };

/** Decrypt an envelope; structural damage and bad keys are both corruption here. */
function openSnapshot(masterKey: Uint8Array, vaultId: string, envelope: Uint8Array): OpenedSnapshot {
  if (envelope.length <= VAULT_SNAPSHOT_MAGIC.length + 1) throw new VaultCorruptionError("snapshot is truncated");
  if (!Buffer.from(envelope.subarray(0, VAULT_SNAPSHOT_MAGIC.length)).equals(VAULT_SNAPSHOT_MAGIC)) {
    throw new VaultCorruptionError("snapshot has no Dokan header");
  }
  const version = envelope[VAULT_SNAPSHOT_MAGIC.length];
  if (version !== VAULT_SNAPSHOT_LEGACY_VERSION && version !== VAULT_SNAPSHOT_VERSION) {
    throw new VaultCorruptionError(`unsupported snapshot format ${String(version)}`);
  }
  const fence = readSnapshotFence(envelope);
  if (fence === undefined) throw new VaultCorruptionError("snapshot is truncated");
  const aad = fence.stamp === undefined ? snapshotAad(vaultId) : fencedSnapshotAad(vaultId, fence.stamp);
  return { image: open(masterKey, envelope.subarray(fence.bodyOffset), aad), stamp: fence.stamp };
}

/** PRAGMA quick_check on a live connection (one text column). */
/**
 * Compare two headers' credential wraps as multisets. A backup bundle embeds
 * its header, and a backup whose wraps are stale would restore a header the
 * owner can no longer open with their current passphrase/recovery keys
 * (round-7 finding 3).
 */
function wrapsMatch(left: VaultWrap[], right: VaultWrap[]): boolean {
  if (left.length !== right.length) return false;
  const identity = (wrap: VaultWrap): string => `${wrap.kind}:${wrap.id}:${wrap.salt}:${wrap.nonce}:${wrap.ciphertext}`;
  const leftIds = left.map(identity).sort();
  const rightIds = right.map(identity).sort();
  return leftIds.every((value, index) => value === rightIds[index]);
}

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
  // The holder's own lock token is stamped into every snapshot this connection
  // writes (#280); a snapshot carrying a different stamp is another holder's, so
  // its version is not durable. No callback = unfenced (the legacy envelope).
  const connectionStamp = options.writeStamp?.();
  let fenceSatisfied = connectionStamp === undefined;
  /**
   * The stamp the disk carried the last time it was read, so one change to a
   * foreign stamp is one log line however many times the disk is read: the
   * heartbeat notices a replacement and the next write notices it too, and
   * those are the same event, not two.
   */
  let observedStamp: { value: string | undefined } | undefined;
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
    let opened: OpenedSnapshot;
    try {
      opened = openSnapshot(connectionKey, vaultId, fs.readFileSync(snapshotPath));
    } catch (error) {
      connectionKey.fill(0);
      throw new VaultCorruptionError(error instanceof Error ? error.message : String(error));
    }
    // a legacy envelope, or one stamped by a former holder, is not this
    // holder's: the first write repairs the fence (#280)
    if (connectionStamp !== undefined) {
      fenceSatisfied = opened.stamp === connectionStamp;
      // Surfaced, never silent. These bytes were writable by a holder that is
      // no longer the holder, so the newest acknowledged transactions may be
      // missing from them — and nothing here can distinguish that from an
      // honest handover, because the stamp carries no version to compare.
      noteDiskStamp(opened.stamp, "open");
    }
    raw = Database.deserialize(opened.image);
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

  /**
   * What the snapshot on disk says right now, read as the header prefix so it
   * stays cheap enough to ask before every write.
   *
   * The three no-fence answers are deliberately distinct. `"absent"` (no file)
   * and `"undecidable"` (bytes that are not a fence this build knows) are both
   * decidable statements about a path that read fine, so asking again cannot
   * change them. `"unreadable"` is an I/O failure — EBUSY, EACCES, a torn
   * prefix — and the file may be perfectly healthy and correctly stamped: to
   * report a foreign writer from it would force a full serialize+encrypt+rename
   * of a multi-megabyte snapshot over a momentary busy handle.
   */
  function readDiskFence(): { outcome: "fence"; stamp: string | undefined } | { outcome: "absent" | "undecidable" | "unreadable" } {
    let fd: number | undefined;
    try {
      fd = fs.openSync(snapshotPath, "r");
      const head = Buffer.alloc(SNAPSHOT_FENCE_PREFIX_BYTES);
      const read = fs.readSync(fd, head, 0, head.length, 0);
      const fence = readSnapshotFence(head.subarray(0, read));
      return fence === undefined ? { outcome: "undecidable" } : { outcome: "fence", stamp: fence.stamp };
    } catch (error) {
      // SAFETY: the errno `code` probe is how Node reports ENOENT from open;
      // the cast only exposes the field this branch reads
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      return code === "ENOENT" ? { outcome: "absent" } : { outcome: "unreadable" };
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    }
  }

  /**
   * Remember the stamp on disk and report a CHANGE to a foreign one.
   *
   * A stamp that is not this holder's means the bytes on disk were written by
   * another writer, so the last version this holder acknowledged is not the
   * one on disk. That is the case #280 fenced and #292 watches for on the
   * heartbeat, and it is reported rather than swallowed: a silent case that is
   * at least named becomes diagnosable.
   *
   * One change is one log line. The disk is read from three places (open, a
   * write, the heartbeat), and a single replacement is noticed by all of
   * them; the first one to notice names it and the rest stay quiet. A repair
   * (our own stamp back on disk) resets it, so the next theft is named again.
   */
  function noteDiskStamp(stamp: string | undefined, context: "open" | "write" | "heartbeat"): void {
    const changed = observedStamp === undefined || observedStamp.value !== stamp;
    observedStamp = { value: stamp };
    if (!changed) return;
    // our own bytes: nothing to report
    if (stamp === connectionStamp) return;
    options.logger?.warn("VAULT_SNAPSHOT_FENCE_FOREIGN", foreignStampMessage(context, stamp));
  }

  /**
   * Read the disk fence and name a replacement, without judging ownership.
   *
   * This has to run BEFORE a write, not after it. A dirty version short-circuits
   * `snapshotIsCurrent()` at the version comparison, so the write path's own
   * fence read (the post-write one) only ever saw the stamp it had just written:
   * a dirty write repaired a zombie's envelope and reported nothing, while a
   * clean checkpoint named it because its early-return check happened to read
   * first. Reading first makes the report independent of that ordering.
   */
  function recordDiskStamp(context: "write" | "heartbeat"): void {
    const fence = readDiskFenceWithRetry();
    if (fence.outcome === "fence") noteDiskStamp(fence.stamp, context);
  }

  /** The wording of a foreign-stamp report, per the site that noticed it. */
  function foreignStampMessage(context: "open" | "write" | "heartbeat", stamp: string | undefined): string {
    if (stamp === undefined) {
      return "the snapshot on disk is the legacy unfenced format: it carries no holder stamp, so its currency is unverifiable and this holder rewrites it";
    }
    if (context === "heartbeat") {
      return "the snapshot on disk was replaced by another writer's envelope while this holder was idle: the last acknowledged transactions are not durable, and the snapshot is rewritten on the next write";
    }
    if (context === "write") {
      return "another writer's envelope replaced the snapshot on disk: the version this holder acknowledged is not on disk, so it is not durable and this holder rewrites it";
    }
    return "the snapshot on disk is stamped by a former holder: its currency is unverifiable and this holder rewrites it";
  }

  /**
   * Read the disk fence, asking a second time when the read itself failed. A
   * transient EBUSY must not be reported as another writer, and a decidable
   * answer cannot change by asking again.
   */
  function readDiskFenceWithRetry(): {
    outcome: "fence";
    stamp: string | undefined;
  } | { outcome: "absent" | "undecidable" | "unreadable" } {
    for (let attempt = 1; attempt <= FENCE_READ_ATTEMPTS; attempt += 1) {
      const fence = readDiskFence();
      if (fence.outcome !== "unreadable") return fence;
    }
    return { outcome: "unreadable" };
  }

  /**
   * True when the bytes on disk carry this holder's stamp (always true when
   * unfenced). An unreadable prefix is asked twice before it is called foreign:
   * one retry absorbs a transient EBUSY, and no retry is spent on a decidable
   * answer, which cannot change by asking again.
   */
  function diskFenceIsMine(): boolean {
    if (connectionStamp === undefined) return true;
    const fence = readDiskFenceWithRetry();
    if (fence.outcome === "fence") {
      // the write path is a reader of the fence too, so it names a replacement
      // the heartbeat has not noticed yet
      noteDiskStamp(fence.stamp, "write");
      return fence.stamp === connectionStamp;
    }
    if (fence.outcome === "unreadable") {
      // Still unreadable: our own bytes cannot be shown to be ours, so the
      // version is not durable and a write is owed. That is the safe
      // direction — a redundant rewrite costs time, a version reported durable
      // over an unreadable file costs the committed transaction it claimed to
      // save.
      options.logger?.warn(
        "VAULT_SNAPSHOT_FENCE_UNREADABLE",
        "the snapshot fence could not be read twice; treating the version on disk as unverified and rewriting",
      );
      return false;
    }
    return false;
  }

  /**
   * True when the snapshot on disk already covers every mutation AND carries
   * this holder's fence. The fence half matters when nothing is dirty: a
   * zombie's rename may have replaced our bytes since the last verified write
   * (#280), and a write is then still owed.
   */
  function snapshotIsCurrent(): boolean {
    return mutationVersion === persistedVersion && fenceSatisfied && diskFenceIsMine();
  }

  /**
   * Re-read the fence on disk NOW (#292). The holder's heartbeat calls it, so
   * a snapshot a zombie replaced while this holder was idle is detected within
   * one heartbeat instead of at the next persist, checkpoint or close.
   *
   * What it does with the answer:
   *   - our stamp: the bytes on disk are ours, and the version is durable
   *     again;
   *   - a foreign stamp (the legacy envelope carries none, so it counts as
   *     foreign too): those bytes are not ours, so the version is NOT durable.
   *     It is named, once, when the stamp changed — a foreign stamp that
   *     repeats on every tick is one event, not ten thousand;
   *   - anything else (no file, bytes that are not an envelope, a prefix that
   *     could not be read): the disk is not verifiably ours, so the version is
   *     not durable, and the next write repairs it.
   *
   * It never writes and never throws: a diagnostic that broke the holder
   * would be worse than the silence it replaces.
   */
  function recheckFence(): void {
    // unfenced: the legacy envelope carries no stamp, so there is nothing to
    // compare and nothing to report
    if (connectionStamp === undefined) return;
    const fence = readDiskFenceWithRetry();
    if (fence.outcome === "fence") {
      noteDiskStamp(fence.stamp, "heartbeat");
      fenceSatisfied = fence.stamp === connectionStamp;
      return;
    }
    if (fence.outcome === "unreadable") {
      options.logger?.warn(
        "VAULT_SNAPSHOT_FENCE_UNREADABLE",
        "the snapshot fence could not be read twice; the version on disk counts as unverified",
      );
    }
    fenceSatisfied = false;
  }

  async function persistNow(): Promise<void> {
    // name a replacement before this write repairs it; the version comparison
    // below never looks at the disk when the version is dirty
    recordDiskStamp("write");
    if (snapshotIsCurrent()) return;
    // never serialize an open unit: a later ROLLBACK would be undone by the
    // stored image, so the flush waits for COMMIT (which calls back here)
    if (connection.inTransaction) return;
    const version = mutationVersion;
    const envelope = sealSnapshot(connectionKey, vaultId, raw.serialize(), connectionStamp);
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
      // ADR-0012: a persist queued before the lock was stolen must refuse
      // rather than overwrite the new owner's snapshot, so the guard is asked
      // at the instant of the write and its throw is never retried
      options.writeGuard?.();
      try {
        // the single-writer lock (lib/vault/lock.ts) keeps a second process
        // from holding a competing in-memory image, so this rename is the only
        // writer for the folder
        await writeFileAtomic(snapshotPath, envelope);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < WRITE_ATTEMPTS) await delay(WRITE_RETRY_DELAY_MS);
        continue;
      }
      // the bytes landed; report the version durable only while the folder is
      // still ours, so a theft during the write is never mistaken for saved data
      options.writeGuard?.();
      // #280: a rename from the previous holder can land on top of ours in the
      // same window. Re-read the fence; a foreign stamp means the version just
      // written is NOT on disk, so it is not durable and the write is redone.
      if (!diskFenceIsMine()) {
        lastError = new Error("the snapshot was replaced by another writer's envelope");
        continue;
      }
      // only now is the version durable; a mutation during the write set
      // mutationVersion beyond `version` and schedules the next flush
      persistedVersion = version;
      fenceSatisfied = true;
      return;
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
      if (snapshotIsCurrent()) return;
      const run = persistQueue.then(() => persistNow());
      persistQueue = run.catch(() => undefined);
      await run;
    },
    recheckFence,
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
      if (snapshotIsCurrent() && fs.existsSync(snapshotPath)) return;
      // same ordering rule as persistNow: a checkpoint whose version is dirty
      // would otherwise overwrite the zombie's envelope before reading it
      recordDiskStamp("write");
      // the same write guard as persistNow: a shutdown or backup checkpoint
      // must not overwrite a snapshot the folder's new owner already wrote
      options.writeGuard?.();
      writeFileAtomicSync(snapshotPath, sealSnapshot(connectionKey, vaultId, raw.serialize(), connectionStamp));
      // #280: the synchronous path can lose the same rename race; a foreign
      // stamp means the just-written version is not on disk, so it is refused
      if (!diskFenceIsMine()) {
        throw new SnapshotPersistenceError(new Error("the snapshot was replaced by another writer's envelope"));
      }
      persistedVersion = mutationVersion;
      fenceSatisfied = true;
    },
    async close() {
      // wait for an in-flight async snapshot write, then checkpoint the current
      // version synchronously: a clean shutdown can never lose to the queue
      await persistQueue.catch(() => undefined);
      try {
        connection.checkpoint();
      } finally {
        // The key zeroing and the raw close run even when that final checkpoint
        // refuses (#280). A key that outlives its connection, and a leaked
        // SQLite handle, are the wrong taste in a vault module on a path whose
        // caller may well keep running to report the refusal.
        connectionKey.fill(0);
        try {
          raw.close();
        } catch {
          /* the handle is already gone; the checkpoint error is the one that matters */
        }
      }
    },
    validateSnapshotFile(filePath: string): boolean {
      let candidate: Database | null = null;
      try {
        const bytes = fs.readFileSync(filePath);
        const bundle = readVaultBackupBundle(bytes);
        if (bundle !== undefined) {
          // a self-contained backup must belong to this vault's header AND
          // carry the LIVE credential wraps: after a passphrase change or a
          // recovery-key change the old bundle is refused here, so the daily
          // pass rebuilds it instead of trusting an unopenable copy
          const bundleHeader = parseVaultHeader(bundle.headerText);
          if (bundleHeader.vaultId !== vaultId) return false;
          if (headerPath === undefined) return false;
          const liveHeader = parseVaultHeader(fs.readFileSync(headerPath, "utf8"));
          if (!wrapsMatch(bundleHeader.wraps, liveHeader.wraps)) return false;
          candidate = Database.deserialize(openSnapshot(connectionKey, vaultId, bundle.snapshot).image);
        } else {
          candidate = Database.deserialize(openSnapshot(connectionKey, vaultId, bytes).image);
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
