import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file";
import { GCM_TAG_BYTES, NONCE_BYTES } from "./crypto";
import { VAULT_SNAPSHOT_MAGIC, parseVaultHeader } from "./format";

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

/**
 * Restore a backup bundle into a data dir: `<dataDir>/vault/vault.json` plus
 * `<dataDir>/dokan.db.enc`, written atomically. The caller opens the dir with a
 * fresh VaultManager and unlocks with the passphrase or a recovery key.
 */
export async function extractVaultBackup(
  bundle: Uint8Array,
  dataDir: string,
): Promise<{ headerPath: string; snapshotPath: string }> {
  const decoded = readVaultBackupBundle(bundle);
  if (decoded === undefined) throw new Error("not a Dokan vault backup bundle");
  const vaultDir = path.join(dataDir, "vault");
  fs.mkdirSync(vaultDir, { recursive: true });
  const headerPath = path.join(vaultDir, "vault.json");
  const snapshotPath = path.join(dataDir, "dokan.db.enc");
  // snapshot first, header second: the same ordering first-run setup uses, so a
  // crash mid-restore leaves an unconfigured dir, never a header without data
  await writeFileAtomic(snapshotPath, decoded.snapshot);
  await writeFileAtomic(headerPath, decoded.headerText);
  return { headerPath, snapshotPath };
}
