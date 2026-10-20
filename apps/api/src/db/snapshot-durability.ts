import fs from "node:fs";

import { writeFileAtomic, writeFileAtomicSync } from "../lib/atomic-file";
import { seal } from "../lib/vault/crypto";
import { fromEnvelope, type FenceVerdict } from "../lib/vault/fence";
import {
  VAULT_SNAPSHOT_LEGACY_VERSION,
  VAULT_SNAPSHOT_MAGIC,
  VAULT_SNAPSHOT_VERSION,
  snapshotAad,
  snapshotAadFor,
} from "../lib/vault/format";
import { snapshotFailurePolicy } from "./snapshot-failure-policy";

/**
 * Write this image and say whether it is durable. ONE module answers it.
 *
 * The sequence has four steps — seal, place the bytes atomically with the
 * single-writer guard asked immediately before the rename, read the fence back,
 * retry a refusal — and three verdicts that become two consequences: `mine` is
 * durable, `unreadable` is written but unproven (never durable, never fatal),
 * anything else is a refusal carrying its reason. That table lived in two
 * copies inside the connection, and the two drifted once already: the
 * synchronous `checkpoint()` had to be patched separately by #291's lens round,
 * and the backup path spelled the refusal a third way. `fenceSteps`' own comment
 * says why that matters for the read; the write side never got the same
 * treatment. This is it.
 *
 * What is NOT here: which version is durable. The counters belong to the
 * connection, so the module answers "the bytes on disk are the ones you asked
 * for" and the caller records the version. A module that also owned the counter
 * would need to know what a mutation is.
 *
 * The sync/async difference is the seam this hides, exactly as `fenceSteps`
 * hides it for the read: the sequence is written once as a generator, and the
 * two drivers below decide how to run one step — `writeFileAtomicSync` and
 * `Atomics.wait` on the synchronous path, `writeFileAtomic` and `setTimeout` on
 * the async one. Nothing above this module passes a flag to choose.
 */

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
  /** the snapshot is fenced and this connection has no stamp to check it against */
  | "unfenced-holder"
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
 * What a write did to the disk.
 *
 * - `durable` — the fence read back says the bytes on disk are the version this
 *   holder asked for, so the caller may record it durable.
 * - `unproven` — the bytes landed but the fence could not be read back, so the
 *   version is NOT recorded durable. Not a failure: an unreadable prefix is not
 *   evidence that another writer took the file, and a committed unit that is on
 *   disk must not be reported as a failed one. The next write re-seals it.
 *
 * A refusal is not a third member here: it throws `SnapshotPersistenceError`
 * with its reason, because a caller that keeps running after one has to act on
 * it, and a value a caller can ignore is how a lost transaction gets reported as
 * saved.
 */
export type DurabilityOutcome = "durable" | "unproven";

/**
 * One write: the image, the context it is sealed under, where it lands, and the
 * two things this module cannot decide for itself.
 *
 * `onUnproven` is the reporting seam. The words for a fence event belong to the
 * connection (it owns the logger and the change detector), and the reason's
 * meaning belongs to `snapshotFailurePolicy`; what belongs HERE is knowing that
 * an unreadable read-back is the row that gets reported rather than the row that
 * throws.
 */
export type SnapshotWrite = {
  /** where the fenced envelope lands */
  readonly snapshotPath: string;
  /** the committed image to seal */
  readonly image: Uint8Array;
  /** the AEAD context the bytes are sealed under */
  readonly masterKey: Uint8Array;
  readonly vaultId: string;
  /** the holder's stamp; `undefined` writes the legacy envelope */
  readonly stamp: string | undefined;
  /** asked before the write and again immediately before the rename */
  readonly writeGuard?: () => void;
  /** the fence could not be read back: report it, do not fail over it */
  readonly onUnproven: (verdict: FenceVerdict) => void;
};

/**
 * The fence of what is on disk, read with the CALLER's retry and reporting
 * bookkeeping (`fenceSteps` owns those, and it is settled). The reader is a
 * parameter because it is the one thing this module cannot await on behalf of
 * its caller: the async driver is handed the awaiting reader.
 */
export type SyncSnapshotWrite = SnapshotWrite & { readonly readFence: () => FenceVerdict };
export type AsyncSnapshotWrite = SnapshotWrite & { readonly readFence: () => Promise<FenceVerdict> };

const WRITE_ATTEMPTS = 3;
const WRITE_RETRY_DELAY_MS = 50;
/**
 * The synchronous path attempts ONCE. A checkpoint runs on the shutdown and
 * backup paths, where the caller has no way to retry and the process is usually
 * on its way out: a refusal there is reported, not re-attempted. The write
 * window is covered instead by the pre-rename guard.
 */
