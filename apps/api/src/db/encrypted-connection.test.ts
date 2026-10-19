import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setHeavyDefaultTimeout } from "../test-support/heavy";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MissingVaultDatabaseError, SnapshotPersistenceError, VaultCorruptionError, buildEncryptedSnapshot, createEncryptedConnection, readLegacyDatabaseImage } from "./encrypted-connection";
import { VAULT_SNAPSHOT_LEGACY_VERSION, VAULT_SNAPSHOT_MAGIC, VAULT_SNAPSHOT_VERSION, readSnapshotFence } from "../lib/vault/format";

// Every test opens an encrypted connection and writes a snapshot.
setHeavyDefaultTimeout();

let dir: string;
const vaultId = "11111111-2222-3333-4444-555555555555";
const masterKey = Buffer.alloc(32, 7);
const otherKey = Buffer.alloc(32, 8);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-encrypted-conn-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const snapshotPath = () => path.join(dir, "dokan.db.enc");

/** Fresh (first-run) connection shorthand; unlocks must pass fresh: false. */
function freshConnection(key: Uint8Array = masterKey) {
  return createEncryptedConnection({ vaultId, masterKey: key, snapshotPath: snapshotPath(), fresh: true });
}

describe("encrypted connection", () => {
  it("persists an encrypted snapshot and reopens it with the master key", async () => {
    const first = freshConnection();
    first.raw.exec("CREATE TABLE t(a TEXT)");
    first.raw.exec("INSERT INTO t VALUES ('hello')");
    first.markDirty();
    await first.persistIfDirty();
    first.close();

    const file = fs.readFileSync(snapshotPath());
    expect(file.subarray(0, 8).toString("ascii")).toBe("DKNVAULT");
    // the plaintext table name must not appear in the container
    expect(file.includes(Buffer.from("hello"))).toBe(false);

    const reopened = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() });
    // SAFETY: the test created the table with a single TEXT column
    expect(reopened.raw.query("SELECT a FROM t").all()).toEqual([{ a: "hello" }]);
    reopened.close();
  });

  it("preserves PRAGMA user_version across a snapshot round trip", async () => {
    const first = freshConnection();
    first.raw.exec("CREATE TABLE t(a TEXT)");
    first.raw.exec("PRAGMA user_version = 7");
    first.markDirty();
    await first.persistIfDirty();
    first.close();

    const reopened = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() });
    // SAFETY: PRAGMA user_version always returns one object with the integer column user_version
    const row = reopened.raw.query("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(7);
    reopened.close();
  });

  it("refuses a snapshot opened with the wrong master key", async () => {
    const first = freshConnection();
    first.raw.exec("CREATE TABLE t(a TEXT)");
    first.markDirty();
    await first.persistIfDirty();
    await first.close();
    // the connection only ever runs after the header authenticated the key, so
    // a failed open here is corruption, not a wrong passphrase
    expect(() => createEncryptedConnection({ vaultId, masterKey: otherKey, snapshotPath: snapshotPath() })).toThrow(
      VaultCorruptionError,
    );
  });

  it("treats an AAD-swapped snapshot (another vault id, same key) as corruption", async () => {
    const first = freshConnection();
    first.raw.exec("CREATE TABLE t(a TEXT)");
    first.markDirty();
    await first.persistIfDirty();
    await first.close();
    expect(() =>
      createEncryptedConnection({ vaultId: "99999999-0000-0000-0000-000000000000", masterKey, snapshotPath: snapshotPath() }),
    ).toThrow(VaultCorruptionError);
  });

  it("owns its key: zeroing the caller's buffer cannot corrupt later snapshots (finding: zero-key seal)", async () => {
    const callerKey = Buffer.from(masterKey);
    const conn = createEncryptedConnection({ vaultId, masterKey: callerKey, snapshotPath: snapshotPath(), fresh: true });
    // the manager zeroes the buffer it handed over on a re-unlock/close
    callerKey.fill(0);
    conn.raw.exec("CREATE TABLE t(a TEXT)");
    conn.raw.exec("INSERT INTO t VALUES ('survives')");
    conn.markDirty();
    await conn.persistIfDirty();
    await conn.close();

    // the snapshot must decrypt with the REAL key, and must NOT decrypt as if
    // it had been sealed with the zeroed buffer
    const reopened = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() });
    // SAFETY: the test created the table with a single TEXT column
    expect(reopened.raw.query("SELECT a FROM t").all()).toEqual([{ a: "survives" }]);
    await reopened.close();
    expect(() => createEncryptedConnection({ vaultId, masterKey: Buffer.alloc(32, 0), snapshotPath: snapshotPath() })).toThrow(
      VaultCorruptionError,
    );
  });

  it("removes a stale temp partial left by a crashed writer", async () => {
    const partial = path.join(dir, ".dokan.db.enc.tmp-999-deadbeef");
    fs.writeFileSync(partial, "half a snapshot");
    const conn = freshConnection();
    expect(fs.existsSync(partial)).toBe(false);
    await conn.close();
  });

  it("refuses an unlock when the encrypted database file is missing (never fabricates an empty shop)", () => {
    // no snapshot exists and this is not a first-run connection
    expect(() => createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() })).toThrow(MissingVaultDatabaseError);
    // and the refusal must not create an empty snapshot either
    expect(fs.existsSync(snapshotPath())).toBe(false);
  });

  it("does not persist while a transaction unit is open", async () => {
    const conn = freshConnection();
    conn.raw.exec("CREATE TABLE t(a TEXT)");
    conn.markDirty();
    await conn.persistIfDirty();
    expect(fs.existsSync(snapshotPath())).toBe(true);
    const before = fs.readFileSync(snapshotPath());

    // checkpoint() (shutdown/backup path) must not capture uncommitted pages
    conn.raw.exec("BEGIN");
    conn.inTransaction = true;
    conn.raw.exec("INSERT INTO t VALUES ('uncommitted')");
    conn.markDirty();
    conn.checkpoint();
    expect(fs.readFileSync(snapshotPath()).equals(before)).toBe(true);
    conn.raw.exec("ROLLBACK");
    conn.inTransaction = false;

    // the committed image still opens
    conn.close();
    const reopened = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() });
    // SAFETY: the test created the table with a single TEXT column
    expect(reopened.raw.query("SELECT a FROM t").all()).toEqual([]);
    reopened.close();
  });

  it("keeps the change dirty after a failed write and persists it on the retry", async () => {
    const conn = freshConnection();
    conn.raw.exec("CREATE TABLE t(a TEXT)");
    conn.markDirty();
    await conn.persistIfDirty();

    // block the write: the snapshot path becomes a directory, so the atomic
    // rename can never succeed
    fs.rmSync(snapshotPath(), { force: true });
    fs.mkdirSync(snapshotPath());
    conn.raw.exec("INSERT INTO t VALUES ('retried')");
    conn.markDirty();
    await expect(conn.persistIfDirty()).rejects.toThrow(SnapshotPersistenceError);

    // a failed write must not be recorded as saved: with the path freed the
    // same dirty change writes now, without another markDirty()
    fs.rmdirSync(snapshotPath());
    await conn.persistIfDirty();
    conn.close();

    const reopened = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() });
    // SAFETY: the test created the table with a single TEXT column
    expect(reopened.raw.query("SELECT a FROM t").all()).toEqual([{ a: "retried" }]);
    reopened.close();
  });

  it("overwrites an orphan snapshot on a fresh setup instead of failing auth", async () => {
    const first = freshConnection();
    first.raw.exec("CREATE TABLE orphan(a)");
    first.markDirty();
    await first.persistIfDirty();
    first.close();

    // a crash between the first flush and the header commit leaves this image
    // with no owner; the retry must start from an empty database
    const retry = createEncryptedConnection({ vaultId, masterKey: otherKey, snapshotPath: snapshotPath(), fresh: true });
    expect(retry.raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
    retry.close();
  });

  it("validates a good snapshot and rejects a corrupt one", async () => {
    const conn = freshConnection();
    conn.raw.exec("CREATE TABLE t(a TEXT)");
    conn.markDirty();
    await conn.persistIfDirty();
    expect(conn.validateSnapshotFile(snapshotPath())).toBe(true);
    const corrupt = path.join(dir, "corrupt.enc");
    fs.writeFileSync(corrupt, Buffer.from("not a snapshot"));
    expect(conn.validateSnapshotFile(corrupt)).toBe(false);
    conn.close();
  });

  it("adopts seed bytes (legacy migration) without touching the snapshot", () => {
    const seed = new Database(":memory:");
    seed.exec("CREATE TABLE legacy(a TEXT); INSERT INTO legacy VALUES ('kept')");
    seed.exec("PRAGMA user_version = 3");
    const bytes = seed.serialize();
    seed.close();

    const conn = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), seedBytes: bytes });
    // SAFETY: the seed created one table with a single TEXT column
    expect(conn.raw.query("SELECT a FROM legacy").all()).toEqual([{ a: "kept" }]);
    // SAFETY: PRAGMA user_version always returns one integer column row
    expect((conn.raw.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
    conn.close();
  });
});

