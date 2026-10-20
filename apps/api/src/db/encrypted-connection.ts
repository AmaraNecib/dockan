import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/bun-sqlite";

import type { DrizzleDb } from "./connection";
import * as schema from "./schema";
import {
  SnapshotPersistenceError,
  readVerifiedSnapshot,
  sealSnapshot,
  sleepSync,
  writeSnapshot,
  writeSnapshotSync,
} from "./snapshot-durability";
import { snapshotFailurePolicy } from "./snapshot-failure-policy";
import { cleanupStalePartials, writeFileAtomic } from "../lib/atomic-file";
import { createVaultBackupBundle, readVaultBackupBundle } from "../lib/vault/backup";
import { open } from "../lib/vault/crypto";
import {
  MAX_SNAPSHOT_STAMP_BYTES,
  VAULT_SNAPSHOT_LEGACY_VERSION,
  VAULT_SNAPSHOT_MAGIC,
  VAULT_SNAPSHOT_VERSION,
  parseVaultHeader,
  readSnapshotFence,
  snapshotAadFor,
  type VaultWrap,
} from "../lib/vault/format";
import { fromEnvelope, fromPath, type FenceVerdict } from "../lib/vault/fence";

/**
 * The write half of the vault lives in `snapshot-durability`, and the reason a
 * failure carries lives with it. Re-exported here so the callers that already
 * name this module (main, the store, the tests) keep one import.
 */
