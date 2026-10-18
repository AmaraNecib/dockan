import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { itHeavy } from "../../test-support/heavy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEncryptedConnection } from "../../db/encrypted-connection";
import type { KdfParams } from "./crypto";
import { createVaultBackupBundle, extractVaultBackup, type ExtractVaultBackupOptions, readVaultBackupBundle } from "./backup";
import { VaultCore } from "./core";
import { VAULT_SNAPSHOT_MAGIC, VAULT_SNAPSHOT_VERSION } from "./format";
import { acquireVaultLock, VaultAlreadyLockedError, VaultLockLostError } from "./lock";
import { VaultManager } from "./manager";
import { AppLogger } from "../logger";
import { createDrizzleStore } from "../../store/drizzle-store";

const FAST_KDF: KdfParams = { algorithm: "argon2id", memoryKiB: 64, iterations: 1, parallelism: 1, keyLength: 32 };
const PASSPHRASE = "correct horse battery";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        Bun.sleepSync(50);
      }
    }
  }
});

function fakeSnapshot(): Buffer {
  return Buffer.concat([VAULT_SNAPSHOT_MAGIC, Buffer.from([VAULT_SNAPSHOT_VERSION]), Buffer.alloc(40, 9)]);
}

async function headerText(): Promise<string> {
  const memory = { text: "" };
  await VaultCore.create(
    {
      read: () => undefined,
      write: async (text) => {
        memory.text = text;
      },
    },
    PASSPHRASE,
    { kdf: FAST_KDF },
  );
  return memory.text;
}

describe("vault backup bundle", () => {
  it("round-trips the header and the snapshot", async () => {
    const header = await headerText();
    const snapshot = fakeSnapshot();
    const bundle = createVaultBackupBundle(header, snapshot);
    const decoded = readVaultBackupBundle(bundle);
    expect(decoded).toBeDefined();
    expect(decoded?.headerText).toBe(header);
    expect(decoded?.snapshot.equals(snapshot)).toBe(true);
  });

  it("returns undefined for raw snapshots, truncated bundles, and garbage", async () => {
    const header = await headerText();
    const bundle = createVaultBackupBundle(header, fakeSnapshot());
    expect(readVaultBackupBundle(fakeSnapshot())).toBeUndefined();
    // cut below the smallest possible envelope (magic+version+nonce+tag)
    expect(readVaultBackupBundle(bundle.subarray(0, bundle.length - 20))).toBeUndefined();
    // cut inside the header: the declared length no longer fits
    expect(readVaultBackupBundle(bundle.subarray(0, 12))).toBeUndefined();
    expect(readVaultBackupBundle(Buffer.from("DKNVBACK\u0001\u0000"))).toBeUndefined();
    expect(readVaultBackupBundle(Buffer.alloc(0))).toBeUndefined();
  });

  it("extracts a bundle into a restorable data dir and refuses a non-bundle", async () => {
    const header = await headerText();
    const bundle = createVaultBackupBundle(header, fakeSnapshot());
    const target = tempDir("dokan-backup-extract-");
    const paths = await extractVaultBackup(bundle, target);
    expect(fs.existsSync(paths.headerPath)).toBe(true);
    expect(fs.existsSync(paths.snapshotPath)).toBe(true);
    await expect(extractVaultBackup(Buffer.from("nope"), tempDir("dokan-backup-bad-"))).rejects.toThrow();
  });

  itHeavy("exports a self-contained backup that restores the shop on a fresh install (finding: unlockable backups)", async () => {
    const source = tempDir("dokan-backup-src-");
    const sourceManager = new VaultManager({
      dataDir: source,
      legacyDbPath: path.join(source, "dokan.db"),
      logger: new AppLogger(source),
      kdf: FAST_KDF,
    });
    const { recoveryKey, vaultId } = await sourceManager.prepareSetup(PASSPHRASE);
    const conn = createEncryptedConnection({
      vaultId,
      masterKey: sourceManager.setupMasterKey(),
      snapshotPath: sourceManager.snapshotPath,
      headerPath: sourceManager.headerPath,
      fresh: true,
    });
    const store = createDrizzleStore(conn);
    await store.setup();
    await store.createCategory({ name: "رحلة" });
    await sourceManager.commitSetup();

    // the exported backup is ONE file; the key wraps travel with the snapshot
    const bundlePath = path.join(source, "backup.dknvbak");
    await store.copyDatabaseTo(bundlePath);
    expect(conn.validateSnapshotFile(bundlePath)).toBe(true);
    const bundle = fs.readFileSync(bundlePath);
    expect(readVaultBackupBundle(bundle)).toBeDefined();
    conn.close();

    // restore on a "fresh machine" and unlock with the PASSPHRASE
    const restoredDir = tempDir("dokan-backup-dst-");
    await extractVaultBackup(bundle, restoredDir);
    const restored = new VaultManager({
      dataDir: restoredDir,
      legacyDbPath: path.join(restoredDir, "dokan.db"),
      logger: new AppLogger(restoredDir),
      kdf: FAST_KDF,
    });
    await restored.unlock(PASSPHRASE);
    const restoredConn = createEncryptedConnection({
      vaultId: restored.metadata().vaultId,
      masterKey: restored.requireMasterKey(),
      snapshotPath: restored.snapshotPath,
    });
    const restoredStore = createDrizzleStore(restoredConn);
    expect((await restoredStore.listCategories()).some((category) => category.name === "رحلة")).toBe(true);
    restoredConn.close();
    restored.close();

    // ... and with the RECOVERY key, which also traveled in the bundle
    const recoveredDir = tempDir("dokan-backup-recovery-");
    await extractVaultBackup(bundle, recoveredDir);
    const recovered = new VaultManager({
      dataDir: recoveredDir,
      legacyDbPath: path.join(recoveredDir, "dokan.db"),
      logger: new AppLogger(recoveredDir),
      kdf: FAST_KDF,
    });
    await recovered.unlockRecovery(recoveryKey);
    expect(recovered.unlocked).toBe(true);
    recovered.close();
  });
});