describe("snapshot write guard (ADR-0012 clause 3)", () => {
  /** Stands in for VaultLockLostError: the connection only sees a throw. */
  class GuardRefusedError extends Error {}

  it("refuses after a post-write guard failure and never marks the version durable", async () => {
    let guardCalls = 0;
    let failPostWrite = true;
    const conn = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      fresh: true,
      writeGuard: () => {
        guardCalls += 1;
        // odd call = before the write, even = after it landed
        if (failPostWrite && guardCalls % 2 === 0) throw new GuardRefusedError("the lock was lost mid-write");
      },
    });
    conn.raw.exec("CREATE TABLE t(a TEXT)");
    conn.markDirty();

    await expect(conn.persistIfDirty()).rejects.toThrow(GuardRefusedError);
    // the bytes landed (the guard ran after the write), but the version must
    // not be durable
    expect(fs.existsSync(snapshotPath())).toBe(true);
    expect(guardCalls).toBe(2);

    // a later persist with no new mutation still has work to do: if
    // persistedVersion had advanced, this would return without a write
    failPostWrite = false;
    await conn.persistIfDirty();
    expect(guardCalls).toBeGreaterThan(2);
    conn.close();
  });

  it("refuses a checkpoint whose guard fails and leaves the snapshot untouched", () => {
    let refuse = false;
    const conn = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      fresh: true,
      writeGuard: () => {
        if (refuse) throw new GuardRefusedError("the lock was lost");
      },
    });
    conn.raw.exec("CREATE TABLE t(a TEXT)");
    conn.markDirty();
    conn.checkpoint();
    const before = fs.readFileSync(snapshotPath());

    refuse = true;
    conn.raw.exec("INSERT INTO t VALUES ('sale')");
    conn.markDirty();
    expect(() => conn.checkpoint()).toThrow(GuardRefusedError);
    expect(fs.readFileSync(snapshotPath())).toEqual(before);

    // cleanup: the shutdown path never reaches here when the lock is lost
    refuse = false;
    conn.close();
  });
});

