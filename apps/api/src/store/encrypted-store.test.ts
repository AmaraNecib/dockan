import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEncryptedConnection, readLegacyDatabaseImage } from "../db/encrypted-connection";
import { CURRENT_SCHEMA_VERSION, readSchemaVersion } from "../lib/schema-version";
import { VaultManager } from "../lib/vault/manager";
import { AppLogger } from "../lib/logger";
import type { KdfParams } from "../lib/vault/crypto";
import { createDrizzleStore } from "./drizzle-store";

/**
 * The whole point of the vault store: a phase-1 plaintext database migrates
 * into an encrypted snapshot with the schema version preserved, the store
 * keeps working on the in-memory image, and a reopen (fresh process) sees the
 * data because every committed unit lands in the snapshot.
 */

const FAST_KDF: KdfParams = { algorithm: "argon2id", memoryKiB: 64, iterations: 1, parallelism: 1, keyLength: 32 };

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-vault-store-"));
});

/**
 * Write the plaintext phase-1 database from a separate process (the real
 * upgrade path: the old build exits, the universal build starts). Same-process
 * reopening on Windows can keep a SQLite file handle alive, which is a test
 * artifact, not a migration bug.
 */
function createLegacyInstallOutsideProcess(dataDir: string): void {
  const script = `
    import { createAppConfig } from "./src/config";
    import { openConnection } from "./src/db/connection";
    import { createDrizzleStore } from "./src/store/drizzle-store";
    const dir = ${JSON.stringify(dataDir)};
    const config = createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dir + "/dokan.db" });
    const conn = openConnection(config);
    const store = createDrizzleStore(conn);
    await store.setup();
    await store.createCategory({ name: "زينة" });
    conn.close();
  `;
  const result = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`legacy install fixture failed: ${result.stderr.toString()}`);
}

afterEach(() => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      Bun.sleepSync(50);
    }
  }
});

describe("vault-mode store", () => {
  it("migrates a plaintext database, preserves the schema version, and survives a reopen", async () => {
    // 1. a phase-1 install writes plaintext (separate process fixture)
    createLegacyInstallOutsideProcess(dir);
    const legacyPath = path.join(dir, "dokan.db");
    expect(fs.existsSync(legacyPath)).toBe(true);

    // 2. first vault setup migrates the image
    const vault = new VaultManager({
      dataDir: dir,
      legacyDbPath: legacyPath,
      logger: new AppLogger(dir),
      kdf: FAST_KDF,
    });
    const { recoveryKey } = await vault.prepareSetup("correct horse");
    expect(recoveryKey).toMatch(/[A-Z2-7]/);
    const { image, schemaVersion } = readLegacyDatabaseImage(legacyPath);
    expect(schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const conn = createEncryptedConnection({
      vaultId: vault.metadata().vaultId,
      masterKey: vault.setupMasterKey(),
      snapshotPath: vault.snapshotPath,
      seedBytes: image,
    });
    const store = createDrizzleStore(conn);
    await store.setup();
    await vault.commitSetup();
    conn.close();

    // 3. the snapshot is the only database file; reopening reads the migrated data
    expect(fs.existsSync(vault.snapshotPath)).toBe(true);
    const reopened = createEncryptedConnection({
      vaultId: vault.metadata().vaultId,
      masterKey: vault.requireMasterKey(),
      snapshotPath: vault.snapshotPath,
    });
    // SAFETY: PRAGMA user_version returns exactly one integer column row
    expect(readSchemaVersion(reopened.raw)).toBe(CURRENT_SCHEMA_VERSION);
    const reopenedStore = createDrizzleStore(reopened);
    const categories = await reopenedStore.listCategories();
    expect(categories.some((category) => category.name === "زينة")).toBe(true);
    reopened.close();
  });

  it("persists store mutations into the snapshot without an explicit flush", async () => {
    const vault = new VaultManager({
      dataDir: dir,
      legacyDbPath: path.join(dir, "nonexistent.db"),
      logger: new AppLogger(dir),
      kdf: FAST_KDF,
    });
    const { vaultId } = await vault.prepareSetup("correct horse");
    const masterKey = vault.setupMasterKey();
    const conn = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: vault.snapshotPath,
    });
    const store = createDrizzleStore(conn);
    await store.setup();
    await store.createCategory({ name: "إطارات" });
    // no close(), no flush(): the mutating-call hook must have persisted already
    const reopened = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: vault.snapshotPath,
    });
    const reopenedStore = createDrizzleStore(reopened);
    expect((await reopenedStore.listCategories()).some((category) => category.name === "إطارات")).toBe(true);
    reopened.close();
    conn.close();
  });
});
