import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { itHeavy } from "../../test-support/heavy";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEncryptedConnection } from "../../db/encrypted-connection";
import { SCHEMA_DDL } from "../../db/schema";
import { CURRENT_SCHEMA_VERSION } from "../schema-version";
import { createDrizzleStore } from "../../store/drizzle-store";
import { AppLogger } from "../logger";
import { classifyPlaintextCleanup } from "./cleanup-status";
import { readVaultBackupBundle, extractVaultBackup } from "./backup";
import { VaultAuthenticationError, type KdfParams } from "./crypto";
import { VaultAlreadyConfiguredError, VaultLockedError, VaultManager, VaultSetupInProgressError, unlockBackoffMs, type VaultSession } from "./manager";

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

async function createVault(vault: VaultManager): Promise<VaultSession> {
  await vault.prepareSetup(PASSPHRASE);
  return await vault.commitSetup();
}

function writeCrashedWalBackup(file: string): void {
  // Kill this isolated writer without closing SQLite so committed rows stay
  // in a genuine WAL instead of a synthetic sidecar fixture.
  const writer = Bun.spawnSync([process.execPath, "-e", `
    const { Database } = require("bun:sqlite");
    const db = new Database(process.argv[1]);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE history(note TEXT); INSERT INTO history VALUES ('committed WAL history');");
    process.kill(process.pid, "SIGKILL");
  `, file]);
  expect(writer.success).toBe(false);
  expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);
}

