import { afterEach, describe, expect, it } from "bun:test";
import { itHeavy } from "../../test-support/heavy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEncryptedConnection } from "../../db/encrypted-connection";
import type { KdfParams } from "./crypto";
import { createVaultBackupBundle, extractVaultBackup, readVaultBackupBundle } from "./backup";
import { VaultCore } from "./core";
import { VAULT_SNAPSHOT_MAGIC, VAULT_SNAPSHOT_VERSION } from "./format";
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