const WRITE_ATTEMPTS_SYNC = 1;

/** A synchronous pause, for the sync half of the sequences that share it. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A verdict that refuses a write: every fence outcome except "mine". */
type RefusingVerdict = Exclude<FenceVerdict, { outcome: "mine" }>;

/**
 * The reason a fence verdict gives a refused write. This is the one job left
 * here: a verdict that is not "mine" means a write is refused, and the reason
 * is which kind of not-mine it was. What the reason then MEANS — the event, the
 * severity, the words — is `snapshotFailurePolicy`'s answer, not this module's.
 *
 * Narrowing the parameter to the refusing verdicts is what removes the dead
 * `mine` branch: every caller tests `outcome === "mine"` first and returns, so a
 * verdict that reaches here cannot be one this holder wrote.
 */
function fenceFailureReason(verdict: RefusingVerdict): SnapshotFailureReason {
  switch (verdict.outcome) {
    case "foreign":
      return "foreign";
    case "unstamped":
      return "unstamped";
    case "unfenced-holder":
      return "unfenced-holder";
    case "undecidable":
      return "undecidable";
    case "absent":
      return "absent";
    case "unreadable":
      return "unreadable";
  }
}

/** A refused write, in the shape every caller acts on. */
function snapshotRefusal(verdict: RefusingVerdict): SnapshotPersistenceError {
  const reason = fenceFailureReason(verdict);
  return new SnapshotPersistenceError(new Error(snapshotFailurePolicy(reason).sentence), reason);
}

/**
 * Build the envelope. With a holder stamp it is the fenced format (#280):
 * `magic ‖ 2 ‖ stampLen ‖ stamp ‖ sealed`, and the stamp is bound into the AAD
 * so a reader can trust whose bytes it holds. Without one it is the legacy
 * format, exactly what every released build wrote.
 */
export function sealSnapshot(
  masterKey: Uint8Array,
  vaultId: string,
  image: Uint8Array,
  stamp: string | undefined,
): Buffer {
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

/** One step of the sequence; the driver runs it and hands the result back. */
type Pending =
  | { readonly do: "place"; readonly envelope: Uint8Array; readonly beforeRename: () => void }
  | { readonly do: "pause"; readonly ms: number }
  | { readonly do: "read" };

/** What a driver sends back after it ran one step. */
type Completed = {
  /** the error a `place` step threw, if it did */
  readonly failed?: Error;
  /** the verdict a `read` step produced */
  readonly fence?: FenceVerdict;
};

/**
 * The sequence and the table, written once. It yields the step it wants; the
 * driver decides whether running it means blocking or awaiting.
 *
 * The guard is asked three times per attempt — before the write, immediately
 * before the rename (inside the atomic write, so the serialize + encrypt +
 * write + fsync are not a window a takeover can land in) and once more after
 * the rename, before durability is recorded. Its refusal is never a write
 * failure and is never retried, on either of the first two.
 */
function* durabilitySteps(write: SnapshotWrite, attempts: number): Generator<Pending, DurabilityOutcome, Completed> {
  const envelope = sealSnapshot(write.masterKey, write.vaultId, write.image, write.stamp);
  // Recording the guard's refusal is how the catch below tells it apart from a
  // disk failure without this module knowing what the guard's error type is.
  let guardRefusal: Error | undefined;
  const runGuard = (): void => {
    try {
      write.writeGuard?.();
    } catch (error) {
      guardRefusal = error instanceof Error ? error : new Error(String(error));
      throw guardRefusal;
    }
  };
  let lastFailure: SnapshotPersistenceError | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    runGuard();
    const placed: Completed = yield { do: "place", envelope, beforeRename: runGuard };
    if (placed.failed !== undefined) {
      if (guardRefusal !== undefined) throw guardRefusal;
      lastFailure = new SnapshotPersistenceError(placed.failed, "write-failed");
      // a rename that fails on a busy handle usually succeeds on the next try
      if (attempt < attempts) yield { do: "pause", ms: WRITE_RETRY_DELAY_MS };
      continue;
    }
    // The bytes landed; report the version durable only while the folder is
    // still ours, so a theft during the write is never mistaken for saved data.
    runGuard();
    const read: Completed = yield { do: "read" };
    const verdict = read.fence;
    if (verdict === undefined) {
      // The driver's contract: a `read` step resumes with the fence it read.
      throw new Error("the snapshot durability sequence read no fence back");
    }
    if (verdict.outcome === "mine") return "durable";
    if (verdict.outcome === "unreadable") {
      // The bytes landed; the fence could not be read back. An unreadable prefix
      // is NOT evidence that another writer took the file — a replacement would
      // have been read and named — so this is not the "another writer" failure,
      // and it must not kill the process over a transaction that is on disk. The
      // version is not recorded durable: a later write re-seals it, which is the
      // safe direction (a version reported durable over an unreadable file costs
      // the committed transaction it claimed to save).
      write.onUnproven(verdict);
      return "unproven";
    }
    // #280: a rename from another holder can land on top of ours in the same
    // window, and the stamp that is not ours means the version just written is
    // NOT on disk. The async driver retries; the sync one has no attempt left
    // and the throw below is its answer.
    lastFailure = snapshotRefusal(verdict);
  }
  throw lastFailure ?? new SnapshotPersistenceError(new Error("unknown write failure"));
}

