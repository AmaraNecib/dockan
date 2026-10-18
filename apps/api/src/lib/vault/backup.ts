import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file";
import { GCM_TAG_BYTES, NONCE_BYTES } from "./crypto";
import { VAULT_SNAPSHOT_MAGIC, parseVaultHeader } from "./format";
import { acquireVaultLock } from "./lock";

/**
 * Self-contained vault backup (finding: a snapshot copy alone cannot be
 * unlocked elsewhere because its key wraps live in `vault.json`). A backup is
 * one file that carries both the header (KDF params + wrapped master keys) and
 * the encrypted snapshot, so either the passphrase or a recovery key restores
 * the shop on another install.
 *
 * Layout: `"DKNVBACK" | version(1) | headerLength(u32 BE) | header UTF-8 | snapshot`.
 */

export const VAULT_BACKUP_MAGIC = Buffer.from("DKNVBACK", "ascii");
export const VAULT_BACKUP_VERSION = 1;

export function createVaultBackupBundle(headerText: string, snapshot: Uint8Array): Buffer {
  const header = Buffer.from(headerText, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length, 0);
  return Buffer.concat([VAULT_BACKUP_MAGIC, Buffer.from([VAULT_BACKUP_VERSION]), length, header, snapshot]);
}

/**
 * Decode a backup bundle. Returns undefined for anything that is not a bundle
 * (a raw `.enc` snapshot copy from a pre-bundle build stays readable by the
 * validator).
 */
export function readVaultBackupBundle(bundle: Uint8Array): { headerText: string; snapshot: Buffer } | undefined {
  const prefix = VAULT_BACKUP_MAGIC.length + 1 + 4;
  if (bundle.length < prefix) return undefined;
  if (!Buffer.from(bundle.subarray(0, VAULT_BACKUP_MAGIC.length)).equals(VAULT_BACKUP_MAGIC)) return undefined;
  if (bundle[VAULT_BACKUP_MAGIC.length] !== VAULT_BACKUP_VERSION) return undefined;
  const headerLength = Buffer.from(bundle.subarray(VAULT_BACKUP_MAGIC.length + 1, prefix)).readUInt32BE(0);
  const headerEnd = prefix + headerLength;
  if (headerEnd >= bundle.length) return undefined;
  const headerText = Buffer.from(bundle.subarray(prefix, headerEnd)).toString("utf8");
  try {
    parseVaultHeader(headerText);
  } catch {
    return undefined;
  }
  const snapshot = Buffer.from(bundle.subarray(headerEnd));
  // the snapshot must at least hold magic + version + nonce + GCM tag, else it
  // can never be a valid envelope and the backup is rejected outright
  const minimumEnvelope = VAULT_SNAPSHOT_MAGIC.length + 1 + NONCE_BYTES + GCM_TAG_BYTES;
  if (snapshot.length < minimumEnvelope) return undefined;
  if (!snapshot.subarray(0, VAULT_SNAPSHOT_MAGIC.length).equals(VAULT_SNAPSHOT_MAGIC)) return undefined;
  return { headerText, snapshot };
}

export type ExtractVaultBackupOptions = {
  /**
   * Called when the folder's lock is lost mid-restore, just before
   * `VaultLockLostError` fails the call. Passing a handler is also what keeps
   * the lock's default fail-stop (`process.exit(1)`, for a holder that never
   * asked to hear about the loss) away from a caller that has an error path of
   * its own. The reason says whether the record vanished or changed owner.
   */
  onLockLost?: (reason: string) => void;
};

/**
 * Restore a backup bundle into a data dir: `<dataDir>/vault/vault.json` plus
 * `<dataDir>/dokan.db.enc`, written atomically. The caller opens the dir with a
 * fresh VaultManager and unlocks with the passphrase or a recovery key.
 *
 * Restore is an OFFLINE write (issue #282). Every other path that writes into a
 * data folder asks the single-writer lock at the instant of the write
 * (ADR-0012 clause 3, #275); a restore that skipped that check could overwrite
 * the snapshot of a shop still running on the same folder — the two-writer
 * outcome the lock exists to prevent. So this function takes the folder's lock
 * around its two writes, and the check is bound to the folder it writes:
 *
 * - `acquireVaultLock(dataDir)` refuses (VaultAlreadyLockedError) while a live
 *   owner holds the folder — another instance, or this same process — and
 *   reclaims a stale lock exactly as the next boot would, so a crashed
 *   instance never blocks a restore.
 * - `assertHeld()` runs before each write and once after the pair, so a lock
 *   lost mid-restore stops the writes instead of overwriting the new owner's
 *   data, and a restore that lost the folder is never reported as completed.
 *   The loss raises `VaultLockLostError` for the caller to catch; it never
 *   ends the caller's process.
 * - The lock is released before returning, so the VaultManager the caller boots
 *   next can take it.
 *
 * A running instance that wants to restore over its own folder must therefore
 * close the connection and release the lock first, or restore into a fresh dir
 * as the cross-install restore does.
 */
export async function extractVaultBackup(
  bundle: Uint8Array,
  dataDir: string,
  options: ExtractVaultBackupOptions = {},
): Promise<{ headerPath: string; snapshotPath: string }> {
  const decoded = readVaultBackupBundle(bundle);
  if (decoded === undefined) throw new Error("not a Dokan vault backup bundle");
  // decode BEFORE locking: garbage input must not take or touch the folder
  const lock = acquireVaultLock(dataDir, {
    // a handler is always present: without one a lost lock fail-stops the whole
    // process inside the lock module, which is the wrong reaction for a caller
    // that can report a failed restore
    onLost: (reason) => options.onLockLost?.(reason),
  });
  try {
    const vaultDir = path.join(dataDir, "vault");
    fs.mkdirSync(vaultDir, { recursive: true });
    const headerPath = path.join(vaultDir, "vault.json");
    const snapshotPath = path.join(dataDir, "dokan.db.enc");
    // snapshot first, header second: the same ordering first-run setup uses, so a
    // crash mid-restore leaves an unconfigured dir, never a header without data.
    // On a folder that already holds a vault this pair is a replacement, not a
    // merge: a failure between the two writes leaves the old header over the new
    // snapshot. Swapping the pair atomically is a separate change; #282 closes
    // the ownership hole only.
    lock.assertHeld();
    await writeFileAtomic(snapshotPath, decoded.snapshot);
    lock.assertHeld();
    await writeFileAtomic(headerPath, decoded.headerText);
    // the pair landed only while the folder was still ours; a theft during the
    // writes is a failed restore, never a silently successful one
    lock.assertHeld();
    return { headerPath, snapshotPath };
  } finally {
    lock.release();
  }
}
