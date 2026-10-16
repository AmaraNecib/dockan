import { afterEach, beforeEach, describe, expect } from "bun:test";
import { itHeavy } from "../test-support/heavy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEncryptedConnection, readLegacyDatabaseImage, SnapshotPersistenceError } from "../db/encrypted-connection";
import { openVaultStore } from "../db/vault-store";
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
const PASSPHRASE = "correct horse battery";

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

type FreshVault = {
  vault: VaultManager;
  vaultId: string;
  conn: ReturnType<typeof createEncryptedConnection>;
  store: ReturnType<typeof createDrizzleStore>;
};

/** The same bootstrap path main.ts uses; no test-local store construction. */
async function freshVault(): Promise<FreshVault> {
  const vault = new VaultManager({ dataDir: dir, legacyDbPath: path.join(dir, "dokan.db"), logger: new AppLogger(dir), kdf: FAST_KDF });
  const { vaultId } = await vault.prepareSetup(PASSPHRASE);
  await vault.commitSetup();
  const { conn, store } = openVaultStore({
    vaultId,
    masterKey: vault.requireMasterKey(),
    snapshotPath: vault.snapshotPath,
    headerPath: vault.headerPath,
    fresh: true,
  });
  await store.setup();
  return { vault, vaultId, conn, store };
}