/** Run the sequence synchronously: the atomic writer blocks, so does the pause. */
function driveSync(steps: Generator<Pending, DurabilityOutcome, Completed>, write: SyncSnapshotWrite): DurabilityOutcome {
  let step = steps.next();
  while (!step.done) {
    const pending = step.value;
    if (pending.do === "place") {
      // Only the write is caught: a throw from the SEQUENCE (the guard's own
      // refusal, the fence read's refusal) must reach the caller unchanged, and
      // feeding it back as a failed write is how it would become a resolved
      // persist instead of a refused one.
      let placed: Completed = {};
      try {
        writeFileAtomicSync(write.snapshotPath, pending.envelope, { beforeRename: pending.beforeRename });
      } catch (error) {
        placed = { failed: error instanceof Error ? error : new Error(String(error)) };
      }
      step = steps.next(placed);
      continue;
    }
    if (pending.do === "read") {
      step = steps.next({ fence: write.readFence() });
      continue;
    }
    // Unreachable today: the sync path attempts once, so it never asks for a
    // pause. Kept symmetrical so a future attempt count cannot silently turn
    // into a no-op wait.
    sleepSync(pending.ms);
    step = steps.next({});
  }
  return step.value;
}

async function drive(
  steps: Generator<Pending, DurabilityOutcome, Completed>,
  write: AsyncSnapshotWrite,
): Promise<DurabilityOutcome> {
  let step = steps.next();
  while (!step.done) {
    const pending = step.value;
    if (pending.do === "place") {
      // see driveSync: the catch is for the write alone
      let placed: Completed = {};
      try {
        await writeFileAtomic(write.snapshotPath, pending.envelope, { beforeRename: pending.beforeRename });
      } catch (error) {
        placed = { failed: error instanceof Error ? error : new Error(String(error)) };
      }
      step = steps.next(placed);
      continue;
    }
    if (pending.do === "read") {
      step = steps.next({ fence: await write.readFence() });
      continue;
    }
    await delay(pending.ms);
    step = steps.next({});
  }
  return step.value;
}

/**
 * Seal `image`, place it, read the fence back, and say whether the version it
 * carries is durable. Throws `SnapshotPersistenceError` with its reason for
 * every refusal; `unproven` is reported through `onUnproven` and returned.
 */
export function writeSnapshotSync(write: SyncSnapshotWrite): DurabilityOutcome {
  return driveSync(durabilitySteps(write, WRITE_ATTEMPTS_SYNC), write);
}

/** The awaiting half of `writeSnapshotSync`: same sequence, same table. */
export function writeSnapshot(write: AsyncSnapshotWrite): Promise<DurabilityOutcome> {
  return drive(durabilitySteps(write, WRITE_ATTEMPTS), write);
}

/**
 * The bytes at `snapshotPath`, proven to be the version this holder wrote. This
 * is the bundle path's spelling of the same table: a self-contained backup whose
 * snapshot this holder cannot establish as its own is refused with its reason
 * rather than bundled.
 *
 * It reads the FILE, not the bytes a preceding checkpoint returned: a rename
 * landing in between would otherwise put another holder's older image into
 * today's backup, and the bundle's own validator cannot catch that — it derives
 * the AEAD context from the envelope's own stamp, so a foreign-stamped envelope
 * decrypts cleanly and `quick_check` passes on a coherent but stale image.
 */
export function readVerifiedSnapshot(snapshotPath: string, stamp: string | undefined): Buffer {
  const bytes = fs.readFileSync(snapshotPath);
  const verdict = fromEnvelope(bytes, stamp);
  if (verdict.outcome !== "mine") throw snapshotRefusal(verdict);
  return bytes;
}
