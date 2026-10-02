import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AppLogger } from "../logger";
import { readVaultBackupBundle, extractVaultBackup } from "./backup";
import { VaultAuthenticationError, type KdfParams } from "./crypto";
import { VaultAlreadyConfiguredError, VaultLockedError, VaultManager, VaultSetupInProgressError, unlockBackoffMs } from "./manager";

const FAST_KDF: KdfParams = { algorithm: "argon2id", memoryKiB: 64, iterations: 1, parallelism: 1, keyLength: 32 };
const PASSPHRASE = "correct horse";

let dir: string;
let clock: number;
const extraDirs: string[] = [];

function manager(): VaultManager {
  return new VaultManager({
    dataDir: dir,
    legacyDbPath: path.join(dir, "dokan.db"),
    logger: new AppLogger(dir),
    kdf: FAST_KDF,
    now: () => new Date(clock),
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-vault-manager-"));
  clock = 1_700_000_000_000;
});

afterEach(() => {
  for (const extra of extraDirs.splice(0)) fs.rmSync(extra, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

async function createVault(vault: VaultManager): Promise<string> {
  await vault.prepareSetup(PASSPHRASE);
  const token = await vault.commitSetup();
  return token;
}

describe("VaultManager", () => {
  it("reports unconfigured, then locked, then unlocked", async () => {
    const vault = manager();
    expect(vault.status().state).toBe("unconfigured");
    await vault.prepareSetup("correct horse");
    // preparation is not persistence: no header written yet
    expect(vault.status().state).toBe("unconfigured");
    await vault.commitSetup();
    expect(vault.status().state).toBe("unlocked");
    vault.close();
    expect(manager().status().state).toBe("locked");
  });

  it("writes the header and the initial recovery key through the commit", async () => {
    const vault = manager();
    const prepared = await vault.prepareSetup("correct horse");
    expect(prepared.recoveryKey).toMatch(/^([A-Z2-7]{4}-){8}[A-Z2-7]{2}$/);
    expect(vault.status().recoveryKeyCount).toBe(0);
    await vault.commitSetup();
    expect(vault.status().recoveryKeyCount).toBe(1);
    expect(fs.existsSync(path.join(dir, "vault", "vault.json"))).toBe(true);
  });

  it("unlocks with the passphrase and with the recovery key", async () => {
    const vault = manager();
    const { recoveryKey } = await vault.prepareSetup("correct horse");
    await vault.commitSetup();
    vault.close();

    const reopened = manager();
    const token = await reopened.unlock("correct horse");
    expect(token.length).toBeGreaterThan(20);
    expect(reopened.sessionMatches(token)).toBe(true);
    expect(reopened.sessionMatches("other")).toBe(false);
    expect(reopened.unlocked).toBe(true);
    reopened.close();
    expect(reopened.unlocked).toBe(false);

    const recoveryUnlock = manager();
    await recoveryUnlock.unlockRecovery(recoveryKey);
    expect(recoveryUnlock.unlocked).toBe(true);
  });

  it("refuses a wrong passphrase, records the failure, and locks after five attempts", async () => {
    const vault = manager();
    await createVault(vault);
    vault.close();
    const reopened = manager();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(reopened.unlock("wrong")).rejects.toThrow(VaultAuthenticationError);
    }
    // the sixth attempt is refused before the KDF runs
    await expect(reopened.unlock("wrong")).rejects.toThrow(VaultLockedError);
    const status = reopened.status();
    expect(status.lockedForMs).toBeGreaterThan(0);
    // and the lockout survives a restart (persisted)
    expect(manager().status().lockedForMs).toBeGreaterThan(0);

    // once the lock expires the correct passphrase works and resets the counter
    clock += unlockBackoffMs(5) + 1;
    await reopened.unlock("correct horse");
    expect(reopened.status().lockedForMs).toBe(0);
    expect(manager().status().lockedForMs).toBe(0);
  });

  it("queues pre-unlock failures for the activity log and drains them once", async () => {
    const vault = manager();
    await createVault(vault);
    vault.close();
    const reopened = manager();
    await expect(reopened.unlock("wrong")).rejects.toThrow(VaultAuthenticationError);
    await reopened.unlock("correct horse");
    const events = await reopened.drainPendingEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("VAULT_UNLOCK_FAILED");
    expect(await reopened.drainPendingEvents()).toHaveLength(0);
  });

  it("treats an unreadable header as invalid and refuses to overwrite it", async () => {
    fs.mkdirSync(path.join(dir, "vault"), { recursive: true });
    fs.writeFileSync(path.join(dir, "vault", "vault.json"), "{not json");
    const vault = manager();
    expect(vault.status().state).toBe("invalid");
    await expect(vault.prepareSetup("correct horse")).rejects.toThrow(VaultAlreadyConfiguredError);
  });

  it("rotates recovery keys while unlocked and requires an unlock for the rest", async () => {
    const vault = manager();
    await createVault(vault);
    const added = await vault.addRecoveryKey();
    expect(vault.metadata().wraps.filter((wrap) => wrap.kind === "recovery")).toHaveLength(2);
    await vault.removeRecoveryKey(added.id);
    expect(vault.metadata().wraps.filter((wrap) => wrap.kind === "recovery")).toHaveLength(1);
    vault.close();
    await expect(manager().addRecoveryKey()).rejects.toThrow();
  });

  it("flags a legacy plaintext database in the status for the setup flow", async () => {
    fs.writeFileSync(path.join(dir, "dokan.db"), "SQLite format 3\u0000");
    const vault = manager();
    expect(vault.status().state).toBe("unconfigured");
    expect(vault.status().legacyDatabase).toBe(true);
  });

  it("backs off exponentially after five failures and caps at 15 minutes", () => {
    expect(unlockBackoffMs(1)).toBe(0);
    expect(unlockBackoffMs(4)).toBe(0);
    expect(unlockBackoffMs(5)).toBe(30_000);
    expect(unlockBackoffMs(6)).toBe(60_000);
    expect(unlockBackoffMs(50)).toBe(15 * 60_000);
  });

  it("single-flights first-run setup and releases the slot on abort (finding A6)", async () => {
    const vault = manager();
    await vault.prepareSetup("correct horse battery");
    await expect(vault.prepareSetup("correct horse battery")).rejects.toThrow(VaultSetupInProgressError);
    vault.abortSetup();
    await expect(vault.prepareSetup("correct horse battery")).resolves.toBeDefined();
    await vault.commitSetup();
  });

  it("refuses short passphrases on the NORMALIZED value (finding: spaces)", async () => {
    const vault = manager();
    await expect(vault.prepareSetup("        ")).rejects.toThrow("VAULT_PASSPHRASE_TOO_SHORT");
    await expect(vault.prepareSetup("  short  ")).rejects.toThrow("VAULT_PASSPHRASE_TOO_SHORT");
  });

  it("sets a new passphrase from a recovery key without the old one (finding C4)", async () => {
    const vault = manager();
    const { recoveryKey } = await vault.prepareSetup("correct horse battery");
    await vault.commitSetup();
    vault.close();

    const reopened = manager();
    const token = await reopened.setPassphraseFromRecovery(recoveryKey, "a brand new passphrase");
    expect(reopened.sessionMatches(token)).toBe(true);
    reopened.close();
    await expect(manager().unlock("correct horse battery")).rejects.toThrow(VaultAuthenticationError);
    const fresh = manager();
    await fresh.unlock("a brand new passphrase");
    expect(fresh.unlocked).toBe(true);
  });

  it("rotates the session token when a recovery key is deleted (finding A14)", async () => {
    const vault = manager();
    await createVault(vault);
    const added = await vault.addRecoveryKey();
    const before = await vault.unlock("correct horse");
    const after = await vault.removeRecoveryKey(added.id);
    expect(after).not.toBe(before);
    expect(vault.sessionMatches(before)).toBe(false);
    expect(vault.sessionMatches(after)).toBe(true);
  });

  it("retries the legacy plaintext cleanup on a later unlock until it is gone (finding C11)", async () => {
    const legacyPath = path.join(dir, "dokan.db");
    fs.writeFileSync(legacyPath, "SQLite format 3\u0000");
    fs.writeFileSync(`${legacyPath}-wal`, "wal");
    const vault = manager();
    await createVault(vault);
    // a committed vault makes the plaintext copy stale; cleanup removes it
    await vault.cleanupLegacyPlaintext();
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(`${legacyPath}-wal`)).toBe(false);
    // idempotent on the next unlock
    await vault.cleanupLegacyPlaintext();
    // and a plaintext file without a committed vault is left alone
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-vault-cleanup-"));
    extraDirs.push(otherDir);
    const otherLegacy = path.join(otherDir, "dokan.db");
    fs.writeFileSync(otherLegacy, "SQLite format 3\u0000");
    const unconfigured = new VaultManager({ dataDir: otherDir, legacyDbPath: otherLegacy, logger: new AppLogger(otherDir), kdf: FAST_KDF });
    await unconfigured.cleanupLegacyPlaintext();
    expect(fs.existsSync(otherLegacy)).toBe(true);
  });

  it("clamps a hostile throttle state instead of locking the owner out (finding C13)", async () => {
    fs.mkdirSync(path.join(dir, "vault"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "vault", "state.json"),
      JSON.stringify({ failedAttempts: 999_999, lockUntil: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000, pendingEvents: [] }),
    );
    const vault = manager();
    // the lock is clamped to the 15-minute maximum, not a decade
    expect(vault.status().lockedForMs).toBeLessThanOrEqual(15 * 60_000);
  });

  it("encrypts legacy plaintext backups during cleanup (finding: backups survived migration)", async () => {
    const backupsDir = path.join(dir, "backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    const legacyBackup = path.join(backupsDir, "dokan-2020-01-01.db");
    const db = new Database(legacyBackup, { create: true });
    db.exec("CREATE TABLE items(id TEXT); INSERT INTO items VALUES ('historic')");
    db.exec("PRAGMA user_version = 1");
    db.close();

    const vault = manager();
    const { recoveryKey } = await vault.prepareSetup(PASSPHRASE);
    await vault.commitSetup();

    const result = await vault.cleanupLegacyPlaintext();
    expect(result.plaintextRemaining).toEqual([]);
    // the plaintext name is gone; the bundle lives under .dknvbak
    expect(fs.existsSync(legacyBackup)).toBe(false);
    const bundlePath = path.join(backupsDir, "dokan-2020-01-01.dknvbak");
    const bytes = fs.readFileSync(bundlePath);
    expect(bytes.subarray(0, 8).toString("ascii")).toBe("DKNVBACK");
    expect(bytes.includes(Buffer.from("historic"))).toBe(false);
    expect(readVaultBackupBundle(bytes)).toBeDefined();
    // the bundle unlocks with the recovery key on a fresh dir
    const restoredDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-vault-backup-restore-"));
    extraDirs.push(restoredDir);
    await extractVaultBackup(bytes, restoredDir);
    const restored = new VaultManager({
      dataDir: restoredDir,
      legacyDbPath: path.join(restoredDir, "dokan.db"),
      logger: new AppLogger(restoredDir),
      kdf: FAST_KDF,
    });
    await restored.unlockRecovery(recoveryKey);
    expect(restored.unlocked).toBe(true);
    restored.close();
  });

  it("reports a plaintext backup it could not encrypt (never silently succeeds)", async () => {
    const backupsDir = path.join(dir, "backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    const newerBackup = path.join(backupsDir, "dokan-2020-01-02.db");
    const db = new Database(newerBackup, { create: true });
    db.exec("CREATE TABLE t(a TEXT)");
    db.exec("PRAGMA user_version = 99");
    db.close();

    const vault = manager();
    await createVault(vault);
    const result = await vault.cleanupLegacyPlaintext();
    expect(result.plaintextRemaining).toEqual([newerBackup]);
    // the unencrypted backup is left untouched for a human to handle
    expect(fs.readFileSync(newerBackup).subarray(0, 15).toString("utf8")).toBe("SQLite format 3");
  });

  it("resumes a setup only after its snapshot exists and only with its passphrase (findings 3 + round-4 security)", async () => {
    const vault = manager();
    const { recoveryKey } = await vault.prepareSetup(PASSPHRASE);
    // the first request is still bootstrapping: no snapshot on disk yet
    await expect(vault.resumeSetup(PASSPHRASE)).rejects.toThrow(VaultSetupInProgressError);
    expect(vault.pendingRecoveryKey()).toBe(recoveryKey);
    // once the snapshot is written, a WRONG passphrase is refused and the
    // pending slot (with its recovery key) stays reserved
    fs.writeFileSync(vault.snapshotPath, "placeholder-snapshot");
    await expect(vault.resumeSetup("a totally different passphrase")).rejects.toThrow(VaultAuthenticationError);
    expect(vault.pendingRecoveryKey()).toBe(recoveryKey);
    // the original passphrase resumes and releases the token
    const token = await vault.resumeSetup(PASSPHRASE);
    expect(vault.sessionMatches(token)).toBe(true);
    expect(vault.pendingRecoveryKey()).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "vault", "vault.json"))).toBe(true);
  });

  it("never reads a whole backup file during the sweep (round-4 performance)", async () => {
    const backupsDir = path.join(dir, "backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    const legacyBackup = path.join(backupsDir, "dokan-2020-01-03.db");
    const db = new Database(legacyBackup, { create: true });
    db.exec("CREATE TABLE items(id TEXT)");
    // make the file multi-megabyte with a few zeroblob inserts (no slow loop)
    for (let index = 0; index < 6; index += 1) db.exec("INSERT INTO items SELECT zeroblob(250000)");
    db.exec("PRAGMA user_version = 1");
    db.close();
    expect(fs.statSync(legacyBackup).size).toBeGreaterThan(1_000_000);

    const vault = manager();
    await createVault(vault);
    const readFileSpy = spyOn(fs.promises, "readFile");
    try {
      const result = await vault.cleanupLegacyPlaintext();
      expect(result.plaintextRemaining).toEqual([]);
      // the sweep must inspect the magic with a short read, never readFile()
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      readFileSpy.mockRestore();
    }
    expect(fs.existsSync(path.join(backupsDir, "dokan-2020-01-03.dknvbak"))).toBe(true);

    // a second sweep has nothing left to open: the converted name is the marker
    const secondPass = spyOn(fs.promises, "open");
    try {
      expect((await vault.cleanupLegacyPlaintext()).plaintextRemaining).toEqual([]);
      expect(secondPass).not.toHaveBeenCalled();
    } finally {
      secondPass.mockRestore();
    }
  });
});