describe("VaultManager", () => {
  itHeavy("reports unconfigured, then locked, then unlocked", async () => {
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

  itHeavy("writes the header and the initial recovery key through the commit", async () => {
    const vault = manager();
    const prepared = await vault.prepareSetup("correct horse");
    expect(prepared.recoveryKey).toMatch(/^([A-Z2-7]{4}-){8}[A-Z2-7]{2}$/);
    expect(vault.status().recoveryKeyCount).toBe(0);
    await vault.commitSetup();
    expect(vault.status().recoveryKeyCount).toBe(1);
    expect(fs.existsSync(path.join(dir, "vault", "vault.json"))).toBe(true);
  });

  itHeavy("unlocks with the passphrase and with the recovery key", async () => {
    const vault = manager();
    const { recoveryKey } = await vault.prepareSetup("correct horse");
    await vault.commitSetup();
    vault.close();

    const reopened = manager();
    const session = await reopened.unlock("correct horse");
    expect(session.token.length).toBeGreaterThan(20);
    expect(reopened.sessionMatches(session.token)).toBe(true);
    expect(reopened.sessionMatches("other")).toBe(false);
    expect(reopened.unlocked).toBe(true);
    reopened.close();
    expect(reopened.unlocked).toBe(false);

    const recoveryUnlock = manager();
    await recoveryUnlock.unlockRecovery(recoveryKey);
    expect(recoveryUnlock.unlocked).toBe(true);
  });

  itHeavy("refuses a wrong passphrase, records the failure, and locks after five attempts", async () => {
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

  itHeavy("queues pre-unlock failures for the activity log and drains them once", async () => {
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

  itHeavy("treats an unreadable header as invalid and refuses to overwrite it", async () => {
    fs.mkdirSync(path.join(dir, "vault"), { recursive: true });
    fs.writeFileSync(path.join(dir, "vault", "vault.json"), "{not json");
    const vault = manager();
    expect(vault.status().state).toBe("invalid");
    await expect(vault.prepareSetup("correct horse")).rejects.toThrow(VaultAlreadyConfiguredError);
  });

  itHeavy("rotates recovery keys while unlocked and requires an unlock for the rest", async () => {
    const vault = manager();
    await createVault(vault);
    const added = await vault.addRecoveryKey();
    expect(vault.metadata().wraps.filter((wrap) => wrap.kind === "recovery")).toHaveLength(2);
    await vault.removeRecoveryKey(added.id);
    expect(vault.metadata().wraps.filter((wrap) => wrap.kind === "recovery")).toHaveLength(1);
    vault.close();
    await expect(manager().addRecoveryKey()).rejects.toThrow();
  });

  itHeavy("flags a legacy plaintext database in the status for the setup flow", async () => {
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

  itHeavy("single-flights first-run setup and releases the slot on abort (finding A6)", async () => {
    const vault = manager();
    await vault.prepareSetup("correct horse battery");
    await expect(vault.prepareSetup("correct horse battery")).rejects.toThrow(VaultSetupInProgressError);
    vault.abortSetup();
    await expect(vault.prepareSetup("correct horse battery")).resolves.toBeDefined();
    await vault.commitSetup();
  });

  itHeavy("refuses short passphrases on the NORMALIZED value (finding: spaces)", async () => {
    const vault = manager();
    await expect(vault.prepareSetup("        ")).rejects.toThrow("VAULT_PASSPHRASE_TOO_SHORT");
    await expect(vault.prepareSetup("  short  ")).rejects.toThrow("VAULT_PASSPHRASE_TOO_SHORT");
  });

  itHeavy("sets a new passphrase from a recovery key without the old one (finding C4)", async () => {
    const vault = manager();
    const { recoveryKey } = await vault.prepareSetup("correct horse battery");
    await vault.commitSetup();
    vault.close();

    const reopened = manager();
    const session = await reopened.setPassphraseFromRecovery(recoveryKey, "a brand new passphrase");
    expect(reopened.sessionMatches(session.token)).toBe(true);
    reopened.close();
    await expect(manager().unlock("correct horse battery")).rejects.toThrow(VaultAuthenticationError);
    const fresh = manager();
    await fresh.unlock("a brand new passphrase");
    expect(fresh.unlocked).toBe(true);
  });

  itHeavy("rotates the session token when a recovery key is deleted (finding A14)", async () => {
    const vault = manager();
    await createVault(vault);
    const added = await vault.addRecoveryKey();
    const before = await vault.unlock("correct horse");
    const after = await vault.removeRecoveryKey(added.id);
    expect(after.token).not.toBe(before.token);
    expect(vault.sessionMatches(before.token)).toBe(false);
    expect(vault.sessionMatches(after.token)).toBe(true);
  });

  itHeavy("serializes concurrent credential changes so each response carries a valid, ordered token (round-7 finding 5)", async () => {
    const vault = manager();
    await createVault(vault);
    const added = await vault.addRecoveryKey();
    // two credential changes race: the mutation AND its rotation are now one
    // queued unit, so the generations are strictly ordered
    const before = vault.sessionEpoch();
    const [changed, removed] = await Promise.all([
      vault.changePassphrase("correct horse", "a brand new passphrase"),
      vault.removeRecoveryKey(added.id),
    ]);
    expect(vault.sessionEpoch()).toBe(before + 2);
    // both rotations were minted in queue order, and exactly the newest one is
    // still accepted; its generation is what the web keeps
    expect(changed.token).not.toBe(removed.token);
    expect([changed, removed].filter((session) => vault.sessionMatches(session.token))).toHaveLength(1);
  });
  itHeavy("retries the legacy plaintext cleanup on a later unlock until it is gone (finding C11)", async () => {
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

  itHeavy("clamps a hostile throttle state instead of locking the owner out (finding C13)", async () => {
    fs.mkdirSync(path.join(dir, "vault"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "vault", "state.json"),
      JSON.stringify({ failedAttempts: 999_999, lockUntil: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000, pendingEvents: [] }),
    );
    const vault = manager();
    // the lock is clamped to the 15-minute maximum, not a decade
    expect(vault.status().lockedForMs).toBeLessThanOrEqual(15 * 60_000);
  });

  itHeavy("encrypts legacy plaintext backups during cleanup (finding: backups survived migration)", async () => {
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

  itHeavy("converts a completed partial without replacing the same day's historical backup", async () => {
    const backupsDir = path.join(dir, "backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    const completed = path.join(backupsDir, "dokan-2020-01-01.db");
    const partial = `${completed}.partial.123.abcdef012345`;
    for (const [file, value] of [[completed, "completed"], [partial, "interrupted"]] as const) {
      const db = new Database(file, { create: true });
      db.exec(`CREATE TABLE items(id TEXT); INSERT INTO items VALUES ('${value}'); PRAGMA user_version = 1`);
      db.close();
    }
    const vault = manager();
    await createVault(vault);
    const outcome = await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), () => {});
    expect(outcome).toEqual({ status: "clean", remaining: [] });
    expect(fs.existsSync(completed)).toBe(false);
    expect(fs.existsSync(partial)).toBe(false);
    const completedBundle = fs.readFileSync(path.join(backupsDir, "dokan-2020-01-01.dknvbak"));
    const partialBundle = fs.readFileSync(`${partial}.dknvbak`);
    expect(readVaultBackupBundle(completedBundle)).toBeDefined();
    expect(readVaultBackupBundle(partialBundle)).toBeDefined();
    expect(completedBundle.equals(partialBundle)).toBe(false);
    for (const [bundle, value] of [[completedBundle, "completed"], [partialBundle, "interrupted"]] as const) {
      const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-partial-restore-"));
      extraDirs.push(restoreDir);
      await extractVaultBackup(bundle, restoreDir);
      const restored = new VaultManager({ dataDir: restoreDir, legacyDbPath: path.join(restoreDir, "dokan.db"), logger: new AppLogger(restoreDir), kdf: FAST_KDF });
      await restored.unlock(PASSPHRASE);
      const connection = createEncryptedConnection({ snapshotPath: restored.snapshotPath, masterKey: restored.requireMasterKey(), vaultId: restored.metadata().vaultId });
      try {
        expect(connection.raw.query("SELECT id FROM items").all()).toEqual([{ id: value }]);
      } finally {
        await connection.close();
        restored.close();
      }
    }
    expect(await vault.cleanupLegacyPlaintext()).toEqual({ plaintextRemaining: [] });
    vault.close();
  });

  itHeavy("preserves schema-9 expense refunds through partial conversion and store restore", async () => {
    const backupsDir = path.join(dir, "backups");
    fs.mkdirSync(backupsDir);
    const partial = path.join(backupsDir, "dokan-2020-01-01.db.partial.123.abcdef012345");
    const db = new Database(partial, { create: true });
    db.exec(SCHEMA_DDL.join(";"));
    db.exec(`
      INSERT INTO expense_categories VALUES ('rent', 'Historical rent', 0, '2019-01-01T00:00:00', '2019-01-01T00:00:00');
      INSERT INTO expenses VALUES ('expense', 'rent', 1000, 'Historical expense', '2019-01-15T10:00:00', '2019-01-16T11:00:00', NULL, NULL);
      INSERT INTO expense_refunds VALUES ('refund', 'expense', -300, '2019-02-12T10:00:00', '2026-10-28T13:34:56', 'refund-actor', 'Refund owner', 'Cash recovered', 'refund-key', NULL);
      PRAGMA user_version = 9;
    `);
    db.close();
    const vault = manager();
    await createVault(vault);
    try {
      expect(await vault.cleanupLegacyPlaintext()).toEqual({ plaintextRemaining: [] });
      expect(fs.existsSync(partial)).toBe(false);
      const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-refund-backup-restore-"));
      extraDirs.push(restoreDir);
      await extractVaultBackup(fs.readFileSync(`${partial}.dknvbak`), restoreDir);
      const restored = new VaultManager({ dataDir: restoreDir, legacyDbPath: path.join(restoreDir, "dokan.db"), logger: new AppLogger(restoreDir), kdf: FAST_KDF });
      await restored.unlock(PASSPHRASE);
      const connection = createEncryptedConnection({ snapshotPath: restored.snapshotPath, masterKey: restored.requireMasterKey(), vaultId: restored.metadata().vaultId });
      try {
        const store = createDrizzleStore(connection);
        await store.setup();
        const history = await store.getExpenseRefundHistory("expense");
        expect(connection.raw.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
        expect(history?.expense.original.amount).toBe(1000);
        expect(history?.refundableAmount).toBe(700);
        expect(history?.refunds).toEqual([{
          id: "refund", expenseId: "expense", difference: -300,
          occurredAt: "2019-02-12T10:00:00", recordedAt: "2026-10-28T13:34:56",
          actorId: "refund-actor", actorName: "Refund owner", reason: "Cash recovered",
          reversesRefundId: null, reversedByRefundId: null,
        }]);
        expect(await store.findExpenseRefundByIdempotencyKey("expense", "refund-key")).toMatchObject({ id: "refund", difference: -300 });
      } finally {
        await connection.close();
        restored.close();
      }
    } finally {
      vault.close();
    }
  });

  itHeavy("cleans the configured backup root when the legacy database is elsewhere", async () => {
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-custom-db-"));
    extraDirs.push(legacyRoot);
    const backupsDir = path.join(dir, "backups");
    const unrelatedDir = path.join(legacyRoot, "backups");
    fs.mkdirSync(backupsDir);
    fs.mkdirSync(unrelatedDir);
    const files = ["dokan-2020-01-01.db", "dokan-2020-01-02.db.partial.456.012345abcdef"];
    for (const name of files) {
      const db = new Database(path.join(backupsDir, name), { create: true });
      db.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('shop history'); PRAGMA user_version = 1");
      db.close();
      fs.copyFileSync(path.join(backupsDir, name), path.join(unrelatedDir, name));
    }
    const unrelatedBytes = files.map((name) => fs.readFileSync(path.join(unrelatedDir, name)));
    const vault = new VaultManager({
      dataDir: dir,
      legacyDbPath: path.join(legacyRoot, "custom.db"),
      logger: new AppLogger(dir),
      kdf: FAST_KDF,
    });
    await createVault(vault);
    expect(await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), () => {})).toEqual({ status: "clean", remaining: [] });
    expect(files.map((name) => fs.existsSync(path.join(backupsDir, name)))).toEqual([false, false]);
    expect(files.map((name) => fs.readFileSync(path.join(unrelatedDir, name)))).toEqual(unrelatedBytes);
    expect(fs.readdirSync(backupsDir).sort()).toEqual([
      "dokan-2020-01-01.dknvbak",
      "dokan-2020-01-02.db.partial.456.012345abcdef.dknvbak",
    ]);
    vault.close();
  });

  itHeavy("preserves incomplete and unknown writer artifacts as remaining", async () => {
    const backupsDir = path.join(dir, "backups");
    fs.mkdirSync(backupsDir);
    const contents = [Buffer.alloc(0), Buffer.from("SQLite format"), Buffer.from("SQLite format 3\u0000shop data"), Buffer.from("unrecognized shop data")];
    const names = contents.map((_, index) => path.join(backupsDir, `dokan-2020-01-0${index + 1}.db.partial.123.abcdef012345`));
    names.push(path.join(backupsDir, "dokan-2020-01-05.db"));
    contents.push(Buffer.from("incomplete completed backup"));
    names.forEach((name, index) => fs.writeFileSync(name, contents[index] ?? Buffer.alloc(0)));
    const vault = manager();
    await createVault(vault);
    const cleanup = await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), () => {});
    expect(cleanup.status).toBe("remaining");
    expect([...cleanup.remaining].sort()).toEqual([...names].sort());
    expect(names.map((name) => fs.readFileSync(name))).toEqual(contents);
    expect(fs.readdirSync(backupsDir).sort()).toEqual(names.map((name) => path.basename(name)).sort());
    expect([...(await vault.cleanupLegacyPlaintext()).plaintextRemaining].sort()).toEqual([...names].sort());
    vault.close();
  });

  itHeavy("reports an unreadable backup inventory as unknown and retries after repair", async () => {
    const backupsDir = path.join(dir, "backups");
    fs.writeFileSync(backupsDir, "not a directory");
    const vault = manager();
    await createVault(vault);
    const errors: Error[] = [];
    expect(await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), (error) => errors.push(error))).toEqual({ status: "unknown", remaining: [] });
    expect(errors).toHaveLength(1);
    expect(fs.readFileSync(backupsDir, "utf8")).toBe("not a directory");
    fs.unlinkSync(backupsDir);
    fs.mkdirSync(backupsDir);
    expect(await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), () => {})).toEqual({ status: "clean", remaining: [] });
    vault.close();
  });

  itHeavy("preserves partial backups through read, write and unlink failures and retries after restart", async () => {
    const backupsDir = path.join(dir, "backups");
    fs.mkdirSync(backupsDir);
    const partial = path.join(backupsDir, "dokan-2020-01-01.db.partial.123.abcdef012345");
    const db = new Database(partial, { create: true });
    db.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('recoverable'); PRAGMA user_version = 1");
    db.close();
    const original = fs.readFileSync(partial);
    let vault = manager();
    await createVault(vault);
    for (const failure of ["read", "write", "unlink"] as const) {
      fs.writeFileSync(partial, original);
      const error = Object.assign(new Error(`injected ${failure} failure`), { code: "EACCES" });
      const open = fs.promises.open.bind(fs.promises);
      const rename = fs.promises.rename.bind(fs.promises);
      const unlink = fs.promises.unlink.bind(fs.promises);
      const fault = failure === "read"
        ? spyOn(fs.promises, "open").mockImplementation((file, ...args) => String(file) === partial ? Promise.reject(error) : open(file, ...args))
        : failure === "write"
          ? spyOn(fs.promises, "rename").mockImplementation((source, dest) => String(dest) === `${partial}.dknvbak` ? Promise.reject(error) : rename(source, dest))
          : spyOn(fs.promises, "unlink").mockImplementation((file) => String(file) === partial ? Promise.reject(error) : unlink(file));
      try {
        expect(await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), () => {})).toEqual({ status: "remaining", remaining: [partial] });
        expect(fs.readFileSync(partial)).toEqual(original);
      } finally {
        fault.mockRestore();
      }
      vault.close();
      vault = manager();
      await vault.unlock(PASSPHRASE);
      expect(await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), () => {})).toEqual({ status: "clean", remaining: [] });
      expect(fs.existsSync(partial)).toBe(false);
      expect(readVaultBackupBundle(fs.readFileSync(`${partial}.dknvbak`))).toBeDefined();
    }
    vault.close();
  });

  itHeavy("refuses a locked sweep without deleting legacy recovery files", async () => {
    const backupsDir = path.join(dir, "backups");
    fs.mkdirSync(backupsDir);
    const partial = path.join(backupsDir, "dokan-2020-01-01.db.partial.123.abcdef012345");
    fs.writeFileSync(partial, "incomplete shop history");
    const vault = manager();
    await createVault(vault);
    vault.close();
    fs.writeFileSync(path.join(dir, "dokan.db"), "legacy recovery copy");
    expect(await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), () => {})).toEqual({ status: "unknown", remaining: [] });
    expect(fs.readFileSync(partial, "utf8")).toBe("incomplete shop history");
    expect(fs.readFileSync(path.join(dir, "dokan.db"), "utf8")).toBe("legacy recovery copy");
    await vault.unlock(PASSPHRASE);
    expect(await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), () => {})).toEqual({ status: "remaining", remaining: [partial] });
    expect(fs.existsSync(path.join(dir, "dokan.db"))).toBe(false);
    vault.close();
  });

  itHeavy("keeps encrypted backups and unrelated names unchanged while reporting non-file candidates", async () => {
    const backupsDir = path.join(dir, "backups");
    fs.mkdirSync(backupsDir);
    const vault = manager();
    await createVault(vault);
    const completed = path.join(backupsDir, "dokan-2020-01-01.db");
    const db = new Database(completed, { create: true });
    db.exec("CREATE TABLE t(a TEXT); PRAGMA user_version = 1");
    db.close();
    await vault.cleanupLegacyPlaintext();
    const encrypted = fs.readFileSync(path.join(backupsDir, "dokan-2020-01-01.dknvbak"));
    fs.writeFileSync(completed, encrypted);
    const unrelated = ["notes.db", "notes.db.partial.123.abcdef012345", "dokan-2020-01-01.db.partial.notes", "dokan-2020-01-01.dknvbak"];
    const originals = unrelated.map((name) => {
      const file = path.join(backupsDir, name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, "unrelated contents");
      return fs.readFileSync(file);
    });
    const candidateDirectory = path.join(backupsDir, "dokan-2020-01-02.db.partial.123.abcdef012345");
    fs.mkdirSync(candidateDirectory);
    expect(await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), () => {})).toEqual({ status: "remaining", remaining: [candidateDirectory] });
    expect(fs.readFileSync(completed)).toEqual(encrypted);
    expect(unrelated.map((name) => fs.readFileSync(path.join(backupsDir, name)))).toEqual(originals);
    expect(fs.statSync(candidateDirectory).isDirectory()).toBe(true);
    vault.close();
  });

  itHeavy("reports failed sidecar removal and orphaned sidecars without losing their recovery source", async () => {
    const backupsDir = path.join(dir, "backups");
    fs.mkdirSync(backupsDir);
    const partial = path.join(backupsDir, "dokan-2020-01-01.db.partial.123.abcdef012345");
    const db = new Database(partial, { create: true });
    db.exec("CREATE TABLE t(a TEXT); PRAGMA user_version = 1");
    db.close();
    const vault = manager();
    await createVault(vault);
    const sidecar = `${partial}-wal`;
    const rename = fs.promises.rename.bind(fs.promises);
    const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (source, dest) => {
      await rename(source, dest);
      if (String(dest) === `${partial}.dknvbak`) fs.writeFileSync(sidecar, "readable historical page");
    });
    const unlink = fs.promises.unlink.bind(fs.promises);
    const unlinkSpy = spyOn(fs.promises, "unlink").mockImplementation((file) => String(file) === sidecar
      ? Promise.reject(Object.assign(new Error("sidecar denied"), { code: "EACCES" })) : unlink(file));
    try {
      const outcome = await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), () => {});
      expect(outcome.status).toBe("remaining");
      expect(outcome.remaining).toContain(sidecar);
      expect(outcome.remaining).toContain(partial);
      expect(fs.existsSync(partial)).toBe(true);
      expect(fs.readFileSync(sidecar, "utf8")).toBe("readable historical page");
    } finally {
      renameSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
    expect(await vault.cleanupLegacyPlaintext()).toEqual({ plaintextRemaining: [] });
    expect(fs.existsSync(sidecar)).toBe(false);
    expect(fs.existsSync(partial)).toBe(false);
    const orphan = path.join(backupsDir, "dokan-2020-01-02.db.partial.456.abcdef012345-shm");
    fs.writeFileSync(orphan, "orphan recovery data");
    expect(await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), () => {})).toEqual({ status: "remaining", remaining: [orphan] });
    expect(fs.readFileSync(orphan, "utf8")).toBe("orphan recovery data");
    vault.close();
  });

  itHeavy("preserves committed WAL history when encrypted publication fails", async () => {
    const backupsDir = path.join(dir, "backups");
    fs.mkdirSync(backupsDir);
    const partial = path.join(backupsDir, "dokan-2020-01-01.db.partial.123.abcdef012345");
    writeCrashedWalBackup(partial);
    const vault = manager();
    await createVault(vault);
    const open = fs.promises.open.bind(fs.promises);
    const fault = spyOn(fs.promises, "open").mockImplementation((file, ...args) => String(file).includes(".dknvbak.tmp-")
      ? Promise.reject(Object.assign(new Error("bundle write denied"), { code: "EACCES" })) : open(file, ...args));
    try {
      const outcome = await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), () => {});
      expect(outcome.status).toBe("remaining");
      expect(outcome.remaining).toContain(partial);
      expect(fs.existsSync(`${partial}.dknvbak`)).toBe(false);
      const preserved = new Database(partial, { readonly: true });
      try {
        expect(preserved.query("SELECT note FROM history").all()).toEqual([{ note: "committed WAL history" }]);
      } finally {
        preserved.close();
      }
    } finally {
      fault.mockRestore();
      vault.close();
    }
  });

  for (const transition of ["unlock", "close"] as const) {
    itHeavy(`preserves partial history when cleanup crosses a concurrent ${transition}`, async () => {
      const backupsDir = path.join(dir, "backups");
      fs.mkdirSync(backupsDir);
      const partial = path.join(backupsDir, "dokan-2020-01-01.db.partial.123.abcdef012345");
      const db = new Database(partial, { create: true });
      db.exec("CREATE TABLE history(note TEXT); INSERT INTO history VALUES ('original history');");
      db.close();
      const original = fs.readFileSync(partial);
      const vault = manager();
      await createVault(vault);
      let entered: () => void = () => {};
      let release: () => void = () => {};
      const readStarted = new Promise<void>((resolve) => { entered = resolve; });
      const mayRead = new Promise<void>((resolve) => { release = resolve; });
      const open = fs.promises.open.bind(fs.promises);
      const gate = spyOn(fs.promises, "open").mockImplementation(async (file, ...args) => {
        if (String(file) === partial) {
          entered();
          await mayRead;
        }
        return open(file, ...args);
      });
      let sweep: Promise<{ plaintextRemaining: string[] }> | undefined;
      try {
        sweep = vault.cleanupLegacyPlaintext();
        await readStarted;
        if (transition === "unlock") await vault.unlock(PASSPHRASE);
        else vault.close();
        release();
        const cleanup = await sweep;
        if (transition === "close") {
          expect(cleanup).toEqual({ plaintextRemaining: [partial] });
          expect(fs.readFileSync(partial).equals(original)).toBe(true);
          expect(fs.existsSync(`${partial}.dknvbak`)).toBe(false);
        } else {
          expect(cleanup).toEqual({ plaintextRemaining: [] });
          expect(fs.existsSync(partial)).toBe(false);
          const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-racing-unlock-restore-"));
          extraDirs.push(restoreDir);
          await extractVaultBackup(fs.readFileSync(`${partial}.dknvbak`), restoreDir);
          const restored = new VaultManager({ dataDir: restoreDir, legacyDbPath: path.join(restoreDir, "dokan.db"), logger: new AppLogger(restoreDir), kdf: FAST_KDF });
          try {
            await restored.unlock(PASSPHRASE);
            let connection: ReturnType<typeof createEncryptedConnection> | undefined;
            try {
              expect(() => {
                connection = createEncryptedConnection({ snapshotPath: restored.snapshotPath, masterKey: restored.requireMasterKey(), vaultId: restored.metadata().vaultId });
              }).not.toThrow();
              expect(connection?.raw.query("SELECT note FROM history").all()).toEqual([{ note: "original history" }]);
            } finally {
              await connection?.close();
            }
          } finally {
            restored.close();
          }
        }
      } finally {
        release();
        await sweep?.catch(() => {});
        gate.mockRestore();
        vault.close();
      }
    });
  }

  itHeavy("converts committed crashed-writer WAL history into a restorable encrypted bundle", async () => {
    const backupsDir = path.join(dir, "backups");
    fs.mkdirSync(backupsDir);
    const partial = path.join(backupsDir, "dokan-2020-01-01.db.partial.123.abcdef012345");
    writeCrashedWalBackup(partial);
    const vault = manager();
    await createVault(vault);
    try {
      expect(await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), () => {})).toEqual({ status: "clean", remaining: [] });
      for (const suffix of ["", "-wal", "-shm"]) expect(fs.existsSync(`${partial}${suffix}`)).toBe(false);
      const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-wal-restore-"));
      extraDirs.push(restoreDir);
      await extractVaultBackup(fs.readFileSync(`${partial}.dknvbak`), restoreDir);
      const restored = new VaultManager({ dataDir: restoreDir, legacyDbPath: path.join(restoreDir, "dokan.db"), logger: new AppLogger(restoreDir), kdf: FAST_KDF });
      await restored.unlock(PASSPHRASE);
      const connection = createEncryptedConnection({ snapshotPath: restored.snapshotPath, masterKey: restored.requireMasterKey(), vaultId: restored.metadata().vaultId });
      try {
        expect(connection.raw.query("SELECT note FROM history").all()).toEqual([{ note: "committed WAL history" }]);
      } finally {
        await connection.close();
        restored.close();
      }
    } finally {
      vault.close();
    }
  });

  itHeavy("stops backup publication and source deletion when folder ownership is lost", async () => {
    const backupsDir = path.join(dir, "backups");
    fs.mkdirSync(backupsDir);
    const partial = path.join(backupsDir, "dokan-2020-01-01.db.partial.123.abcdef012345");
    const db = new Database(partial, { create: true });
    db.exec("CREATE TABLE t(a TEXT); PRAGMA user_version = 1");
    db.close();
    let held = true;
    const options = {
      dataDir: dir, legacyDbPath: path.join(dir, "dokan.db"), logger: new AppLogger(dir), kdf: FAST_KDF,
      cleanupWriteGuard: () => { if (!held) throw new Error("folder ownership lost"); },
    };
    const vault = new VaultManager(options);
    await createVault(vault);
    const open = fs.promises.open.bind(fs.promises);
    const fault = spyOn(fs.promises, "open").mockImplementation(async (file, ...args) => {
      const handle = await open(file, ...args);
      if (String(file).includes(".dknvbak.tmp-")) held = false;
      return handle;
    });
    try {
      expect(await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), () => {})).not.toEqual({ status: "clean", remaining: [] });
      expect(fs.existsSync(partial)).toBe(true);
      expect(fs.existsSync(`${partial}.dknvbak`)).toBe(false);
    } finally {
      fault.mockRestore();
    }
    held = true;
    expect(await vault.cleanupLegacyPlaintext()).toEqual({ plaintextRemaining: [] });
    expect(fs.existsSync(partial)).toBe(false);
    vault.close();
  });

  itHeavy("refuses a redirected backup root without touching another directory", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-outside-backups-"));
    extraDirs.push(outside);
    const file = path.join(outside, "dokan-2020-01-01.db");
    const db = new Database(file, { create: true });
    db.exec("CREATE TABLE t(a TEXT); PRAGMA user_version = 1");
    db.close();
    const original = fs.readFileSync(file);
    const backupsDir = path.join(dir, "backups");
    fs.symlinkSync(outside, backupsDir, process.platform === "win32" ? "junction" : "dir");
    const vault = manager();
    await createVault(vault);
    expect(await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), () => {})).toEqual({ status: "unknown", remaining: [] });
    expect(fs.readFileSync(file)).toEqual(original);
    expect(fs.readdirSync(outside)).toEqual(["dokan-2020-01-01.db"]);
    vault.close();
  });

  // Windows file symlinks require a privilege unavailable on the local runner.
  // The junction/root case above runs on Windows; CI exercises this file race.
  it.skipIf(process.platform === "win32")("refuses a backup replaced by a symlink after inventory inspection", async () => {
    const backupsDir = path.join(dir, "backups");
    fs.mkdirSync(backupsDir);
    const outside = path.join(dir, "outside.db");
    const db = new Database(outside, { create: true });
    db.exec("CREATE TABLE t(a TEXT); PRAGMA user_version = 1");
    db.close();
    const original = fs.readFileSync(outside);
    const candidate = path.join(backupsDir, "dokan-2020-01-01.db.partial.123.abcdef012345");
    fs.copyFileSync(outside, candidate);
    const vault = manager();
    await createVault(vault);
    const open = fs.promises.open.bind(fs.promises);
    const fault = spyOn(fs.promises, "open").mockImplementation(async (file, ...args) => {
      const handle = await open(file, ...args);
      if (String(file) === candidate) {
        fs.unlinkSync(candidate);
        fs.symlinkSync(outside, candidate, "file");
      }
      return handle;
    });
    try {
      expect(await classifyPlaintextCleanup(() => vault.cleanupLegacyPlaintext(), () => {})).toEqual({ status: "remaining", remaining: [candidate] });
      expect(fs.readFileSync(outside)).toEqual(original);
      expect(fs.lstatSync(candidate).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(`${candidate}.dknvbak`)).toBe(false);
    } finally {
      fault.mockRestore();
      vault.close();
    }
  });

  itHeavy("reports a plaintext backup it could not encrypt (never silently succeeds)", async () => {
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

  itHeavy("resumes a setup only after its snapshot exists and only with its passphrase (findings 3 + round-4 security)", async () => {
    const vault = manager();
    const { recoveryKey } = await vault.prepareSetup(PASSPHRASE);
    // the first request is still bootstrapping: no snapshot on disk yet
    await expect(vault.resumeSetup(PASSPHRASE)).rejects.toThrow(VaultSetupInProgressError);
    expect(vault.pendingRecoveryKey()).toBe(recoveryKey);
    // once the bootstrap finished and the snapshot is written, a WRONG
    // passphrase is refused and the pending slot (with its recovery key) stays
    // reserved
    fs.writeFileSync(vault.snapshotPath, "placeholder-snapshot");
    vault.finishSetupBootstrap();
    await expect(vault.resumeSetup("a totally different passphrase")).rejects.toThrow(VaultAuthenticationError);
    expect(vault.pendingRecoveryKey()).toBe(recoveryKey);
    // the original passphrase resumes and releases the token
    const session = await vault.resumeSetup(PASSPHRASE);
    expect(vault.sessionMatches(session.token)).toBe(true);
    expect(vault.pendingRecoveryKey()).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "vault", "vault.json"))).toBe(true);
  });

  itHeavy("never resumes while the first bootstrap is running, even with a snapshot on disk (round-7 finding 1)", async () => {
    const vault = manager();
    await vault.prepareSetup(PASSPHRASE);
    // the snapshot is written mid-bootstrap; the app is NOT ready yet
    fs.writeFileSync(vault.snapshotPath, "placeholder-snapshot");
    await expect(vault.resumeSetup(PASSPHRASE)).rejects.toThrow(VaultSetupInProgressError);
    expect(vault.pendingRecoveryKey()).toBeDefined();
    expect(fs.existsSync(path.join(dir, "vault", "vault.json"))).toBe(false);
    // a failed bootstrap drops the pending key, so a fresh setup is retryable
    vault.abortSetup();
    await expect(vault.prepareSetup(PASSPHRASE)).resolves.toBeDefined();
    vault.abortSetup();
  });

  itHeavy("never reads a whole backup file during the sweep (round-4 performance)", async () => {
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

  itHeavy("checks legacy database existence with stat, never a full read (round-7 finding 7)", () => {
    const legacyPath = path.join(dir, "dokan.db");
    // a large file: a readFile-based existence check would block and allocate it
    fs.writeFileSync(legacyPath, Buffer.alloc(4 * 1024 * 1024, 7));
    const vault = manager();
    const readSpy = spyOn(fs, "readFileSync");
    try {
      const status = vault.status();
      expect(status.legacyDatabase).toBe(true);
      // the header read is fine; the legacy database must never be read whole
      expect(readSpy.mock.calls.map(([file]) => String(file))).not.toContain(legacyPath);
    } finally {
      readSpy.mockRestore();
    }
  });
});
