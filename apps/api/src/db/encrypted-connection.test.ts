import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setHeavyDefaultTimeout } from "../test-support/heavy";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MissingVaultDatabaseError, SnapshotPersistenceError, VaultCorruptionError, createEncryptedConnection, readLegacyDatabaseImage } from "./encrypted-connection";

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