describe("snapshot fence (#280)", () => {
  const tokenA = "a".repeat(32);
  const tokenB = "b".repeat(32);

  /** A serialized SQLite image with one table, for building a zombie's envelope. */
  function serializedImage(rows: string[]): Buffer {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(a TEXT)");
    for (const row of rows) db.exec(`INSERT INTO t VALUES ('${row}')`);
    const image = db.serialize();
    db.close();
    return image;
  }

  const diskFence = () => readSnapshotFence(fs.readFileSync(snapshotPath()));

  it("stamps the writing holder's token into the envelope it writes", async () => {
    const conn = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenA });
    conn.raw.exec("CREATE TABLE t(a TEXT)");
    conn.markDirty();
    await conn.persistIfDirty();

    const fence = diskFence();
    expect(fence?.version).toBe(VAULT_SNAPSHOT_VERSION);
    expect(fence?.stamp).toBe(tokenA);
    await conn.close();
  });

  it("does not rewrite when the envelope already carries this holder's stamp", async () => {
    const first = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenA });
    first.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
    first.markDirty();
    await first.persistIfDirty();
    await first.close();
    const written = fs.readFileSync(snapshotPath());

    // the same holder opens the vault again: the stamp on disk is its own, so no
    // rewrite is owed. A rewrite would be visible, because the nonce is random.
    const again = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), writeStamp: () => tokenA });
    await again.persistIfDirty();
    expect(fs.readFileSync(snapshotPath()).equals(written)).toBe(true);
    await again.close();
  });

  it("detects a former holder's snapshot with no timestamp comparison, and rewrites it", async () => {
    const former = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenA });
    former.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('shared')");
    former.markDirty();
    await former.persistIfDirty();
    await former.close();
    expect(diskFence()?.stamp).toBe(tokenA);

    // the current holder is given no clock: the stamp alone says these bytes are
    // not its own, so its version is not durable and it rewrites
    const current = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), writeStamp: () => tokenB });
    await current.persistIfDirty();
    expect(diskFence()?.version).toBe(VAULT_SNAPSHOT_VERSION);
    expect(diskFence()?.stamp).toBe(tokenB);
    await current.close();
  });

  it("treats a foreign-stamped snapshot on disk as version-not-durable and rewrites it", async () => {
    const conn = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenB });
    conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
    conn.markDirty();
    await conn.persistIfDirty();

    // a zombie overwrites the file after our verified write: our version is no
    // longer what disk holds, even though nothing is dirty in memory
    fs.writeFileSync(snapshotPath(), buildEncryptedSnapshot(masterKey, vaultId, serializedImage(["zombie"]), tokenA));
    await conn.persistIfDirty();
    expect(diskFence()?.stamp).toBe(tokenB);
    await conn.close();

    const reopened = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() });
    // SAFETY: the test created the table with a single TEXT column
    expect(reopened.raw.query("SELECT a FROM t").all()).toEqual([{ a: "mine" }]);
    reopened.close();
  });

  it("falsification: a rename inside the write window is detected, not reported durable", async () => {
    const zombieEnvelope = buildEncryptedSnapshot(masterKey, vaultId, serializedImage(["zombie"]), tokenA);
    let guardCalls = 0;
    let zombieRenamed = false;
    const conn = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      fresh: true,
      writeStamp: () => tokenB,
      writeGuard: () => {
        guardCalls += 1;
        // the post-write guard runs after our rename and before durability is
        // recorded: the exact instant a zombie's in-flight rename lands
        if (guardCalls % 2 === 0 && !zombieRenamed) {
          zombieRenamed = true;
          fs.writeFileSync(snapshotPath(), zombieEnvelope);
        }
      },
    });
    conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
    conn.markDirty();
    await conn.persistIfDirty();

    expect(zombieRenamed).toBe(true);
    expect(diskFence()?.stamp).toBe(tokenB);
    await conn.close();

    const reopened = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() });
    // SAFETY: the test created the table with a single TEXT column
    expect(reopened.raw.query("SELECT a FROM t").all()).toEqual([{ a: "mine" }]);
    reopened.close();
  });

  it("reads the legacy envelope and rewrites it fenced on the next write", async () => {
    const released = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true });
    released.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('legacy')");
    released.markDirty();
    await released.persistIfDirty();
    await released.close();
    expect(diskFence()?.version).toBe(VAULT_SNAPSHOT_LEGACY_VERSION);
    expect(diskFence()?.stamp).toBeUndefined();

    const current = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), writeStamp: () => tokenB });
    // SAFETY: the test created the table with a single TEXT column
    expect(current.raw.query("SELECT a FROM t").all()).toEqual([{ a: "legacy" }]);
    await current.persistIfDirty();
    expect(diskFence()?.version).toBe(VAULT_SNAPSHOT_VERSION);
    expect(diskFence()?.stamp).toBe(tokenB);
    await current.close();
  });

  it("binds the stamp into the AAD, so a swapped stamp fails decryption", async () => {
    const conn = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenA });
    conn.raw.exec("CREATE TABLE t(a TEXT)");
    conn.markDirty();
    await conn.persistIfDirty();
    await conn.close();

    // the first byte of the stamp (magic + version + length byte)
    const bytes = fs.readFileSync(snapshotPath());
    const stampByte = VAULT_SNAPSHOT_MAGIC.length + 2;
    bytes[stampByte] = bytes[stampByte] === 0x61 ? 0x62 : 0x61;
    fs.writeFileSync(snapshotPath(), bytes);

    expect(() => createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() })).toThrow(VaultCorruptionError);
  });
});

describe("legacy database image", () => {
  it("reads a WAL-mode database into a deserialisable image and preserves the schema version", () => {
    const legacy = path.join(dir, "dokan.db");
    const db = new Database(legacy, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("CREATE TABLE items(id TEXT); INSERT INTO items VALUES ('one')");
    db.exec("PRAGMA user_version = 1");
    // leave a hot-ish WAL by writing after the initial sync
    db.exec("INSERT INTO items VALUES ('two')");
    db.close();

    const { image, schemaVersion } = readLegacyDatabaseImage(legacy);
    expect(schemaVersion).toBe(1);
    const reopened = Database.deserialize(image);
    // SAFETY: the fixture created one table with a single TEXT column
    expect(reopened.query("SELECT id FROM items ORDER BY id").all()).toEqual([{ id: "one" }, { id: "two" }]);
    // SAFETY: PRAGMA user_version returns exactly one integer column row
    expect((reopened.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    reopened.close();
  });
});
