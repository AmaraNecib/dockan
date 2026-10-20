import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/bun-sqlite";

import type { DrizzleDb, PersistOutcome } from "./connection";
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
  /**
   * Write the committed image if it is dirty, and say what happened. `dropped`
   * is not "nothing to do": the connection had already closed, so the version
   * this flush would have written is not on disk and cannot be. A caller that
   * treats every resolved flush as saved reports a lost transaction as saved.
   */
  persistIfDirty(): Promise<PersistOutcome>;
  flush(): Promise<void>;
  checkpoint(): void;
  close(): Promise<void>;
  /** verify one encrypted snapshot OR self-contained backup bundle */
  validateSnapshotFile(filePath: string): boolean;
  /** write a self-contained backup (header wraps + snapshot) to destPath */
  writeBackupTo(destPath: string): Promise<void>;
  /**
   * Re-read the snapshot fence WITHOUT writing (#292): the probe the holder's
   * heartbeat rides. It is the same reader and the same stamps comparison the
   * write points use, so the module still has ONE fence comparison rather than
   * a fourth; what it adds is a look BETWEEN the write points, which is the
   * window a zombie's rename used to sit in unnoticed until the next persist,
   * checkpoint or close.
   *
   * A verdict that is not `mine` is reported through the log (once per CHANGE,
   * so a beat every 10 s does not grow the log) and is what makes
   * `snapshotIsDurable()` false. It writes nothing: detection is not a repair,
   * and a write on a heartbeat tick could land inside an open unit. It reads the
   * fence prefix only (~90 bytes), so a beat costs one open, one short read and
   * one close.
   */
  recheckFence(): FenceVerdict;
  /**
   * True while this connection still believes the snapshot it wrote last is the
   * bytes on disk: something has been written, nothing has been marked dirty
   * since, and the most recent fence read was this holder's. A probe that finds
   * a foreign stamp turns it false within one heartbeat (#292) instead of at
   * the next write, so nothing between two ticks can still call that version
   * saved. After `close()` it answers false for the same reason: the writer is
   * gone, so nothing here can attest the bytes any more.
   */
  snapshotIsDurable(): boolean;
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
  | "unreadable"
  /**
   * the connection closed before the write: nothing was written, and nothing
   * can be — the handle is released and the key is zeroed. Distinct from
   * "write-failed" because the disk is not implicated: the unit is lost
   * because there is no writer left, which is the one failure a retry cannot
   * fix.
   */
  | "dropped";

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
      // ABORT, never an empty shop: the snapshot is the only copy of the
      // data, so a missing file is a lost vault and not a fresh one. The
      // failure is named, so the unlock screen can say the data is gone
      // instead of opening a shop with no rows in it.
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
   * True once `close()` has checkpointed and released the handle. The async
   * persist reads it after its opening await: the job is parked there, and a
   * close (a shutdown, a lock loss, a test teardown) can land in that window
   * and release the handle underneath it (#291).
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
      // ENOENT is not the only "no snapshot file at this path". A path that is a
      // directory, or whose parent is a file, answers EISDIR or ENOTDIR on open
      // or read. Those are decidable statements about the path, not a transient
      // I/O failure: calling them "unreadable" sent the post-write branch down
      // its benign "written, fence unproven" exit over a snapshot that was
      // gone. Treated as absent, a write is owed, and the write itself then
      // fails loudly because nothing can be renamed over a directory.
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return { outcome: "absent" };
      return { outcome: "unreadable" };
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
   * Record a verdict for the change detector, then hand it back. One report per
   * CHANGE, not one per read: a fence that stays foreign says nothing new on
   * the second look.
   */
  function noteFence(verdict: FenceVerdict): FenceVerdict {
    if (!sameVerdict(verdict, lastSeenFence)) {
      reportFence(verdict, "warn");
      lastSeenFence = verdict;
    }
    return verdict;
  }

  /**
   * The fence on disk, read with the retry a transient EBUSY needs — written
   * once and driven twice.
   *
   * An unreadable prefix is asked twice, with the same spacing the write path
   * uses between its attempts, so one retry can absorb a transient refusal: no
   * retry is spent on a decidable answer, which cannot change by asking again.
   * An unfenced connection has no stamp to compare, so its fence is trivially
   * its own — exactly the pre-#280 behaviour.
   *
   * This is a generator because the async persist path and the synchronous
   * checkpoint path must share the attempt bound and the report bookkeeping.
   * Two copies drifted apart once already (the sync copy slept with no pause)
   * and keeping two bookkeeping paths in step is what #291 cost. The generator
   * yields the pause it wants; the driver decides how to take it — `sleepSync`
   * on the synchronous path, `await` on the async one.
   */
  function* fenceSteps(): Generator<number, FenceVerdict, void> {
    if (connectionStamp === undefined) return { outcome: "mine" };
    for (let attempt = 1; attempt <= FENCE_READ_ATTEMPTS; attempt += 1) {
      const verdict = readDiskFence();
      if (verdict.outcome !== "unreadable") return noteFence(verdict);
      // the file may be busy for a moment; ask again after a pause, exactly
      // as the write path does before it gives up on a rename
      if (attempt < FENCE_READ_ATTEMPTS) yield FENCE_READ_RETRY_DELAY_MS;
    }
    // Still unreadable: our own bytes cannot be shown to be ours, so the
    // version is not durable and a write is owed. That is the safe direction —
    // a redundant rewrite costs time, a version reported durable over an
    // unreadable file costs the committed transaction it claimed to save.
    return noteFence({ outcome: "unreadable" });
  }

  function readFence(): FenceVerdict {
    const steps = fenceSteps();
    let step = steps.next();
    while (!step.done) {
      sleepSync(step.value);
      step = steps.next();
    }
    return step.value;
  }

  async function readFenceAsync(): Promise<FenceVerdict> {
    const steps = fenceSteps();
    let step = steps.next();
    while (!step.done) {
      await delay(step.value);
      step = steps.next();
    }
    return step.value;
  }

  /**
   * True when the snapshot on disk already covers every mutation AND carries
   * this holder's fence. The fence half matters when nothing is dirty: a
   * zombie's rename may have replaced our bytes since the last verified write
   * (#280), and a write is then still owed.
   */
  async function snapshotIsCurrentAsync(): Promise<boolean> {
    return mutationVersion === persistedVersion && (await readFenceAsync()).outcome === "mine";
  }

  function snapshotIsCurrent(): boolean {
    return mutationVersion === persistedVersion && readFence().outcome === "mine";
  }

  async function persistNow(): Promise<PersistOutcome> {
    if (await snapshotIsCurrentAsync()) return "on-disk";
    // The await above parks this job, and the store is not frozen while it is
    // parked: `close()` can release the database handle and a unit can BEGIN.
    // So the guard is read HERE, on the near side of the serializer, and not
    // before the await: a stale answer reached `raw.serialize()` on a handle
    // that close() had already closed, which throws
    // "Can't do this on a closed database" (#291).
    //
    // It is also the ONLY place the flag can be read on this path. `close()`
    // awaits this queue's tail before it checkpoints, and the flip and the
    // handle release that follow it contain no await, so no attempt inside the
    // loop below can observe `closed` become true. Guards there were
    // unreachable by construction and unkillable by any test; the invariant
    // they stood for is this one, and it is pinned by the store's #291 tests.
    if (closed) {
      // Nothing was written and nothing can be: close() released the handle and
      // zeroed the key. A committed unit that lands here is NOT in the
      // snapshot, so a caller that only sees a resolved promise would report a
      // lost transaction as saved (#291 review). Named once per drop, at error:
      // the loss is real, it is just not this process's to retry.
      options.logger?.error?.(
        "SNAPSHOT_PERSIST_DROPPED",
        "the connection closed before this committed unit reached the snapshot; the unit was not written",
      );
      return "dropped";
    }
    // never serialize an open unit: a later ROLLBACK would be undone by the
    // stored image, so the flush waits for COMMIT (which calls back here)
    if (connection.inTransaction) return "on-disk";
    const version = mutationVersion;
    const envelope = sealSnapshot(connectionKey, vaultId, raw.serialize(), connectionStamp);
    // The guard's refusal is never a write failure and is never retried, on the
    // pre-write check and on the pre-rename one alike. Recording it here is how
    // the catch below tells the two apart without this module knowing what the
    // guard's error type is.
    let guardRefusal: Error | undefined;
    const runGuard = (): void => {
      try {
        options.writeGuard?.();
      } catch (error) {
        guardRefusal = error instanceof Error ? error : new Error(String(error));
        throw guardRefusal;
      }
    };
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
      // ADR-0012: a persist queued before the lock was stolen must refuse
      // rather than overwrite the new owner's snapshot, so the guard is asked
      // at the instant of the write and its throw is never retried
      runGuard();
      try {
        // the single-writer lock (lib/vault/lock.ts) keeps a second process
        // from holding a competing in-memory image, so this rename is the only
        // writer for the folder. The guard is asked AGAIN inside the write,
        // immediately before the rename: asking only before the temp write
        // leaves the serialize + encrypt + write + fsync as the window a theft
        // can land in, and our rename then overwrites the new owner's snapshot
        // without the post-write fence read ever seeing it.
        await writeFileAtomic(snapshotPath, envelope, { beforeRename: runGuard });
      } catch (error) {
        if (guardRefusal !== undefined) throw guardRefusal;
        lastError = new SnapshotPersistenceError(error instanceof Error ? error : new Error(String(error)), "write-failed");
        if (attempt < WRITE_ATTEMPTS) await delay(WRITE_RETRY_DELAY_MS);
        continue;
      }
      // the bytes landed; report the version durable only while the folder is
      // still ours, so a theft during the write is never mistaken for saved data
      runGuard();
      // #280: a rename from the previous holder can land on top of ours in the
      // same window. Re-read the fence; a stamp that is not ours means the
      // version just written is NOT on disk, so it is not durable and the
      // write is redone.
      const verdict = await readFenceAsync();
      if (verdict.outcome === "mine") {
        // only now is the version durable; a mutation during the write set
        // mutationVersion beyond `version` and schedules the next flush
        persistedVersion = version;
        return "on-disk";
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
        // "unproven", not "on-disk": the write landed but nothing proved it,
        // and saying otherwise in the outcome would be the same lie this
        // branch's comment exists to avoid.
        return "unproven";
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
    recheckFence() {
      // A probe can arrive after close(): the heartbeat outlives the connection
      // by however long the lock stays held, and once the key is zeroed and the
      // handle released there is nothing left to read. The last verdict is the
      // honest answer; opening the file again would be a claim about a snapshot
      // this process no longer owns.
      if (closed) return lastSeenFence;
      return readFence();
    },
    snapshotIsDurable() {
      // `persistedVersion > 0` is "a write has been recorded": before the first
      // one both counters sit at 0 and there is nothing on disk to be durable.
      return (
        !closed && persistedVersion > 0 && persistedVersion === mutationVersion && lastSeenFence.outcome === "mine"
      );
    },
    async persistIfDirty() {
      // The job is chained onto the queue HERE, synchronously: a close() that
      // reads persistQueue after this call is then waiting for THIS persist.
      // Chaining it after an await left a window in which close() saw a drained
      // queue, released the handle, and the persist then woke up and serialized
      // it (#291). The currency check keeps its place and its meaning — it runs
      // on the queue now, one await inside the slot, instead of at request time.
      const run = persistQueue.then(async (): Promise<PersistOutcome> => {
        if (await snapshotIsCurrentAsync()) return "on-disk";
        return persistNow();
      });
      // the queue only needs to know WHEN the job settled, not what it decided
      persistQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    async flush() {
      // A flush after close() has nothing to write: the handle is released
      // and the key is zeroed, so the write would be refused anyway. Refused
      // QUIETLY, like checkpoint(): a flush asked for while the process is
      // going down is an ordinary event, and bumping the version here would
      // only manufacture a dirty version for a connection that can never write
      // it — and name a loss that never happened.
      if (closed) return;
      // force a write even when nothing changed: the first snapshot after setup
      // and explicit checkpoints must never be skipped by version bookkeeping
      mutationVersion += 1;
      await connection.persistIfDirty();
    },
    checkpoint() {
      // A checkpoint after close() has nothing left to serialize: the key is
      // zeroed and the database is shut, so `raw.serialize()` throws "Can't do
      // this on a closed database" — an opaque failure on the shutdown path
      // where the caller asked for a flush it cannot get. A second close(), or
      // a backup requested while the process is going down, is an ordinary
      // event: refuse it the same way the async persist refuses, silently.
      if (closed) return;
      // Shutdown/backup seam. An open transaction means the last COMMITTED
      // image is already on disk; serializing now would capture uncommitted
      // pages that a ROLLBACK could undo, so skip and leave the dirty version
      // for the post-commit flush.
      if (connection.inTransaction) return;
      if (snapshotIsCurrent() && fs.existsSync(snapshotPath)) return;
      // the same write guard as persistNow: a shutdown or backup checkpoint
      // must not overwrite a snapshot the folder's new owner already wrote
      options.writeGuard?.();
      // and again immediately before the rename, for the same reason as the
      // async path: the guard that only ran before the temp write leaves the
      // serialize + write + fsync as the window a takeover can land in
      writeFileAtomicSync(snapshotPath, sealSnapshot(connectionKey, vaultId, raw.serialize(), connectionStamp), {
        beforeRename: options.writeGuard,
      });
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
        // Closing is a one-way door: the key is zeroed, the handle is
        // released, and this connection never writes again. Nothing reopens
        // it — a persist that arrives after this point is REFUSED as dropped
        // (and named in the log), never retried, because there is no handle
        // left to serialize and no key left to seal with.
        //
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
