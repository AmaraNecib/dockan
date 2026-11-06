import { Database } from "bun:sqlite";

import { CURRENT_SCHEMA_VERSION, UnsupportedSchemaVersionError, readSchemaVersion } from "../schema-version";
import { open } from "./crypto";
import { VaultCore } from "./core";
import { VAULT_BACKUP_MAGIC, readVaultBackupBundle } from "./backup";
import { parseVaultHeader, readSnapshotFence, snapshotAadFor } from "./format";

export type RestoreCredential = { passphrase: string } | { recoveryKey: string };

export type VaultBackupPreview = {
  vaultId: string;
  createdAt: string;
  schemaVersion: number;
  supportedSchemaVersion: number;
  compatible: true;
};

/**
 * Authenticate and inspect a backup without writing its decrypted image to disk.
 * Older schemas are accepted for the existing store setup migrations; newer
 * schemas and failed integrity checks are refused before any live state changes.
 */
export async function preflightVaultBackup(
  bundleBytes: Uint8Array,
  credential: RestoreCredential,
): Promise<VaultBackupPreview> {
  const bundle = Buffer.from(bundleBytes);
  if (bundle.length < VAULT_BACKUP_MAGIC.length || !bundle.subarray(0, VAULT_BACKUP_MAGIC.length).equals(VAULT_BACKUP_MAGIC)) {
    throw new Error("VAULT_BACKUP_INVALID");
  }
  const decoded = readVaultBackupBundle(bundle);
  if (decoded === undefined) throw new Error("VAULT_BACKUP_INVALID");

  const header = parseVaultHeader(decoded.headerText);
  const core = VaultCore.open({ read: () => decoded.headerText, write: async () => {} });
  if (core === undefined) throw new Error("VAULT_BACKUP_INVALID");
  const masterKey = "passphrase" in credential
    ? core.unlockPassphrase(credential.passphrase)
    : core.unlockRecovery(credential.recoveryKey);
  let image: Buffer | undefined;
  let raw: Database | undefined;
  try {
    const fence = readSnapshotFence(decoded.snapshot);
    if (fence === undefined) throw new Error("VAULT_CORRUPT");
    image = open(masterKey, decoded.snapshot.subarray(fence.bodyOffset), snapshotAadFor(header.vaultId, fence.stamp));
    raw = Database.deserialize(image);
    // SAFETY: SQLite quick_check returns one row with a `quick_check` text column.
    const check = raw.query("PRAGMA quick_check").get() as { quick_check?: string } | null;
    if (check?.quick_check !== "ok") throw new Error("VAULT_CORRUPT");
    if (raw.query("PRAGMA foreign_key_check").get() !== null) throw new Error("VAULT_CORRUPT");
    const schemaVersion = readSchemaVersion(raw);
    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new UnsupportedSchemaVersionError(schemaVersion, CURRENT_SCHEMA_VERSION);
    }
    return {
      vaultId: header.vaultId,
      createdAt: header.createdAt,
      schemaVersion,
      supportedSchemaVersion: CURRENT_SCHEMA_VERSION,
      compatible: true,
    };
  } catch (error) {
    if (error instanceof UnsupportedSchemaVersionError) throw error;
    if (error instanceof Error && error.message === "VAULT_BACKUP_INVALID") throw error;
    throw new Error("VAULT_BACKUP_CORRUPT", { cause: error });
  } finally {
    try {
      raw?.close();
    } finally {
      image?.fill(0);
      decoded.snapshot.fill(0);
      masterKey.fill(0);
      bundle.fill(0);
    }
  }
}