export { SnapshotPersistenceError } from "./snapshot-durability";
export type { SnapshotFailureReason } from "./snapshot-durability";
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
   * Write the committed image if it is dirty. Every failure THROWS with its
   * reason, including a connection that closed before the write: a caller that
   * has to decide whether a committed unit may be reported saved reads one
   * thing, and a resolved promise always means the image is on disk. An
   * unreadable read-back is not a failure — the bytes landed — so it resolves
   * and the version is simply not recorded durable.
   */
  persistIfDirty(): Promise<void>;
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
   * so a beat every 10 s does not grow the log). It writes nothing: detection
   * is not a repair, and a write on a heartbeat tick could land inside an open
   * unit. It reads the fence prefix only (~90 bytes), so a beat costs one open,
   * one short read and one close.
   */
  recheckFence(): FenceVerdict;
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
    let openedVerdict: FenceVerdict;
    try {
      const envelope = fs.readFileSync(snapshotPath);
      opened = openSnapshot(connectionKey, vaultId, envelope);
      openedVerdict = fromEnvelope(envelope, connectionStamp);
    } catch (error) {
      connectionKey.fill(0);
      throw new VaultCorruptionError(error instanceof Error ? error.message : String(error));
    }
    // A legacy envelope, or one stamped by a former holder, is not this
    // holder's: the first write repairs the fence (#280). The verdict is asked
    // for whether or not this connection carries a stamp, because an UNFENCED
    // connection over a fenced envelope is a downgrade and has to be said out
    // loud — and it is the fence reader (#307), not a comparison here, that
    // decides which case this is.
    if (connectionStamp !== undefined) {
      lastSeenFence = openedVerdict;
      // Surfaced, never silent. These bytes were writable by a holder that is
      // no longer the holder, so the newest acknowledged transactions may be
      // missing from them — and nothing here can distinguish that from an
      // honest handover, because the stamp carries no version to compare. It
      // is also the ROUTINE case: every restart leaves the previous session's
      // bytes on disk, so it is information, not an incident.
      reportFence(openedVerdict, "info");
    } else if (openedVerdict.outcome === "unfenced-holder") {
      // An unfenced caller keeps the pre-#280 write behaviour by design, so the
      // downgrade is allowed — but it is not silent. Left unsaid, the next
      // fenced holder reads a v1 envelope and blames a former holder for a file
      // that this build wrote, and the tamper-evidence the fence bought is gone
      // with no trace of who removed it.
      reportFence(openedVerdict, "warn");
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
      case "unfenced-holder":
        // Only collectable from the open path of an unfenced connection: the
        // write path never asks the reader without a stamp. Warn whatever the
        // caller's severity, because the downgrade this names is about to
        // happen — this holder rewrites the fenced envelope as legacy.
        emit(
          "warn",
          "VAULT_SNAPSHOT_FENCE_DOWNGRADE",
          "this connection has no holder stamp and will overwrite a fenced snapshot with the legacy unfenced format",
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
   *
   * This is a generator because the async persist path and the synchronous
   * checkpoint path must share the attempt bound and the report bookkeeping.
   * Two copies drifted apart once already (the sync copy slept with no pause)
   * and keeping two bookkeeping paths in step is what #291 cost. The generator
   * yields the pause it wants; the driver decides how to take it — `sleepSync`
   * on the synchronous path, `await` on the async one.
   */
  function* fenceSteps(): Generator<number, FenceVerdict, void> {
    if (connectionStamp === undefined) {
      // An unfenced holder writes the legacy envelope unconditionally (the
      // pre-#280 rule): it has no stamp, so the disk cannot answer for it and
      // there is nothing for the reader to compare. Asking anyway would turn a
      // clean check into a rewrite of bytes this holder is about to overwrite,
      // and the one state worth hearing about — an unfenced holder over a
      // fenced snapshot — was already warned as a downgrade at open.
      return { outcome: "mine" };
    }
    for (let attempt = 1; attempt <= FENCE_READ_ATTEMPTS; attempt += 1) {
      const verdict = fromPath(snapshotPath, connectionStamp);
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

  async function persistNow(): Promise<void> {
    if (await snapshotIsCurrentAsync()) return;
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
        // The words come from the policy, not from here: the store logs the same
        // event for the same fact when this throws "dropped", and a second
        // hand-written sentence would let one fact carry two texts — with the
        // policy's edit never reaching this row. The connection adds nothing to
        // the meaning, so it adds nothing to the sentence.
        snapshotFailurePolicy("dropped").sentence,
      );
      // And it THROWS, rather than resolving with a value the caller has to
      // read. `dropped` is a failure by every measure that matters to a caller:
      // a committed unit is not on disk and never will be. Signalling it as a
      // resolved promise put the same fact in two unions — a return value and a
      // throw — and left the store rebuilding the error this module owns
      // (#309). The reason still travels, so the policy still files it under
      // SNAPSHOT_PERSIST_DROPPED.
      throw new SnapshotPersistenceError(new Error(snapshotFailurePolicy("dropped").sentence), "dropped");
    }
    // never serialize an open unit: a later ROLLBACK would be undone by the
    // stored image, so the flush waits for COMMIT (which calls back here)
    if (connection.inTransaction) return;
    // The four-step sequence and its three-verdict table are
    // `snapshot-durability`'s, not this module's: seal, place with the guard
    // before the rename, read the fence back, retry a refusal. What is decided
    // here is only what the outcome means for the version counter — and the
    // mutating version is read BEFORE the write, so a mutation that lands
    // during it advances past `version` and schedules the next flush.
    const version = mutationVersion;
    const durability = await writeSnapshot({
      snapshotPath,
      image: raw.serialize(),
      masterKey: connectionKey,
      vaultId,
      stamp: connectionStamp,
      writeGuard: options.writeGuard,
      onUnproven: (verdict) => reportFence(verdict, "warn"),
      readFence: readFenceAsync,
    });
    // only a proven write records the version durable; an unproven one is
    // reported and re-sealed by the next write, and neither is a refusal
    if (durability === "durable") persistedVersion = version;
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
    async persistIfDirty() {
      // The job is chained onto the queue HERE, synchronously: a close() that
      // reads persistQueue after this call is then waiting for THIS persist.
      // Chaining it after an await left a window in which close() saw a drained
      // queue, released the handle, and the persist then woke up and serialized
      // it (#291). The currency check keeps its place and its meaning — it runs
      // on the queue now, one await inside the slot, instead of at request time.
      const run = persistQueue.then(async (): Promise<void> => {
        if (await snapshotIsCurrentAsync()) return;
        await persistNow();
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
      // The same sequence the async persist runs, on the synchronous driver:
      // guard before the write and again before the rename, the fence read back,
      // and the refusal thrown with its reason. The driver takes ONE attempt —
      // a checkpoint runs on the shutdown and backup paths, where the caller has
      // nothing to retry with.
      const durability = writeSnapshotSync({
        snapshotPath,
        image: raw.serialize(),
        masterKey: connectionKey,
        vaultId,
        stamp: connectionStamp,
        writeGuard: options.writeGuard,
        onUnproven: (verdict) => reportFence(verdict, "warn"),
        readFence,
      });
      // the bytes landed and the fence could not be read back: on disk, so not
      // fatal — the version is simply not recorded durable, and the next holder
      // re-seals it
      if (durability === "durable") persistedVersion = mutationVersion;
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
      // tell, and it sees the buffer, not the file. `readVerifiedSnapshot` is
      // that spelling of the same table: not this holder's bytes, refused with
      // its reason rather than bundled.
      const snapshot = readVerifiedSnapshot(
        snapshotPath,
        connectionStamp,
        "refusing to bundle a snapshot that is not this holder's",
      );
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
