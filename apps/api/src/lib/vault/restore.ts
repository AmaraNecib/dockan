import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { openVaultStore } from "../../db/vault-store";
import { writeFileAtomicSync } from "../atomic-file";
import { createVaultBackupBundle, readVaultBackupBundle } from "./backup";
import { VaultCore } from "./core";
import { acquireVaultLock, holderToken, type VaultLock } from "./lock";
import { preflightVaultBackup, type RestoreCredential } from "./restore-preflight";

const intentSchema = z.object({
  version: z.literal(1),
  state: z.enum(["pending", "committed", "rolled-back"]),
  safetyFile: z.string().regex(/^restore-[a-f0-9-]{36}\.dknvbak$/),
  safetySha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type Intent = z.infer<typeof intentSchema>;
export type RestoreStep = "safety" | "intent" | "snapshot" | "header" | "migrated" | "verified";

function paths(dataDir: string) {
  const vault = path.join(dataDir, "vault");
  return { vault, intent: path.join(vault, "restore-intent.json"), header: path.join(vault, "vault.json"), snapshot: path.join(dataDir, "dokan.db.enc") };
}
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function assertOwner(dataDir: string, lock: VaultLock): void {
  if (path.resolve(lock.path) !== path.resolve(dataDir, "vault.lock")) throw new Error("VAULT_RESTORE_WRONG_LOCK");
  lock.assertHeld();
}
function writeOwned(dataDir: string, lock: VaultLock, file: string, bytes: string | Uint8Array): void {
  assertOwner(dataDir, lock);
  writeFileAtomicSync(file, bytes, { beforeRename: () => assertOwner(dataDir, lock) });
  assertOwner(dataDir, lock);
}
function saveIntent(dataDir: string, lock: VaultLock, intent: Intent): void {
  writeOwned(dataDir, lock, paths(dataDir).intent, `${JSON.stringify(intent)}\n`);
}
function install(dataDir: string, lock: VaultLock, bundle: Uint8Array, progress?: (step: RestoreStep) => void): void {
  const decoded = readVaultBackupBundle(bundle);
  if (decoded === undefined) throw new Error("VAULT_BACKUP_INVALID");
  const p = paths(dataDir);
  writeOwned(dataDir, lock, p.snapshot, decoded.snapshot);
  progress?.("snapshot");
  writeOwned(dataDir, lock, p.header, decoded.headerText);
  progress?.("header");
}

/**
 * Run before opening ANY vault writer, while holding the folder lock. A pending
 * intent means migration/reopen did not finish, even if both incoming files are
 * present. Replay the verified original pair, not whichever half looks newer.
 * The intent remains on disk, so interruption during rollback retries rollback.
 */
export function recoverVaultReplacement(dataDir: string, lock: VaultLock): "none" | "committed" | "rolled-back" {
  assertOwner(dataDir, lock);
  const p = paths(dataDir);
  let text: string;
  try {
    text = fs.readFileSync(p.intent, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "none";
    throw error;
  }
  // Unknown or damaged intent refuses boot. Guessing could open a mixed pair.
  const intent = intentSchema.parse(JSON.parse(text));
  if (intent.state !== "pending") return intent.state;
  const safety = fs.readFileSync(path.join(p.vault, intent.safetyFile));
  if (digest(safety) !== intent.safetySha256) throw new Error("VAULT_RESTORE_SAFETY_DAMAGED");
  install(dataDir, lock, safety);
  saveIntent(dataDir, lock, { ...intent, state: "rolled-back" });
  return "rolled-back";
}

export type ReplaceVaultOptions = {
  dataDir: string;
  bundle: Uint8Array;
  credential: RestoreCredential;
  currentCredential: RestoreCredential;
  /** Progress observers may abort; an abort before commit restores the original. */
  onProgress?: (step: RestoreStep) => void;
};

/**
 * Offline replacement only. Acquiring the folder lock refuses a live sidecar;
 * the native caller must drain and stop it first. No plaintext file is created.
 * One durable pending intent covers installation AND all migration writes.
 * The original bundle is retained after success, with its own key wraps.
 */
export async function replaceVaultOffline(options: ReplaceVaultOptions): Promise<{ safetyPath: string }> {
  const { dataDir, credential, currentCredential, onProgress } = options;
  // Own our input across awaits; a caller cannot change the confirmed bytes.
  const incoming = Buffer.from(options.bundle);
  const lock = acquireVaultLock(dataDir, { onLost: () => {} });
  try {
    recoverVaultReplacement(dataDir, lock);
    await preflightVaultBackup(incoming, credential);
    const p = paths(dataDir);
    const current = createVaultBackupBundle(fs.readFileSync(p.header, "utf8"), fs.readFileSync(p.snapshot));
    // A byte copy alone is not a safety copy. Authenticate its wraps, ciphertext,
    // SQLite integrity and version with the CURRENT credential before swapping.
    await preflightVaultBackup(current, currentCredential);
    const safetyFile = `restore-${randomUUID()}.dknvbak`;
    const safetyPath = path.join(p.vault, safetyFile);
    writeOwned(dataDir, lock, safetyPath, current);
    const saved = fs.readFileSync(safetyPath);
    if (!saved.equals(current)) throw new Error("VAULT_RESTORE_SAFETY_DAMAGED");
    await preflightVaultBackup(saved, currentCredential);
    onProgress?.("safety");
    const intent: Intent = { version: 1, state: "pending", safetyFile, safetySha256: digest(saved) };
    saveIntent(dataDir, lock, intent);
    try {
      onProgress?.("intent");
      install(dataDir, lock, incoming, onProgress);
      await migrateInstalled(dataDir, lock, credential, onProgress);
      // Independently authenticate the persisted migrated image after close.
      await preflightVaultBackup(createVaultBackupBundle(fs.readFileSync(p.header, "utf8"), fs.readFileSync(p.snapshot)), credential);
      onProgress?.("verified");
      saveIntent(dataDir, lock, { ...intent, state: "committed" });
      return { safetyPath };
    } catch (error) {
      // migrateInstalled closes its connection BEFORE this replay. A late
      // checkpoint can therefore never overwrite the recovered original.
      try {
        recoverVaultReplacement(dataDir, lock);
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], `VAULT_RESTORE_RECOVERY_REQUIRED: ${safetyPath}`);
      }
      throw error;
    }
  } finally {
    incoming.fill(0);
    lock.release();
  }
}

async function migrateInstalled(dataDir: string, lock: VaultLock, credential: RestoreCredential, progress?: (step: RestoreStep) => void): Promise<void> {
  const p = paths(dataDir);
  const core = VaultCore.open({ read: () => fs.readFileSync(p.header, "utf8"), write: async () => { throw new Error("restore must retain key wraps"); } });
  if (core === undefined) throw new Error("VAULT_BACKUP_INVALID");
  const key = "passphrase" in credential ? core.unlockPassphrase(credential.passphrase) : core.unlockRecovery(credential.recoveryKey);
  try {
    const { conn, store } = openVaultStore({
      vaultId: core.metadata().vaultId, masterKey: key, snapshotPath: p.snapshot, headerPath: p.header,
      writeGuard: () => assertOwner(dataDir, lock), writeStamp: () => holderToken(lock),
    });
    try {
      // Reuse the real marker-gated migrations. The offline intent makes the
      // entire multi-transaction migration recoverable as one encrypted state.
      await store.setup();
      progress?.("migrated");
      conn.raw.exec('DELETE FROM "session"');
      conn.markDirty();
      await conn.flush();
    } finally {
      await conn.close();
    }
  } finally {
    key.fill(0);
  }
}