describe("vault-mode store", () => {
  itHeavy("migrates a plaintext database, preserves the schema version, and survives a reopen", async () => {
    // 1. a phase-1 install writes plaintext (separate process fixture)
    createLegacyInstallOutsideProcess(dir);
    const legacyPath = path.join(dir, "dokan.db");
    expect(fs.existsSync(legacyPath)).toBe(true);

    // 2. first vault setup migrates the image through the same helper main uses
    const vault = new VaultManager({
      dataDir: dir,
      legacyDbPath: legacyPath,
      logger: new AppLogger(dir),
      kdf: FAST_KDF,
    });
    const { vaultId, recoveryKey } = await vault.prepareSetup(PASSPHRASE);
    expect(recoveryKey).toMatch(/[A-Z2-7]/);
    const { image, schemaVersion } = readLegacyDatabaseImage(legacyPath);
    expect(schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const { conn, store } = openVaultStore({
      vaultId,
      masterKey: vault.setupMasterKey(),
      snapshotPath: vault.snapshotPath,
      headerPath: vault.headerPath,
      fresh: true,
      seedBytes: image,
    });
    await store.setup();
    await vault.commitSetup();
    await conn.close();

    // 3. the snapshot is the only database file; reopening reads the migrated data
    expect(fs.existsSync(vault.snapshotPath)).toBe(true);
    const reopened = createEncryptedConnection({
      vaultId: vault.metadata().vaultId,
      masterKey: vault.requireMasterKey(),
      snapshotPath: vault.snapshotPath,
    });
    // SAFETY: PRAGMA user_version returns exactly one integer column row
    expect(readSchemaVersion(reopened.raw)).toBe(CURRENT_SCHEMA_VERSION);
    expect((await createDrizzleStore(reopened).listCategories()).some((category) => category.name === "زينة")).toBe(true);
    await reopened.close();
  });

  itHeavy("persists store mutations into the snapshot without an explicit flush and leaves no plaintext database", async () => {
    const { vault, conn, store } = await freshVault();
    await store.createCategory({ name: "إطارات" });
    // no close(), no flush(): the mutating-call hook must have persisted already
    const snapshot = fs.readFileSync(conn.dbPath);
    expect(snapshot.subarray(0, 8).toString("ascii")).toBe("DKNVAULT");
    // the probe scans the WHOLE container for several plaintext markers, not
    // one substring: schema names, a seeded value, and a settings key
    for (const marker of ["hello", "categories", "CREATE TABLE", "adminUserId", "إطارات"]) {
      expect(snapshot.includes(Buffer.from(marker))).toBe(false);
    }
    // and no WAL/sidecar ever appears beside the snapshot
    expect(fs.existsSync(`${conn.dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${conn.dbPath}-shm`)).toBe(false);

    const reopened = createEncryptedConnection({
      vaultId: vault.metadata().vaultId,
      masterKey: vault.requireMasterKey(),
      snapshotPath: vault.snapshotPath,
    });
    expect((await createDrizzleStore(reopened).listCategories()).some((category) => category.name === "إطارات")).toBe(true);
    await reopened.close();
    await conn.close();
  });

  itHeavy("keeps checkpoint() out of an open store transaction (real seam, not a hand-set flag)", async () => {
    const { vault, conn, store } = await freshVault();
    await store.createCategory({ name: "before" });
    const before = fs.readFileSync(conn.dbPath);

    await store.withTransaction(async (tx) => {
      await tx.createCategory({ name: "uncommitted" });
      // the shutdown/backup checkpoint runs mid-unit: it must not capture the
      // uncommitted row
      conn.checkpoint();
      expect(fs.readFileSync(conn.dbPath).equals(before)).toBe(true);
    });

    // after COMMIT the unit is durable and both rows are present
    await conn.close();
    const reopened = createEncryptedConnection({
      vaultId: vault.metadata().vaultId,
      masterKey: vault.requireMasterKey(),
      snapshotPath: vault.snapshotPath,
    });
    const names = (await createDrizzleStore(reopened).listCategories()).map((category) => category.name);
    expect(names).toContain("before");
    expect(names).toContain("uncommitted");
    await reopened.close();
  });

  itHeavy("fails stop (typed error + hook) when a committed direct write cannot be snapshotted", async () => {
    const { vault, conn, store } = await freshVault();
    const fatal: Error[] = [];
    conn.onFatalError = (error) => fatal.push(error);

    // block the snapshot write: the destination becomes a directory
    fs.rmSync(conn.dbPath, { force: true });
    fs.mkdirSync(conn.dbPath);
    await expect(store.createCategory({ name: "kept" })).rejects.toThrow(SnapshotPersistenceError);
    expect(fatal).toHaveLength(1);
    // the SQLite row committed: it must still be there (no rollback after commit)
    expect((await store.listCategories()).some((category) => category.name === "kept")).toBe(true);

    // free the path; the next mutating call flushes the dirty image exactly once
    fs.rmdirSync(conn.dbPath);
    await store.createCategory({ name: "second" });
    await conn.close();
    const reopened = createEncryptedConnection({
      vaultId: vault.metadata().vaultId,
      masterKey: vault.requireMasterKey(),
      snapshotPath: vault.snapshotPath,
    });
    const names = (await createDrizzleStore(reopened).listCategories()).map((category) => category.name);
    expect(names.filter((name) => name === "kept")).toHaveLength(1);
    expect(names).toContain("second");
    await reopened.close();
  });

  itHeavy("never reports a committed transaction as failed without the hook firing", async () => {
    const { vault, conn, store } = await freshVault();
    const fatal: Error[] = [];
    conn.onFatalError = (error) => fatal.push(error);
    fs.rmSync(conn.dbPath, { force: true });
    fs.mkdirSync(conn.dbPath);
    await expect(
      store.withTransaction(async (tx) => {
        await tx.createCategory({ name: "committed" });
      }),
    ).rejects.toThrow(SnapshotPersistenceError);
    expect(fatal).toHaveLength(1);
    expect((await store.listCategories()).some((category) => category.name === "committed")).toBe(true);
    fs.rmdirSync(conn.dbPath);
    await conn.flush();
    await conn.close();
    const reopened = createEncryptedConnection({
      vaultId: vault.metadata().vaultId,
      masterKey: vault.requireMasterKey(),
      snapshotPath: vault.snapshotPath,
    });
    expect((await createDrizzleStore(reopened).listCategories()).some((category) => category.name === "committed")).toBe(true);
    await reopened.close();
  });

  itHeavy("does not release the store queue before a direct write is durable (finding: deferred snapshot)", async () => {
    const { conn, store } = await freshVault();
    // widen the write window so a pre-fix queue release would be observable
    const realSerialize = conn.raw.serialize.bind(conn.raw);
    let serializeCalls = 0;
    conn.raw.serialize = () => {
      serializeCalls += 1;
      Bun.sleepSync(30);
      return realSerialize();
    };

    const first = store.createCategory({ name: "first" });
    let callsWhenReadDone = -1;
    const read = store.listCategories().then((rows) => {
      callsWhenReadDone = serializeCalls;
      return rows;
    });
    await Promise.all([first, read]);
    // with the write inside the queue slot, the read cannot start before the
    // snapshot covering "first" was written; the old wrapper could report
    // success while the snapshot write was still pending
    expect(callsWhenReadDone).toBeGreaterThanOrEqual(1);
    await conn.close();
  });

  itHeavy("close() awaits an in-flight persist before releasing the handle", async () => {
    const { conn, store } = await freshVault();
    const realSerialize = conn.raw.serialize.bind(conn.raw);
    conn.raw.serialize = () => {
      Bun.sleepSync(50);
      return realSerialize();
    };
    await store.createCategory({ name: "slow" });
    let persisted = false;
    conn.markDirty();
    const inFlight = conn.persistIfDirty().then(() => {
      persisted = true;
    });
    await conn.close();
    await inFlight;
    expect(persisted).toBe(true);
  });
});
