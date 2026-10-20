import { afterEach, beforeEach, describe, expect } from "bun:test";
import { itHeavy } from "../test-support/heavy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEncryptedConnection, readLegacyDatabaseImage, SnapshotPersistenceError } from "../db/encrypted-connection";
import { snapshotFailurePolicy } from "../db/snapshot-failure-policy";
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

  itHeavy("a deferred flush first read in flight when close() lands never serializes the released handle (#291)", async () => {
    const { vault, conn, store } = await freshVault();
    await store.createCategory({ name: "before" });
    // The raw handle's own close() is the instant the database stops being
    // usable, so that is what the measurement below is anchored to: a serialize
    // AFTER it ran on a released handle, which is the CI failure this pins.
    const realSerialize = conn.raw.serialize.bind(conn.raw);
    const realClose = conn.raw.close.bind(conn.raw);
    let released = false;
    let serializedAfterRelease = 0;
    conn.raw.serialize = () => {
      if (released) serializedAfterRelease += 1;
      return realSerialize();
    };
    conn.raw.close = () => {
      released = true;
      realClose();
    };

    // The deferral under test: the flush is requested and its opening currency
    // read is still in flight (no await between the two calls), so close() can
    // only wait for it if the job was chained onto the queue on request.
    conn.markDirty();
    let flushFailure: Error | undefined;
    // The rejection is captured rather than awaited, so close() below still
    // lands while this flush is parked
    const deferred = conn.persistIfDirty().catch((error: Error) => {
      flushFailure = error;
    });
    await conn.close();
    await deferred;

    // Two halves, asserted together so a failure reports both: the flush must
    // not throw "Can't do this on a closed database", and it must not serialize
    // a handle the store already released.
    expect({ flushFailure, serializedAfterRelease }).toEqual({ flushFailure: undefined, serializedAfterRelease: 0 });

    // and nothing was lost by refusing: close()'s checkpoint is the current image
    const reopened = createEncryptedConnection({
      vaultId: vault.metadata().vaultId,
      masterKey: vault.requireMasterKey(),
      snapshotPath: vault.snapshotPath,
    });
    expect((await createDrizzleStore(reopened).listCategories()).some((category) => category.name === "before")).toBe(true);
    await reopened.close();
  });

  itHeavy("a flush requested after close() writes nothing instead of throwing from a closed handle (#291)", async () => {
    const { conn } = await freshVault();
    await conn.close();
    const durable = fs.readFileSync(conn.dbPath);
    // a store call that lands during shutdown still marks the image dirty, so
    // the flush below reaches the serializer instead of being skipped as current
    conn.markDirty();
    // the flush is refused quietly (an ordinary event while the process goes
    // down), and the direct persist says what happened: the unit was DROPPED,
    // not written — as a throw carrying the reason, because a resolved persist
    // is the promise that the image is on disk
    await expect(conn.flush()).resolves.toBeUndefined();
    await expect(conn.persistIfDirty()).rejects.toThrow(SnapshotPersistenceError);
    await expect(conn.persistIfDirty()).rejects.toMatchObject({ reason: "dropped" });
    // nothing was written for the closed connection
    expect(fs.readFileSync(conn.dbPath).equals(durable)).toBe(true);
  });

  itHeavy("a dropped snapshot fails stop like a write that could not land (#291)", async () => {
    const { conn, store } = await freshVault();
    await store.setup();
    const fatal: Error[] = [];
    // The same connection, with a persist that reports the drop a closed
    // connection reports: the unit committed, the snapshot did not. The
    // connection's own refusal is not enough — the store is the thing that
    // reports success to the client, so the store is where the verdict has to
    // be acted on.
    const dropping = {
      ...conn,
      onFatalError: (error: Error) => fatal.push(error),
      // the connection's own refusal, in the shape it now has: a throw that
      // carries the reason, not a resolved "dropped" the store has to rebuild
      // into an error it does not own (#309)
      persistIfDirty: async () => {
        throw new SnapshotPersistenceError(new Error(snapshotFailurePolicy("dropped").sentence), "dropped");
      },
    };
    // What the store says about the drop comes from the policy, not from a copy
    // here (#305): the code is the one the reason carries, so a unit that was
    // never written is not filed as a failed write. Before the policy existed
    // this row was SNAPSHOT_PERSIST_FAILED with the reason only in the text.
    const rows: { event: string; message: string }[] = [];
    const dropStore = createDrizzleStore(dropping, {
      warn: (event, message) => rows.push({ event, message }),
      error: (event, message) => rows.push({ event, message }),
    });

    await expect(dropStore.createCategory({ name: "dropped" })).rejects.toThrow(SnapshotPersistenceError);
    // fail-stop, exactly like a write that could not land: the client must
    // not be told a committed sale was saved
    expect(fatal).toHaveLength(1);
    // the row is filed under the drop code, and its words are the policy's —
    // the sentence half proves the wiring (a hand-written copy here would drift
    // from the table that pins the meaning)
    expect(rows.map((row) => row.event)).toContain("SNAPSHOT_PERSIST_DROPPED");
    expect(rows.some((row) => row.message.includes(snapshotFailurePolicy("dropped").sentence))).toBe(true);
    // and the row is committed: the unit is lost, not undone
    expect((await dropStore.listCategories()).some((category) => category.name === "dropped")).toBe(true);
  });
});
