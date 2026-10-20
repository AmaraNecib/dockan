import fs from "node:fs";

import { SNAPSHOT_FENCE_PREFIX_BYTES, readSnapshotFence } from "./format";

/**
 * Whose bytes are these? ONE reader answers that question, so the open path,
 * the pre-write check and the backup check cannot each decide it by hand.
 *
 * What a stamp does and does not prove is stated once, beside
 * `readSnapshotFence` in `format.ts`: it discriminates a helpless former holder
 * and not a deliberate one, because a process holding the master key can mint a
 * validly fenced envelope under the current holder's token.
 */

/**
 * What one envelope says about its owner, read against the stamp a holder
 * writes under. The outcomes are deliberately distinct, because they decide
 * three different things: whether a write is owed, whether the version may be
 * recorded durable, and what the owner is told. Collapsing them is how a busy
 * file ended up reported as "another writer replaced your snapshot" and how a
 * readable failure ended in a fatal exit.
 */
export type FenceVerdict =
  /** the bytes are the version this holder would have written */
  | { outcome: "mine" }
  /** the bytes carry another holder's stamp */
  | { outcome: "foreign"; stamp: string }
  /** the bytes are the legacy envelope and this holder writes stamped ones */
  | { outcome: "unstamped" }
  /** the bytes carry a holder stamp and this holder has none to compare it with */
  | { outcome: "unfenced-holder" }
  /** the bytes are not an envelope this build knows */
  | { outcome: "undecidable" }
  /** there is no file */
  | { outcome: "absent" }
  /** the file is there and could not be read */
  | { outcome: "unreadable" };

/** The stamp a holder writes under; `undefined` for a connection writing the legacy envelope. */
export type HolderStamp = string | undefined;

/**
 * The fence of these bytes, read against the stamp `holder` writes under.
 *
 * `mine` means "the version this holder could have written", which is why it is
 * also the answer for legacy bytes when the holder has no stamp: an unfenced
 * holder writes legacy envelopes, so those bytes are exactly what it writes.
 *
 * The two no-stamp outcomes are mirrors, and collapsing them is the bug this
 * module exists to remove (#307). `unstamped` is about the **disk**: it holds
 * the legacy envelope while this holder writes stamped ones, so its currency is
 * unverifiable. `unfenced-holder` is about the **reader**: the bytes are fenced
 * and this holder has no stamp, so there is no comparison to perform — they are
 * not this holder's version, and `foreign` would claim a comparison the holder
 * cannot make. It was read as both of those, in two functions three calls
 * apart, and they disagreed.
 */
export function fromEnvelope(bytes: Uint8Array, holder: HolderStamp): FenceVerdict {
  const fence = readSnapshotFence(bytes);
  if (fence === undefined) return { outcome: "undecidable" };
  if (fence.stamp === undefined) return holder === undefined ? { outcome: "mine" } : { outcome: "unstamped" };
  if (holder === undefined) return { outcome: "unfenced-holder" };
  return fence.stamp === holder ? { outcome: "mine" } : { outcome: "foreign", stamp: fence.stamp };
}

/**
 * The fence of the file at `snapshotPath`, read as the header prefix so it
 * stays cheap enough to ask before every write.
 *
 * The no-fence answers a path can produce are deliberately distinct.
 * `"absent"` (no file) and `"undecidable"` (bytes that are not a fence this
 * build knows) are both decidable statements about a path that read fine, so
 * asking again cannot change them. `"unreadable"` is an I/O failure — EBUSY,
 * EACCES, a torn prefix — and the file may be perfectly healthy and correctly
 * stamped: to report a foreign writer from it would force a full
 * serialize+encrypt+rename of a multi-megabyte snapshot over a momentary busy
 * handle.
 */
export function fromPath(snapshotPath: string, holder: HolderStamp): FenceVerdict {
  let fd: number | undefined;
  try {
    fd = fs.openSync(snapshotPath, "r");
    const head = Buffer.alloc(SNAPSHOT_FENCE_PREFIX_BYTES);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return fromEnvelope(head.subarray(0, read), holder);
  } catch (error) {
    // SAFETY: the errno `code` probe is how Node reports ENOENT from open; the
    // cast only exposes the field this branch reads
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    // ENOENT is not the only "no snapshot file at this path". A path that is a
    // directory, or whose parent is a file, answers EISDIR or ENOTDIR on open
    // or read. Those are decidable statements about the path, not a transient
    // I/O failure: calling them "unreadable" sent the post-write branch down
    // its benign "written, fence unproven" exit over a snapshot that was gone.
    // Treated as absent, a write is owed, and the write itself then fails
    // loudly because nothing can be renamed over a directory.
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