/** A lock record on disk, as another instance or a crashed one would leave it. */
function writeLockRecord(
  dir: string,
  overrides: Partial<{ pid: number; host: string; startedAt: string; heartbeatAt: string; token: string }> = {},
): void {
  fs.writeFileSync(
    path.join(dir, "vault.lock"),
    JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      token: "other-owner",
      ...overrides,
    }),
  );
}

/**
 * Restore while a second instance replaces `vault.lock` at the instant the
 * snapshot lands. The steal point is the snapshot's own rename, so this
 * interleave is deterministic instead of a race.
 */
async function restoreWhileLockIsStolen(
  target: string,
  options: ExtractVaultBackupOptions = {},
): Promise<{ error: Error | undefined; losses: string[]; stolen: boolean }> {
  const bundle = createVaultBackupBundle(await headerText(), fakeSnapshot());
  const losses: string[] = [];
  const original = fs.promises.rename;
  let stolen = false;
  const spy = spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
    if (!stolen && String(to).endsWith("dokan.db.enc")) {
      stolen = true;
      writeLockRecord(target, { token: "thief" });
    }
    return original(from, to);
  });
  try {
    await extractVaultBackup(bundle, target, {
      onLockLost: (reason, holder) => {
        losses.push(holder === undefined ? reason : `${reason} (taken by ${holder.host} pid ${holder.pid})`);
        options.onLockLost?.(reason, holder);
      },
    });
    return { error: undefined, losses, stolen };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)), losses, stolen };
  } finally {
    spy.mockRestore();
  }
}

/**
 * Issue #282: the restore writes `dokan.db.enc` and the header, so it takes the
 * folder's single-writer lock the way every other write path does. These tests
 * fail if that guard is removed (the refusal test then restores successfully).
 */
