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
  parseVaultHeader,
  readSnapshotFence,
  snapshotAad,
  snapshotAadFor,
  type VaultWrap,
} from "../lib/vault/format";
import { assertSchemaVersionSupported, readSchemaVersion } from "../lib/schema-version";
import type { StoreLogger } from "../store/port";

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
   * The holder's single-writer lock token, stamped into every snapshot this
   * connection writes (#280). A snapshot whose stamp is not this value was
   * written by another holder, so the bytes are not this connection's and its
   * version is not durable. Absent = unfenced: the legacy envelope is written
   * and read, exactly the pre-#280 behaviour.
   *
   * Read ONCE, when the connection opens: the token identifies the session,
   * and a token that rotated under a live connection would make every
   * envelope unreadable to its own writer. The lock token is stable for the
   * life of the lock (see `lock.ts`), so a session's stamp is the same in
   * every snapshot it writes.
   */
  writeStamp?: () => string;
  /**
   * Where the connection reports a fence it could not verify (#280): a snapshot
   * stamped by a former holder, the unstamped legacy envelope, or a fence that
   * would not read. These are warnings, never refusals — an unverifiable
   * snapshot is rewritten rather than rejected — so the log is the only signal
   * that the bytes being served may be older than the last acknowledged
   * transaction.
   */
  logger?: StoreLogger;
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

/**
 * How a snapshot write failed, in terms the caller can act on. The reason
 * travels with the error so the process is told what happened instead of
 * guessing: "the disk could not be written" and "another writer replaced the
 * file" call for different responses, and a caller that only sees "write
 * failed" blames the disk for a stolen file.
 */
export type SnapshotFailureReason =
  /** the atomic write itself failed (a full disk, a refused rename) */
  | "write-failed"
  /** another holder's envelope landed on the one this holder wrote */
  | "foreign"
  /** the legacy unfenced envelope landed on the one this holder wrote */
  | "unstamped"
  /** the bytes on disk are not an envelope this build knows */
  | "undecidable"
  /** the snapshot file is gone */
  | "absent"
  /** the fence could not be read */
  | "unreadable";

/** A committed unit could not be written to its durable snapshot. */
export class SnapshotPersistenceError extends Error {
  constructor(
    cause: Error,
    readonly reason: SnapshotFailureReason = "write-failed",
  ) {
    super(`snapshot persistence failed: ${cause.message}`);
    this.name = "SnapshotPersistenceError";
  }
}

/**
 * What the fence on disk says. The outcomes are deliberately distinct,
 * because they decide three different things: whether a write is owed,
 * whether the version may be recorded durable, and what the owner is told.
 * Collapsing them is how a busy file ended up reported as "another writer
 * replaced your snapshot" and how a readable failure ended in a fatal exit.
 */
export type FenceVerdict =
  /** the bytes on disk carry this holder's stamp */
  | { outcome: "mine" }
  /** the bytes on disk carry another holder's stamp */
  | { outcome: "foreign"; stamp: string }
  /** the bytes on disk are the legacy envelope: no stamp at all */
  | { outcome: "unstamped" }
  /** the bytes on disk are not an envelope this build knows */
  | { outcome: "undecidable" }
  /** there is no file */
  | { outcome: "absent" }
  /** the file is there and could not be read */
  | { outcome: "unreadable" };

/** Why a write was refused, and the sentence that says so. */
type FenceFailure = { reason: SnapshotFailureReason; message: string };

/** The reason and the sentence a fence verdict turns into when it refuses a write. */
function fenceFailure(verdict: FenceVerdict): FenceFailure {
  switch (verdict.outcome) {
    case "foreign":
      return { reason: "foreign", message: "another writer's envelope replaced the snapshot this holder wrote" };
    case "unstamped":
      return { reason: "unstamped", message: "a legacy unfenced envelope replaced the snapshot this holder wrote" };
    case "undecidable":
      return { reason: "undecidable", message: "the bytes on disk are not a snapshot envelope this build knows" };
    case "absent":
      return { reason: "absent", message: "the snapshot file is gone" };
    case "unreadable":
      return { reason: "unreadable", message: "the snapshot fence could not be read" };
    case "mine":
      return { reason: "write-failed", message: "the snapshot was written but the fence is not this holder's" };
  }
}

const WRITE_ATTEMPTS = 3;
const WRITE_RETRY_DELAY_MS = 50;
/** Ask twice: one retry absorbs a transient EBUSY. A decidable fence cannot change by asking again. */
const FENCE_READ_ATTEMPTS = 2;
/**
 * The gap between two attempts at the same file. The write path already
 * waits 50 ms between its attempts, because a rename that fails on a busy
 * handle usually succeeds on the next try; the fence read asked twice with no
 * gap at all, so two refusals microseconds apart both landed and the write
 * was treated as "not durable" — three rewrites and a fatal error for a file
 * that was perfectly healthy. Same spacing, same reason.
 */
const FENCE_READ_RETRY_DELAY_MS = 50;

/**
 * A synchronous pause. The fence read runs on the async persist path AND on
 * the synchronous checkpoint path, so one implementation has to serve both,
 * and `Atomics.wait` is the only sleep a sync function can do. It is used
 * only between two attempts at opening a file that refused, so the event loop
 * is held for that one window and for nothing else.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Build the envelope. With a holder stamp it is the fenced format (#280):
 * `magic ‖ 2 ‖ stampLen ‖ stamp ‖ sealed`, and the stamp is bound into the AAD
 * so a reader can trust whose bytes it holds. Without one it is the legacy
 * format, exactly what every released build wrote.
 */
/**
 * A holder stamp that cannot be sealed is refused at OPEN, not at each write:
 * it is a property of the holder, not of one snapshot, and a connection that
 * can never write is a broken start, not a failed transaction.
 */
function assertStampUsable(stamp: string): void {
  const stampBytes = Buffer.from(stamp, "utf8");
  if (stampBytes.length === 0 || stampBytes.length > MAX_SNAPSHOT_STAMP_BYTES) {
    throw new Error(`the snapshot holder stamp must be 1..${MAX_SNAPSHOT_STAMP_BYTES} bytes`);
  }
  // The stamp travels as cleartext bytes and is read back as UTF-8, and it is
  // bound into the AAD. A stamp that does not survive that round trip (a lone
  // surrogate, say) would be sealed under one AEAD context and opened under
  // another: a vault nobody can open again, with no way to tell a corrupt file
  // from a good one. Refused here, where the cause is still visible.
  if (stampBytes.toString("utf8") !== stamp) {
    throw new Error("the snapshot holder stamp is not text that survives a UTF-8 round trip");
  }
}

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
  const sealed = seal(masterKey, image, snapshotAadFor(vaultId, stamp));
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
  const aad = snapshotAadFor(vaultId, fence.stamp);
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

/**
 * The verdict on one envelope's fence, with no connection state involved. An
 * unfenced connection has no stamp to compare, so its fence is trivially its
 * own — the same rule `readFence` applies, kept in one place.
 */
function fenceOfBytes(envelope: Uint8Array, expectedStamp: string | undefined): FenceVerdict {
  if (expectedStamp === undefined) return { outcome: "mine" };
  const fence = readSnapshotFence(envelope);
  if (fence === undefined) return { outcome: "undecidable" };
  if (fence.stamp === undefined) return { outcome: "unstamped" };
  return fence.stamp === expectedStamp ? { outcome: "mine" } : { outcome: "foreign", stamp: fence.stamp };
}

/** True when two verdicts describe the same state of the disk. */
function sameVerdict(left: FenceVerdict, right: FenceVerdict): boolean {
  if (left.outcome === "foreign" && right.outcome === "foreign") return left.stamp === right.stamp;
  return left.outcome === right.outcome;
}

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
  if (connectionStamp !== undefined) assertStampUsable(connectionStamp);
  let raw: Database;
  /**
   * What the disk looked like when this connection opened, and what it last
   * showed. The routine case is the snapshot an earlier session left behind:
   * it is reported once, as information, and a later fence that DIFFERS from
   * it is a change under a live connection, which is an incident.
   */
  let lastSeenFence: FenceVerdict = { outcome: "mine" };
  /** the fence the opened envelope carried; undefined when the disk was not read */
  let openedFence: FenceVerdict | undefined;
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
    // A legacy envelope, or one stamped by a former holder, is not this
    // holder's: the first write repairs the fence (#280). The verdict is
    // computed whether or not this connection carries a stamp, because an
    // UNFENCED connection over a fenced envelope is a downgrade and has to be
    // said out loud.
    openedFence =
      opened.stamp === undefined
        ? { outcome: "unstamped" }
        : opened.stamp === connectionStamp
          ? { outcome: "mine" }
          : { outcome: "foreign", stamp: opened.stamp };
    if (connectionStamp !== undefined) {
      lastSeenFence = openedFence;
      // Surfaced, never silent. These bytes were writable by a holder that is
      // no longer the holder, so the newest acknowledged transactions may be
      // missing from them — and nothing here can distinguish that from an
      // honest handover, because the stamp carries no version to compare. It
      // is also the ROUTINE case: every restart leaves the previous session's
      // bytes on disk, so it is information, not an incident.
      reportFence(openedFence, "info");
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
   * True once `close()` has checkpointed and released the handle. Every async
   * persist reads it AFTER its awaits: the job is parked there, and a close
   * (a shutdown, a lock loss, a test teardown) can land in that window and
   * release the handle underneath it (#291).
   */
  let closed = false;

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
  function readDiskFence(): FenceVerdict {
    let fd: number | undefined;
    try {
      fd = fs.openSync(snapshotPath, "r");
      const head = Buffer.alloc(SNAPSHOT_FENCE_PREFIX_BYTES);
      const read = fs.readSync(fd, head, 0, head.length, 0);
      const fence = readSnapshotFence(head.subarray(0, read));
      if (fence === undefined) return { outcome: "undecidable" };
      if (fence.stamp === undefined) return { outcome: "unstamped" };
      return fence.stamp === connectionStamp ? { outcome: "mine" } : { outcome: "foreign", stamp: fence.stamp };
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
   * Report a fence that is not this holder's. The severity follows the case:
   * the snapshot an earlier session left behind is what every restart
   * produces, so it is information; a fence that changed under a live
   * connection, a file that is gone, and a fence that would not read are
   * incidents.
   */
  function reportFence(verdict: FenceVerdict, severity: "info" | "warn"): void {
    const emit = (level: "info" | "warn", event: string, message: string): void => {
      if (level === "info") options.logger?.info?.(event, message);
      else options.logger?.warn(event, message);
    };
    switch (verdict.outcome) {
      case "mine":
        return;
      case "foreign":
        emit(
          severity,
          "VAULT_SNAPSHOT_FENCE_FOREIGN",
          "the snapshot on disk is stamped by another holder: its currency is unverifiable and this holder rewrites it",
        );
        return;
      case "unstamped":
        emit(
          severity,
          "VAULT_SNAPSHOT_FENCE_UNSTAMPED",
          "the snapshot on disk is the legacy unfenced format: it carries no holder stamp, so its currency is unverifiable and this holder rewrites it",
        );
        return;
      case "absent":
        emit(
          "warn",
          "VAULT_SNAPSHOT_FENCE_MISSING",
          "the snapshot file is gone: the bytes on disk are unverifiable and this holder rewrites them",
        );
        return;
      case "undecidable":
        emit(
          "warn",
          "VAULT_SNAPSHOT_FENCE_UNKNOWN",
          "the bytes on disk are not a snapshot envelope this build knows: they are unverifiable and this holder overwrites them",
        );
        return;
      case "unreadable":
        emit(
          "warn",
          "VAULT_SNAPSHOT_FENCE_UNREADABLE",
          "the snapshot fence could not be read: the bytes on disk are unverifiable",
        );
        return;
    }
  }

  /**
   * Warn when an UNFENCED connection is about to downgrade a fenced envelope.
   * An unfenced caller keeps the pre-#280 write behaviour by design, so the
   * downgrade is allowed — but it is not silent. Left unsaid, the next fenced
   * holder reads a v1 envelope and blames a former holder for a file that this
   * build wrote, and the tamper-evidence the fence bought is gone with no trace
   * of who removed it.
   */
  if (connectionStamp === undefined && openedFence?.outcome === "foreign") {
    options.logger?.warn(
      "VAULT_SNAPSHOT_FENCE_DOWNGRADE",
      "this connection has no holder stamp and will overwrite a fenced snapshot with the legacy unfenced format",
    );
  }

  /**
   * The fence on disk, read with the retry a transient EBUSY needs.
   *
   * An unreadable prefix is asked twice, with the same spacing the write path
   * uses between its attempts, so one retry can absorb a transient refusal: no
   * retry is spent on a decidable answer, which cannot change by asking again.
   * An unfenced connection has no stamp to compare, so its fence is trivially
   * its own — exactly the pre-#280 behaviour.
   */
  function readFence(): FenceVerdict {
    if (connectionStamp === undefined) return { outcome: "mine" };
    for (let attempt = 1; attempt <= FENCE_READ_ATTEMPTS; attempt += 1) {
      const verdict = readDiskFence();
      if (verdict.outcome !== "unreadable") {
        if (!sameVerdict(verdict, lastSeenFence)) {
          reportFence(verdict, "warn");
          lastSeenFence = verdict;
        }
        return verdict;
      }
      // the file may be busy for a moment; ask again after a pause, exactly
      // as the write path does before it gives up on a rename
      if (attempt < FENCE_READ_ATTEMPTS) sleepSync(FENCE_READ_RETRY_DELAY_MS);
    }
    // Still unreadable: our own bytes cannot be shown to be ours, so the
    // version is not durable and a write is owed. That is the safe direction —
    // a redundant rewrite costs time, a version reported durable over an
    // unreadable file costs the committed transaction it claimed to save.
    const unreadable: FenceVerdict = { outcome: "unreadable" };
    if (!sameVerdict(unreadable, lastSeenFence)) {
      reportFence(unreadable, "warn");
      lastSeenFence = unreadable;
    }
    return unreadable;
  }

  /**
   * True when the snapshot on disk already covers every mutation AND carries
   * this holder's fence. The fence half matters when nothing is dirty: a
   * zombie's rename may have replaced our bytes since the last verified write
   * (#280), and a write is then still owed.
   */
  async function readFenceAsync(): Promise<FenceVerdict> {
    if (connectionStamp === undefined) return { outcome: "mine" };
    for (let attempt = 1; attempt <= FENCE_READ_ATTEMPTS; attempt += 1) {
      const verdict = readDiskFence();
      if (verdict.outcome !== "unreadable") {
        if (!sameVerdict(verdict, lastSeenFence)) {
          reportFence(verdict, "warn");
          lastSeenFence = verdict;
        }
        return verdict;
      }
      if (attempt < FENCE_READ_ATTEMPTS) await delay(FENCE_READ_RETRY_DELAY_MS);
    }
    const unreadable: FenceVerdict = { outcome: "unreadable" };
    if (!sameVerdict(unreadable, lastSeenFence)) {
      reportFence(unreadable, "warn");
      lastSeenFence = unreadable;
    }
    return unreadable;
  }

  async function snapshotIsCurrentAsync(): Promise<boolean> {
    return mutationVersion === persistedVersion && (await readFenceAsync()).outcome === "mine";
  }

  function snapshotIsCurrent(): boolean {
    return mutationVersion === persistedVersion && readFence().outcome === "mine";
  }

  async function persistNow(): Promise<void> {
    if (await snapshotIsCurrentAsync()) return;
    // The await above parks this job, and the store is not frozen while it is
    // parked: `close()` can release the database handle and a unit can BEGIN.
    // So the guards are read HERE, on the near side of the serializer, and not
    // before the await: a stale answer reached `raw.serialize()` on a handle
    // that close() had already closed, which throws
    // "Can't do this on a closed database" (#291).
    if (closed) return;
    // never serialize an open unit: a later ROLLBACK would be undone by the
    // stored image, so the flush waits for COMMIT (which calls back here)
    if (connection.inTransaction) return;
    const version = mutationVersion;
    const envelope = sealSnapshot(connectionKey, vaultId, raw.serialize(), connectionStamp);
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
      // Each attempt is another chance for a close to land in the gap: a retry
      // that starts after the handle is released must write nothing at all, not
      // re-rename the envelope it sealed while the store was still open.
      if (closed) return;
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
        lastError = new SnapshotPersistenceError(error instanceof Error ? error : new Error(String(error)), "write-failed");
        if (attempt < WRITE_ATTEMPTS) await delay(WRITE_RETRY_DELAY_MS);
        continue;
      }
      // the bytes landed; report the version durable only while the folder is
      // still ours, so a theft during the write is never mistaken for saved data
      options.writeGuard?.();
      // #280: a rename from the previous holder can land on top of ours in the
      // same window. Re-read the fence; a stamp that is not ours means the
      // version just written is NOT on disk, so it is not durable and the
      // write is redone.
      const verdict = await readFenceAsync();
      // Closed while the fence was being read back: the bytes are on disk, so
      // nothing is lost, but a version recorded durable for a released handle
      // is bookkeeping nobody can act on and a retry would write over a folder
      // this connection no longer owns.
      if (closed) return;
      if (verdict.outcome === "mine") {
        // only now is the version durable; a mutation during the write set
        // mutationVersion beyond `version` and schedules the next flush
        persistedVersion = version;
        return;
      }
      if (verdict.outcome === "unreadable") {
        // The bytes landed; the fence could not be read back. An unreadable
        // prefix is NOT evidence that another writer took the file — a
        // replacement would have been read and named — so this is not the
        // "another writer" failure, and it must not kill the process over a
        // transaction that is on disk. The version is not recorded durable:
        // a later write re-seals it, which is the safe direction (a version
        // reported durable over an unreadable file costs the committed
        // transaction it claimed to save). Reported here, per persist, so the
        // words match the guarantee: written, but not proven durable.
        reportFence({ outcome: "unreadable" }, "warn");
        return;
      }
      const failure = fenceFailure(verdict);
      lastError = new SnapshotPersistenceError(new Error(failure.message), failure.reason);
      continue;
    }
    throw lastError ?? new SnapshotPersistenceError(new Error("unknown write failure"));
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
      // The job is chained onto the queue HERE, synchronously: a close() that
      // reads persistQueue after this call is then waiting for THIS persist.
      // Chaining it after an await left a window in which close() saw a drained
      // queue, released the handle, and the persist then woke up and serialized
      // it (#291). The currency check keeps its place and its meaning — it runs
      // on the queue now, one await inside the slot, instead of at request time.
      const run = persistQueue.then(async () => {
        if (await snapshotIsCurrentAsync()) return;
        await persistNow();
      });
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
      if (snapshotIsCurrent() && fs.existsSync(snapshotPath)) return;
      // the same write guard as persistNow: a shutdown or backup checkpoint
      // must not overwrite a snapshot the folder's new owner already wrote
      options.writeGuard?.();
      writeFileAtomicSync(snapshotPath, sealSnapshot(connectionKey, vaultId, raw.serialize(), connectionStamp));
      // #280: the synchronous path can lose the same rename race; a stamp that
      // is not ours means the just-written version is not on disk, so it is
      // refused
      const verdict = readFence();
      if (verdict.outcome === "mine") {
        persistedVersion = mutationVersion;
        return;
      }
      if (verdict.outcome === "unreadable") {
        // the bytes landed and the fence could not be read back. The write is
        // on disk, so this is not fatal: the version is simply not recorded
        // durable, and the next holder re-seals it. Reported per persist.
        reportFence({ outcome: "unreadable" }, "warn");
        return;
      }
      const failure = fenceFailure(verdict);
      throw new SnapshotPersistenceError(new Error(failure.message), failure.reason);
    },
    async close() {
      // wait for an in-flight async snapshot write, then checkpoint the current
      // version synchronously: a clean shutdown can never lose to the queue
      await persistQueue.catch(() => undefined);
      try {
        connection.checkpoint();
      } finally {
        // Marked closed before the handle is released, and with no await in
        // between: any persist this close() did not wait for now refuses to
        // serialize instead of throwing from under a dead handle (#291).
        closed = true;
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
      // The bytes that are actually bundled, not the ones checkpoint() just
      // wrote: it returns before this read, so a rename landing in between puts
      // a zombie's older image into today's backup. The bundle validator cannot
      // catch it — it derives the AEAD context from the envelope's own stamp,
      // so a foreign-stamped envelope decrypts cleanly and `quick_check` passes
      // on a coherent but stale image. The fence is the only observer that can
      // tell, and it sees the buffer, not the file.
      const snapshot = fs.readFileSync(snapshotPath);
      const verdict = fenceOfBytes(snapshot, connectionStamp);
      if (verdict.outcome !== "mine") {
        const failure = fenceFailure(verdict);
        throw new SnapshotPersistenceError(
          new Error(`refusing to bundle a snapshot that is not this holder's: ${failure.message}`),
          failure.reason,
        );
      }
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