describe("vault backup restore takes the data folder's lock", () => {
  it("refuses while another instance holds the folder, and writes nothing", async () => {
    const header = await headerText();
    const bundle = createVaultBackupBundle(header, fakeSnapshot());
    const target = tempDir("dokan-backup-held-");
    const holder = acquireVaultLock(target);
    try {
      await expect(extractVaultBackup(bundle, target)).rejects.toThrow(VaultAlreadyLockedError);
    } finally {
      holder.release();
    }
    expect(fs.existsSync(path.join(target, "dokan.db.enc"))).toBe(false);
    expect(fs.existsSync(path.join(target, "vault"))).toBe(false);
  });

  it("refuses a live holder whose heartbeat is stale instead of stealing the folder", async () => {
    // the PID wins over the heartbeat on the local host (lock.test.ts): a quiet
    // holder is never stolen from, so the restore refuses instead
    const header = await headerText();
    const bundle = createVaultBackupBundle(header, fakeSnapshot());
    const target = tempDir("dokan-backup-quiet-holder-");
    writeLockRecord(target, { heartbeatAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    await expect(extractVaultBackup(bundle, target)).rejects.toThrow(VaultAlreadyLockedError);
  });

  it("restores over a dead holder's stale lock, which the next boot would reclaim too", async () => {
    const header = await headerText();
    const bundle = createVaultBackupBundle(header, fakeSnapshot());
    const target = tempDir("dokan-backup-dead-holder-");
    // a lock left by a process that is gone (the crashed-instance restore)
    const child = Bun.spawn(["bun", "-e", ""], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    writeLockRecord(target, { pid: child.pid });
    const paths = await extractVaultBackup(bundle, target);
    expect(fs.existsSync(paths.snapshotPath)).toBe(true);
    expect(fs.existsSync(paths.headerPath)).toBe(true);
  });

  it("releases the folder lock, so the instance the caller boots next can take it", async () => {
    const header = await headerText();
    const bundle = createVaultBackupBundle(header, fakeSnapshot());
    const target = tempDir("dokan-backup-release-");
    await extractVaultBackup(bundle, target);
    expect(fs.existsSync(path.join(target, "vault.lock"))).toBe(false);
    // a leftover lock would make this throw
    const next = acquireVaultLock(target);
    next.release();
  });

  it("releases the folder lock when a write fails, and does not lock a bundle it cannot decode", async () => {    const header = await headerText();
    const bundle = createVaultBackupBundle(header, fakeSnapshot());
    const target = tempDir("dokan-backup-failed-");
    // a directory where the snapshot belongs makes the atomic rename fail
    fs.mkdirSync(path.join(target, "dokan.db.enc"), { recursive: true });
    await expect(extractVaultBackup(bundle, target)).rejects.toThrow();
    expect(fs.existsSync(path.join(target, "vault.lock"))).toBe(false);
    const next = acquireVaultLock(target);
    next.release();

    // decode runs before the lock is taken, so garbage never locks the folder
    const garbageTarget = tempDir("dokan-backup-garbage-");
    await expect(extractVaultBackup(Buffer.from("nope"), garbageTarget)).rejects.toThrow();
    expect(fs.existsSync(path.join(garbageTarget, "vault.lock"))).toBe(false);
  });

  it("fails the restore with an error, never a process exit, when the lock is stolen mid-restore", async () => {
    const target = tempDir("dokan-backup-theft-");
    const { error, losses, stolen } = await restoreWhileLockIsStolen(target);
    expect(stolen).toBe(true);
    expect(error).toBeInstanceOf(VaultLockLostError);
    expect(losses.length).toBe(1);
    expect(losses[0]).toMatch(/lock/i);
    // the header never landed, and the new owner's record is left alone
    expect(fs.existsSync(path.join(target, "vault", "vault.json"))).toBe(false);
    expect(fs.existsSync(path.join(target, "vault.lock"))).toBe(true);
  });

  it("still fails with VaultLockLostError when the caller's onLockLost handler throws", async () => {
    const target = tempDir("dokan-backup-theft-throw-");
    const { error, losses } = await restoreWhileLockIsStolen(target, {
      onLockLost: () => {
        throw new Error("handler boom");
      },
    });
    // the hook saw the loss, and its throw is neither the failure the caller
    // sees nor an uncaught exception out of the lock's heartbeat timer
    expect(losses.length).toBe(1);
    expect(error).toBeInstanceOf(VaultLockLostError);
    expect(error?.message).not.toContain("handler boom");
  });
});
