import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { setHeavyDefaultTimeout } from "../test-support/heavy";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MissingVaultDatabaseError, SnapshotPersistenceError, VaultCorruptionError, buildEncryptedSnapshot, createEncryptedConnection, readLegacyDatabaseImage } from "./encrypted-connection";
import { MAX_SNAPSHOT_STAMP_BYTES, VAULT_SNAPSHOT_LEGACY_VERSION, VAULT_SNAPSHOT_MAGIC, VAULT_SNAPSHOT_VERSION, readSnapshotFence } from "../lib/vault/format";

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

/** Stands in for VaultLockLostError: the connection only sees a throw. */
class GuardRefusedError extends Error {}

describe("snapshot write guard (ADR-0012 clause 3)", () => {

  it("refuses at the rename step, leaves the snapshot untouched, and never marks the version durable", async () => {
    let guardCalls = 0;
    let refuseAt = 0;
    const conn = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      fresh: true,
      writeGuard: () => {
        guardCalls += 1;
        // the guard is asked three times per attempt: before the write, before
        // the rename, and after it
        if (guardCalls === refuseAt) throw new GuardRefusedError("the lock was lost mid-write");
      },
    });
    conn.raw.exec("CREATE TABLE t(a TEXT)");
    conn.markDirty();
    // the first write lands, so there ARE bytes on disk worth protecting
    await conn.persistIfDirty();
    const durable = fs.readFileSync(snapshotPath());

    conn.raw.exec("INSERT INTO t VALUES ('second')");
    conn.markDirty();
    // the call right before the rename of the next attempt
    refuseAt = guardCalls + 2;
    await expect(conn.persistIfDirty()).rejects.toThrow(GuardRefusedError);
    // the rename never happened, so the bytes on disk are still the first
    // write's. This is the point of asking the guard again right before the
    // rename: a refusal must not overwrite what the folder's new owner wrote
    expect(fs.readFileSync(snapshotPath()).equals(durable)).toBe(true);
    conn.close();
  });

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
        // the third call of the first attempt is the one AFTER the rename
        if (failPostWrite && guardCalls === 3) throw new GuardRefusedError("the lock was lost mid-write");
      },
    });
    conn.raw.exec("CREATE TABLE t(a TEXT)");
    conn.markDirty();

    await expect(conn.persistIfDirty()).rejects.toThrow(GuardRefusedError);
    // the bytes landed (the guard ran after the rename), but the version must
    // not be durable
    expect(fs.existsSync(snapshotPath())).toBe(true);
    expect(guardCalls).toBe(3);

    // a later persist with no new mutation still has work to do: if
    // persistedVersion had advanced, this would return without a write
    failPostWrite = false;
    await conn.persistIfDirty();
    expect(guardCalls).toBeGreaterThan(3);
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

  /**
   * A zombie's write, in the shape a real one has: a temp file renamed over the
   * snapshot. A truncating `writeFileSync` is not what the race produces — the
   * production writer renames atomically — so an injection that truncates can
   * hide a window that a real rename opens.
   */
  function renameZombieEnvelope(envelope: Buffer, rename: typeof fs.renameSync = fs.renameSync.bind(fs)): void {
    const temp = path.join(dir, `.dokan.db.enc.tmp-zombie-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.writeFileSync(temp, envelope);
    // the caller passes the real rename when renameSync is itself spied on, so
    // the zombie's write cannot recurse into the spy
    rename(temp, snapshotPath());
  }

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

  it("does not rewrite when nothing is dirty, the fence is ours and the file is there", async () => {
    // This is an ANTI-ALWAYS-REWRITE guard, not a fence detector: `persistIfDirty`
    // at the base already returned early when `mutationVersion ===
    // persistedVersion`, so this test passes against the pre-#280
    // implementation too. It is kept — a rewrite per call would thrash a
    // multi-megabyte file — and it is named for what it actually pins. The
    // fence half is pinned by "repairs a foreign snapshot at checkpoint even
    // when nothing changed" and by the overwrite-war test, both of which red
    // when the fence is ignored.
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

    // the stamp alone is not enough: a fence-repair that re-sealed an EMPTY
    // image would satisfy every assertion above and silently drop the former
    // holder's row. The rewrite must carry the data it read.
    const reopened = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() });
    // SAFETY: the test created the table with a single TEXT column
    expect(reopened.raw.query("SELECT a FROM t").all()).toEqual([{ a: "shared" }]);
    reopened.close();
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
        // The guard is asked THREE times per attempt — before the temp write,
        // before the rename, and after it. The zombie must land on the third,
        // the one that runs after OUR rename and before durability is recorded.
        // Injecting on the second (before the rename) put the zombie's bytes on
        // disk first, our rename overwrote them, and the post-write fence read
        // saw only our stamp: the test passed with detection and repair both
        // removed. On the third call the zombie's bytes are the last thing
        // written, so the only way this test can pass is a re-read that rejects
        // the fence and a retry that rewrites our image (#291 review).
        if (guardCalls === 3 && !zombieRenamed) {
          zombieRenamed = true;
          renameZombieEnvelope(zombieEnvelope);
        }
      },
    });
    conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
    conn.markDirty();
    await conn.persistIfDirty();

    expect(zombieRenamed).toBe(true);
    // the first attempt wrote, then the fence said the resulting file was not
    // ours; the stamp and the row below are what a second, repaired attempt
    // leaves. Drop the post-write verdict (treat the write as durable) and both
    // assertions see the zombie's envelope instead.
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

    // The whole stamp field is swapped for another holder's, and the sealed
    // body is left byte-identical. That is the only shape in which the AAD can
    // be the explanation: a single flipped byte inside the sealed body fails
    // the GCM tag on its own, so a test that flips one byte proves only that
    // "a corrupted byte is refused", which was true before the fence existed.
    const before = fs.readFileSync(snapshotPath());
    const fence = readSnapshotFence(before);
    expect(fence?.version).toBe(VAULT_SNAPSHOT_VERSION);
    expect(fence?.stamp).toBe(tokenA);
    const bodyOffset = fence?.bodyOffset ?? 0;
    const after = Buffer.from(before);
    Buffer.from(tokenB, "utf8").copy(after, VAULT_SNAPSHOT_MAGIC.length + 2);
    expect(after.subarray(bodyOffset)).toEqual(before.subarray(bodyOffset));
    fs.writeFileSync(snapshotPath(), after);

    expect(() => createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() })).toThrow(VaultCorruptionError);
  });

  it("surfaces at open the snapshot it cannot verify, instead of deciding silently", async () => {
    const former = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenA });
    former.raw.exec("CREATE TABLE t(a TEXT)");
    former.markDirty();
    await former.persistIfDirty();
    await former.close();

    // A former holder's bytes: the stamp is readable, it is simply not ours.
    // This is what every ordinary restart leaves behind, so it is reported as
    // information rather than as an incident — a warn on every boot trains the
    // owner to ignore the one row that would matter.
    const foreignEvents: string[] = [];
    const current = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      writeStamp: () => tokenB,
      logger: {
        warn: (event) => foreignEvents.push(`warn:${event}`),
        info: (event) => foreignEvents.push(`info:${event}`),
      },
    });
    expect(foreignEvents).toEqual(["info:VAULT_SNAPSHOT_FENCE_FOREIGN"]);
    await current.close();

    // The legacy envelope carries no stamp at all, and its currency is just as
    // unverifiable: it must not go quiet merely because it is the documented
    // upgrade path. It is also not "foreign" — no other writer wrote it, this
    // vault simply has not been written since the upgrade — so it gets its own
    // code, and the diagnostics filter can tell the two apart.
    fs.writeFileSync(snapshotPath(), buildEncryptedSnapshot(masterKey, vaultId, serializedImage([])));
    const legacyEvents: string[] = [];
    const upgraded = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      writeStamp: () => tokenB,
      logger: {
        warn: (event) => legacyEvents.push(`warn:${event}`),
        info: (event) => legacyEvents.push(`info:${event}`),
      },
    });
    expect(legacyEvents).toEqual(["info:VAULT_SNAPSHOT_FENCE_UNSTAMPED"]);
    await upgraded.close();
  });

  it("falsification: a rename in the checkpoint window is refused, never recorded durable", async () => {
    const zombieEnvelope = buildEncryptedSnapshot(masterKey, vaultId, serializedImage(["zombie"]), tokenA);
    const conn = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenB });
    conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
    conn.markDirty();

    // The synchronous path has one guard before its write and none after it, so
    // the injection goes where the window is: inside the atomic write, after its
    // rename and before the fence re-read.
    const realRename = fs.renameSync.bind(fs);
    let injected = 0;
    // SAFETY: the spy is typed with fs.renameSync's own PathLike overload, and
    // production passes exactly those two arguments
    const spy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      realRename(from, to);
      if (String(to) === snapshotPath()) {
        injected += 1;
        // the zombie's own write is a rename, not a truncation: the window
        // under test is two renames racing, and only a rename reproduces it.
        // The real rename is passed because renameSync is what is being spied
        // on, so the zombie's write must not recurse into the spy.
        renameZombieEnvelope(zombieEnvelope, realRename);
      }
    }) as typeof fs.renameSync);
    let refused: unknown;
    try {
      conn.checkpoint();
    } catch (error) {
      refused = error;
    } finally {
      spy.mockRestore();
    }

    expect(injected).toBe(1);
    expect(refused).toBeInstanceOf(SnapshotPersistenceError);
    // the sync path cannot redo a write, so it refuses and the zombie's bytes
    // stand. What must not happen is the version it just wrote being recorded
    // durable while disk holds someone else's envelope.
    expect(diskFence()?.stamp).toBe(tokenA);

    // nothing was marked durable, so the next write repairs the fence with no
    // further mutation
    await conn.persistIfDirty();
    expect(diskFence()?.stamp).toBe(tokenB);
    await conn.close();

    const reopened = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() });
    // SAFETY: the test created the table with a single TEXT column
    expect(reopened.raw.query("SELECT a FROM t").all()).toEqual([{ a: "mine" }]);
    reopened.close();
  });

  it("gives up after three attempts when every write is overwritten (overwrite war)", async () => {
    const zombieEnvelope = buildEncryptedSnapshot(masterKey, vaultId, serializedImage(["zombie"]), tokenA);
    let guardCalls = 0;
    let atWar = true;
    const conn = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      fresh: true,
      writeStamp: () => tokenB,
      writeGuard: () => {
        guardCalls += 1;
        // the guard is asked three times per attempt — before the write, before
        // the rename, and after it — so the zombie lands on the third call:
        // the one that runs AFTER this holder's rename, replacing the version
        // the holder just wrote
        if (atWar && guardCalls % 3 === 0) renameZombieEnvelope(zombieEnvelope);
      },
    });
    conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
    conn.markDirty();

    await expect(conn.persistIfDirty()).rejects.toThrow(SnapshotPersistenceError);
    // the count is a private shape (two guard calls per attempt), so it is a
    // comment rather than an assertion: the outcome — the failure, the fence
    // left foreign, and the version still dirty — is what the design promises.
    // three attempts, each with a guard before the write, before the rename
    // and after it
    expect(guardCalls).toBe(9);
    expect(diskFence()?.stamp).toBe(tokenA);

    // Nothing was recorded durable. The pin: the war ends, and a snapshot
    // carrying THIS holder's stamp is put on disk by hand — the state a
    // successful write leaves behind. The in-memory version is still dirty, so
    // the next persist must still write. If `persistedVersion` had advanced in
    // the failure branch, `snapshotIsCurrent()` would now be satisfied (the
    // version matches and the fence is ours) and persistIfDirty would return
    // without writing, leaving the hand-made envelope in place.
    atWar = false;
    const handMade = buildEncryptedSnapshot(masterKey, vaultId, serializedImage(["hand"]), tokenB);
    fs.writeFileSync(snapshotPath(), handMade);
    await conn.persistIfDirty();
    expect(fs.readFileSync(snapshotPath()).equals(handMade)).toBe(false);
    expect(diskFence()?.stamp).toBe(tokenB);
    await conn.close();

    const reopened = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() });
    // SAFETY: the test created the table with a single TEXT column
    expect(reopened.raw.query("SELECT a FROM t").all()).toEqual([{ a: "mine" }]);
    reopened.close();
  });

  it("treats a vanished snapshot as unverifiable, names it, and rewrites", async () => {
    const conn = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenB });
    conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
    conn.markDirty();
    await conn.persistIfDirty();
    expect(diskFence()?.stamp).toBe(tokenB);

    // The file is deleted under an open connection. Nothing is dirty, so the
    // version bookkeeping alone would call the snapshot current; and if
    // "absent" were read as "mine", the deleted file would be believed
    // durable and the data would be gone with no log line anywhere.
    fs.rmSync(snapshotPath());
    await conn.persistIfDirty();

    expect(fs.existsSync(snapshotPath())).toBe(true);
    expect(diskFence()?.stamp).toBe(tokenB);
    await conn.close();

    const reopened = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() });
    // SAFETY: the test created the table with a single TEXT column
    expect(reopened.raw.query("SELECT a FROM t").all()).toEqual([{ a: "mine" }]);
    reopened.close();
  });

  it("treats bytes this build cannot parse as unverifiable and overwrites them", async () => {
    const conn = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenB });
    conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
    conn.markDirty();
    await conn.persistIfDirty();
    const bytes = Buffer.concat([VAULT_SNAPSHOT_MAGIC, Buffer.from([99]), Buffer.alloc(64, 3)]);

    // A newer build's envelope: the same bytes are REFUSED at open, so
    // believing them durable here would be the one place the two disagree —
    // the version would be recorded over a file this build cannot read, and the
    // next unlock dies on it.
    fs.rmSync(snapshotPath(), { force: true });
    fs.writeFileSync(snapshotPath(), bytes);
    expect(() => createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() })).toThrow(VaultCorruptionError);

    await conn.persistIfDirty();
    expect(diskFence()?.stamp).toBe(tokenB);
    await conn.close();

    const reopened = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() });
    // SAFETY: the test created the table with a single TEXT column
    expect(reopened.raw.query("SELECT a FROM t").all()).toEqual([{ a: "mine" }]);
    reopened.close();
  });

  it("refuses a holder stamp that cannot survive the envelope's UTF-8 round trip", () => {
    // A lone surrogate does not survive the UTF-8 round trip the envelope does.
    // The writer would seal under one AEAD context and every reader would
    // derive another, so the vault could never be opened again — a brick with
    // no symptom until the next unlock. Refused at open, where the cause is
    // still visible.
    expect(() =>
      createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => "\uD800" }),
    ).toThrow("not text that survives a UTF-8 round trip");
    expect(fs.existsSync(snapshotPath())).toBe(false);
  });

  it("refuses an empty or oversized holder stamp, and accepts the bound itself", async () => {
    const refuses = (stamp: string): void => {
      expect(() =>
        createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => stamp }),
      ).toThrow(`must be 1..${MAX_SNAPSHOT_STAMP_BYTES} bytes`);
    };
    refuses("");
    refuses("x".repeat(MAX_SNAPSHOT_STAMP_BYTES + 1));

    // the bound is inclusive, and a 64-byte stamp is written and read back
    const atBound = "y".repeat(MAX_SNAPSHOT_STAMP_BYTES);
    const conn = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => atBound });
    conn.raw.exec("CREATE TABLE t(a TEXT)");
    conn.markDirty();
    await conn.persistIfDirty();
    expect(diskFence()?.stamp).toBe(atBound);
    await conn.close();
    const reopened = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), writeStamp: () => atBound });
    expect(reopened.raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([{ name: "t" }]);
    reopened.close();
  });

  it("absorbs a transient EBUSY inside one check: no warning, no rewrite", async () => {
    const first = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenA });
    first.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
    first.markDirty();
    await first.persistIfDirty();
    await first.close();
    const written = fs.readFileSync(snapshotPath());

    // The snapshot path refuses to open for the first 10 ms and then behaves.
    // The designed transient case: ONE refusal is absorbed inside the check,
    // so the healthy, correctly stamped file survives untouched — a rewrite is
    // visible, because the nonce is random — and nothing is warned about.
    //
    // The window is measured from the first attempt, not from the start of the
    // test: the connection reads and decrypts the whole snapshot before it
    // asks the fence anything, and that takes longer than the window.
    // SAFETY: the fence reader (`lib/vault/fence.ts`) is the only code that opens the
    // snapshot path, and it passes exactly (path, "r"); the narrowed signature
    // names that one call so the spy can delegate to the real open
    const realOpenSync = fs.openSync.bind(fs) as (file: fs.PathLike, flags: string | number) => number;
    let firstAttempt = 0;
    let refusals = 0;
    // SAFETY: the spy keeps fs.openSync's own overload type; the narrowed
    // parameters are the (path, flags) overload production calls
    const spy = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: string | number) => {
      if (String(file) === snapshotPath()) {
        if (firstAttempt === 0) firstAttempt = Date.now();
        if (Date.now() - firstAttempt < 10) {
          refusals += 1;
          throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
        }
      }
      return realOpenSync(file, flags);
    }) as typeof fs.openSync);
    const events: string[] = [];
    let again: ReturnType<typeof createEncryptedConnection> | undefined;
    try {
      again = createEncryptedConnection({
        vaultId,
        masterKey,
        snapshotPath: snapshotPath(),
        writeStamp: () => tokenA,
        logger: { warn: (event) => events.push(event) },
      });
      await again.persistIfDirty();
      expect(fs.readFileSync(snapshotPath()).equals(written)).toBe(true);
    } finally {
      // the key copy and the SQLite handle are released even when an assertion
      // above throws: a connection created inside a try must be closed inside
      // the finally that owns it
      await again?.close();
      spy.mockRestore();
    }
    // exactly one refusal, absorbed inside the check, and nothing warned
    expect(refusals).toBe(1);
    expect(events).toEqual([]);
  });

  it("asks the fence exactly twice before a check gives up", async () => {
    const first = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenA });
    first.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
    first.markDirty();
    await first.persistIfDirty();
    await first.close();
    const written = fs.readFileSync(snapshotPath());

    // The bound is part of the contract: one retry absorbs a transient EBUSY,
    // and a decidable fence cannot change by asking again, so a check asks
    // exactly twice. Two refusals, then the file behaves: the first check
    // gives up (and says so), the next one gets a good answer. The first
    // successful read is therefore the THIRD attempt — with a bound of one it
    // would be the second, and with a bound of five it would be the sixth.
    // SAFETY: the fence reader (`lib/vault/fence.ts`) is the only code that opens the
    // snapshot path, and it passes exactly (path, "r"); the narrowed signature
    // names that one call so the spy can delegate to the real open
    const realOpenSync = fs.openSync.bind(fs) as (file: fs.PathLike, flags: string | number) => number;
    let attempts = 0;
    let refusals = 0;
    let firstSuccess = 0;
    // SAFETY: the spy keeps fs.openSync's own overload type; the narrowed
    // parameters are the (path, flags) overload production calls
    const spy = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: string | number) => {
      if (String(file) === snapshotPath()) {
        attempts += 1;
        if (attempts <= 2) {
          refusals += 1;
          throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
        }
        if (firstSuccess === 0) firstSuccess = attempts;
      }
      return realOpenSync(file, flags);
    }) as typeof fs.openSync);
    const events: string[] = [];
    try {
      const again = createEncryptedConnection({
        vaultId,
        masterKey,
        snapshotPath: snapshotPath(),
        writeStamp: () => tokenA,
        logger: { warn: (event) => events.push(event) },
      });
      await again.persistIfDirty();
      expect(fs.readFileSync(snapshotPath()).equals(written)).toBe(true);
      await again.close();
    } finally {
      spy.mockRestore();
    }
    // the first check spent both of its attempts and gave up; the next one
    // got a good answer, so the first successful read is the THIRD attempt
    expect(refusals).toBe(2);
    expect(firstSuccess).toBe(3);
    expect(events).toEqual(["VAULT_SNAPSHOT_FENCE_UNREADABLE"]);
  });

  it("writes without dying when the fence never reads, and says so", async () => {
    const first = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenA });
    first.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
    first.markDirty();
    await first.persistIfDirty();
    await first.close();

    // SAFETY: the fence reader (`lib/vault/fence.ts`) is the only code that opens the
    // snapshot path, and it passes exactly (path, "r"); the narrowed signature
    // names that one call so the spy can delegate to the real open
    const realOpenSync = fs.openSync.bind(fs) as (file: fs.PathLike, flags: string | number) => number;
    // SAFETY: the spy keeps fs.openSync's own overload type; the narrowed
    // parameters are the (path, flags) overload production calls
    const spy = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: string | number) => {
      if (String(file) === snapshotPath()) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      return realOpenSync(file, flags);
    }) as typeof fs.openSync);
    const events: string[] = [];
    let again: ReturnType<typeof createEncryptedConnection> | undefined;
    try {
      again = createEncryptedConnection({
        vaultId,
        masterKey,
        snapshotPath: snapshotPath(),
        writeStamp: () => tokenA,
        logger: { warn: (event) => events.push(event) },
      });
      // The write is owed (nothing can be shown to be ours) and it happens. It
      // also SUCCEEDS: an unreadable prefix is a read failure, not evidence
      // that another writer took the file — a replacement would have been read
      // and named — so the committed transaction on disk must not be reported
      // as a failed one and the process must not die over it. The version is
      // simply not recorded durable; the next write re-seals it.
      await again.persistIfDirty();
      // a fence read from the bytes, not a byte-inequality check: "the file
      // changed" is satisfied by a truncated or corrupt envelope, while the
      // stamp says the envelope that landed is a well-formed fenced one of ours
      expect(diskFence()?.stamp).toBe(tokenA);
      expect(events).toContain("VAULT_SNAPSHOT_FENCE_UNREADABLE");

      // A version counter that never moves cannot witness this: on an
      // unchanged reopen both counters are zero, so recording "durable" in the
      // unreadable branch above is indistinguishable from not recording it. A
      // mutation before the failing read makes the version real, so the branch
      // either leaves it unwritten (this test's claim) or the mutation is
      // believed saved over a file nothing could verify.
      again.raw.exec("UPDATE t SET a = 'mutated'");
      again.markDirty();
      // the fence is unreadable, so this write lands and nothing proves it
      await again.persistIfDirty();

      // and the connection is not left believing a version it never wrote:
      // with the fence readable again, the next persist MUST rewrite, and the
      // rewrite must carry the mutation it was asked to save.
      spy.mockRestore();
      const settled = fs.readFileSync(snapshotPath());
      await again.persistIfDirty();
      expect(fs.readFileSync(snapshotPath()).equals(settled)).toBe(false);
      // and the rewrite carries the mutation: a repair that re-sealed the image
      // it read at open would satisfy the byte check and lose the change
      const preserved = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() });
      // SAFETY: the test created the table with a single TEXT column
      expect(preserved.raw.query("SELECT a FROM t").all()).toEqual([{ a: "mutated" }]);
      preserved.close();
    } finally {
      // the connection and the key copy it owns are released even when an
      // assertion above throws
      await again?.close();
      spy.mockRestore();
    }
  });

  it("refuses to bundle a snapshot that is not this holder's", async () => {
    const conn = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      headerPath: path.join(dir, "vault.json"),
      fresh: true,
      writeStamp: () => tokenB,
    });
    conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
    conn.markDirty();
    await conn.persistIfDirty();
    fs.writeFileSync(path.join(dir, "vault.json"), "{}");

    // A zombie's envelope lands between checkpoint() and the read that fills
    // the bundle. The bundle's own validator cannot see it: it derives the AEAD
    // context from the envelope's stamp, so a foreign-stamped envelope decrypts
    // cleanly and quick_check passes on a coherent-but-stale image. The fence
    // on the bytes ACTUALLY bundled is the only observer that catches it, and
    // today's backup would otherwise silently hold yesterday's transactions.
    const zombie = buildEncryptedSnapshot(masterKey, vaultId, serializedImage(["zombie"]), tokenA);
    // SAFETY: production calls readFileSync with a PathLike and an optional
    // encoding, so the narrowed signature covers every call this spy receives
    const realReadFileSync = fs.readFileSync.bind(fs) as (file: fs.PathLike, options?: string) => Buffer | string;
    // SAFETY: the spy keeps fs.readFileSync's own overload type; the narrowed
    // parameters are the (path, encoding) overload production calls
    const spy = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathLike, options?: string) => {
      if (String(file) === snapshotPath()) return zombie;
      return realReadFileSync(file, options);
    }) as typeof fs.readFileSync);
    try {
      await expect(conn.writeBackupTo(path.join(dir, "today.dknvbak"))).rejects.toThrow(SnapshotPersistenceError);
      expect(fs.existsSync(path.join(dir, "today.dknvbak"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
    await conn.close();
  });

  it("refuses to bundle a fenced snapshot when this connection has no stamp to check it against (#307)", async () => {
    const former = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      headerPath: path.join(dir, "vault.json"),
      fresh: true,
      writeStamp: () => tokenA,
    });
    former.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('former')");
    former.markDirty();
    await former.persistIfDirty();
    await former.close();

    // The old backup check short-circuited on "this connection has no stamp"
    // and called the bytes its own without reading them, while the write path
    // compared them and called them another holder's. One reader says the true
    // thing — the bytes are fenced and this holder has nothing to compare — so
    // the bundle is refused rather than quietly holding an envelope this
    // connection cannot establish as its own version.
    const headerText = "{}";
    fs.writeFileSync(path.join(dir, "vault.json"), headerText);
    const unstamped = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), headerPath: path.join(dir, "vault.json") });
    let refusal: unknown;
    try {
      await unstamped.writeBackupTo(path.join(dir, "today.dknvbak"));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SnapshotPersistenceError);
    // SAFETY: the assertion above established the class, and `reason` is the
    // field this test exists to read
    expect((refusal as SnapshotPersistenceError).reason).toBe("unfenced-holder");
    expect(fs.existsSync(path.join(dir, "today.dknvbak"))).toBe(false);
    await unstamped.close();
  });

  it("documents the backup exception: a bundle holds a v1 envelope, deliberately (#280)", () => {
    // encryptLegacyBackups() calls buildEncryptedSnapshot with no stamp, so the
    // image inside a .dknvbak is a v1 envelope. A backup is never held under the
    // lock, so there is no writer token to bind; the guide says so explicitly.
    // This lives here rather than in `format.test.ts` because it builds a real
    // envelope, which is this module's job, not the parser's.
    const unstamped = buildEncryptedSnapshot(masterKey, vaultId, serializedImage([]));
    const fence = readSnapshotFence(unstamped);
    expect(fence?.version).toBe(VAULT_SNAPSHOT_LEGACY_VERSION);
    expect(fence?.stamp).toBeUndefined();
    // and a stamped write is v2, so the two cannot be confused
    const stamped = buildEncryptedSnapshot(masterKey, vaultId, serializedImage([]), tokenA);
    expect(readSnapshotFence(stamped)?.version).toBe(VAULT_SNAPSHOT_VERSION);
    expect(readSnapshotFence(stamped)?.stamp).toBe(tokenA);
  });

  it("refuses a truncated snapshot at the connection, not only at the parser", async () => {
    const first = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true });
    first.raw.exec("CREATE TABLE t(a TEXT)");
    first.markDirty();
    await first.persistIfDirty();
    await first.close();

    const bytes = fs.readFileSync(snapshotPath());
    // cut the tail off: the envelope still parses as a fence, so the refusal has
    // to come from the decrypt, and it must be corruption rather than a
    // missing-database error (a header exists, so the data is expected)
    fs.writeFileSync(snapshotPath(), bytes.subarray(0, bytes.length - 8));
    expect(() => createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() })).toThrow(VaultCorruptionError);

    // and cut below the fence itself, so the parser is the one that refuses
    fs.writeFileSync(snapshotPath(), bytes.subarray(0, 6));
    expect(() => createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() })).toThrow(VaultCorruptionError);
  });

  it("refuses before the write when the guard fails on the async path", async () => {
    let guardCalls = 0;
    const conn = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      fresh: true,
      writeGuard: () => {
        guardCalls += 1;
        // the pre-write guard refuses: nothing may be written at all
        throw new GuardRefusedError("the lock was lost before the write");
      },
    });
    conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('lost')");
    conn.markDirty();

    await expect(conn.persistIfDirty()).rejects.toThrow(GuardRefusedError);
    // the guard ran once and its throw was never retried, and the snapshot the
    // lock's new owner would have lost was never written
    expect(guardCalls).toBe(1);
    expect(fs.existsSync(snapshotPath())).toBe(false);
  });

  it("serialises overlapping persists and survives a rejected one in the queue", async () => {
    const conn = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenA });
    conn.raw.exec("CREATE TABLE t(a TEXT)");
    conn.markDirty();
    // two overlapping calls: the queue makes them sequential, and the second
    // sees the first's version and has nothing to do
    const first = conn.persistIfDirty();
    const second = conn.persistIfDirty();
    await Promise.all([first, second]);
    expect(diskFence()?.stamp).toBe(tokenA);

    // a REJECTED persist must not poison the queue: a later write still runs
    conn.raw.exec("INSERT INTO t VALUES ('after')");
    conn.markDirty();
    const realSerialize = conn.raw.serialize.bind(conn.raw);
    let boom = true;
    // SAFETY: the spy forwards serialize() unchanged; the narrowed signature is
    // the parameterless overload production calls
    const spy = spyOn(conn.raw, "serialize").mockImplementation((() => {
      if (boom) {
        boom = false;
        throw new Error("serialize failed");
      }
      return realSerialize();
    }) as typeof conn.raw.serialize);
    try {
      await expect(conn.persistIfDirty()).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    await conn.persistIfDirty();
    await conn.close();

    const reopened = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() });
    // SAFETY: the test created the table with a single TEXT column
    expect(reopened.raw.query("SELECT a FROM t").all()).toEqual([{ a: "after" }]);
    reopened.close();
  });

  it("closes the handle after an EARLIER rejected persist, not only after a refusing checkpoint", async () => {
    const conn = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenA });
    conn.raw.exec("CREATE TABLE t(a TEXT)");
    conn.markDirty();
    // SAFETY: the narrowed signature is the parameterless overload production
    // calls; this spy always throws and never falls through to implementation
    const spy = spyOn(conn.raw, "serialize").mockImplementationOnce((() => {
      throw new Error("serialize failed");
    }) as typeof conn.raw.serialize);
    try {
      await expect(conn.persistIfDirty()).rejects.toThrow();
      // the failed write left a rejection on the persist queue; close() awaits
      // the queue, and that awaited rejection must not skip the cleanup
      spy.mockRestore();
      await conn.close();
    } finally {
      spy.mockRestore();
    }
    expect(() => conn.raw.query("SELECT 1").get()).toThrow();
  });

  it("warns, not informs, when the fence CHANGES under a live connection", async () => {
    // The routine case — the previous session's stamp — is information, because
    // every restart produces it. A fence that CHANGES while this connection is
    // open is not routine: it means another process put bytes on the disk this
    // holder is responsible for, and that is the incident the event exists for.
    // Without the distinction the one row that matters is buried in one row per
    // boot.
    const former = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenA });
    former.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('shared')");
    former.markDirty();
    await former.persistIfDirty();
    await former.close();

    const events: string[] = [];
    const current = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      writeStamp: () => tokenB,
      logger: {
        warn: (event) => events.push(`warn:${event}`),
        info: (event) => events.push(`info:${event}`),
      },
    });
    // open: the former holder's bytes, routine
    expect(events).toEqual(["info:VAULT_SNAPSHOT_FENCE_FOREIGN"]);

    // a zombie renames ITS envelope over ours while we are open — a different
    // holder's stamp from the one at open, which is exactly what makes the
    // change observable — and we then act
    const tokenC = "c".repeat(32);
    fs.writeFileSync(snapshotPath(), buildEncryptedSnapshot(masterKey, vaultId, serializedImage(["zombie"]), tokenC));
    await current.persistIfDirty();
    expect(events).toContain("warn:VAULT_SNAPSHOT_FENCE_FOREIGN");
    await current.close();
  });

  it("repairs a foreign snapshot at checkpoint even when nothing changed", async () => {
    const conn = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenB });
    conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
    conn.markDirty();
    await conn.persistIfDirty();
    expect(diskFence()?.stamp).toBe(tokenB);

    // A zombie renames its envelope over our verified write and this holder then
    // goes quiet: mutationVersion equals persistedVersion, so the version
    // bookkeeping alone would let checkpoint() return and leave the zombie's
    // bytes where our data should be. The fenced half of snapshotIsCurrent() is
    // the only reason the shutdown/backup seam repairs them.
    fs.writeFileSync(snapshotPath(), buildEncryptedSnapshot(masterKey, vaultId, serializedImage(["zombie"]), tokenA));
    conn.checkpoint();

    expect(diskFence()?.stamp).toBe(tokenB);
    await conn.close();

    const reopened = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath() });
    // SAFETY: the test created the table with a single TEXT column
    expect(reopened.raw.query("SELECT a FROM t").all()).toEqual([{ a: "mine" }]);
    reopened.close();
  });

  it("closes the raw handle even when the final checkpoint refuses", async () => {
    const zombieEnvelope = buildEncryptedSnapshot(masterKey, vaultId, serializedImage(["zombie"]), tokenA);
    const conn = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenB });
    conn.raw.exec("CREATE TABLE t(a TEXT)");
    conn.markDirty();

    const realRename = fs.renameSync.bind(fs);
    // SAFETY: the spy is typed with fs.renameSync's own PathLike overload, and
    // production passes exactly those two arguments
    const spy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      realRename(from, to);
      if (String(to) === snapshotPath()) renameZombieEnvelope(zombieEnvelope, realRename);
    }) as typeof fs.renameSync);
    try {
      await expect(conn.close()).rejects.toThrow(SnapshotPersistenceError);
    } finally {
      spy.mockRestore();
    }

    // the refusal is the last thing close() does, and the cleanup ran anyway:
    // the connection's handle is shut, so its memory image cannot be read again
    expect(() => conn.raw.query("SELECT 1").get()).toThrow();
  });

  it("a checkpoint after close writes nothing and does not throw (#291)", async () => {
    const conn = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenA });
    conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('before')");
    conn.markDirty();
    await conn.persistIfDirty();
    await conn.close();
    const durable = fs.readFileSync(snapshotPath());

    // A store call that lands during shutdown still marks the image dirty, so
    // this checkpoint reaches the serializer instead of being skipped as
    // current — the same shape as the flush-after-close test. Without the
    // guard it serializes the released handle: the key has been zeroed and
    // SQLite has been shut, so it throws "Can't do this on a closed database"
    // from a seam whose caller cannot retry (a second close(), a backup
    // requested while the process goes down).
    conn.markDirty();
    expect(() => conn.checkpoint()).not.toThrow();
    expect(fs.readFileSync(snapshotPath()).equals(durable)).toBe(true);

    // and the second close() that runs that checkpoint is not an opaque
    // failure either: it is a no-op, with the bytes from the first one intact
    await expect(conn.close()).resolves.toBeUndefined();
    expect(fs.readFileSync(snapshotPath()).equals(durable)).toBe(true);
  });

  it("reads the fence once per dirty persist and once per clean check", async () => {
    // The design record's cost line is a counted claim, so it is counted here:
    // a dirty image short-circuits the currency question before it reads the
    // fence, so the only read is the post-write one; a clean check reads the
    // fence once to answer it. A third read per dirty persist would be a
    // one-third cost regression nobody would notice otherwise.
    const conn = createEncryptedConnection({ vaultId, masterKey, snapshotPath: snapshotPath(), fresh: true, writeStamp: () => tokenA });
    conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
    conn.markDirty();
    await conn.persistIfDirty();

    // SAFETY: the fence reader (`lib/vault/fence.ts`) is the only code that opens the
    // snapshot path, and it passes exactly (path, "r"); the narrowed signature
    // names that one call so the spy can delegate to the real open
    const realOpenSync = fs.openSync.bind(fs) as (file: fs.PathLike, flags: string | number) => number;
    let reads = 0;
    // SAFETY: the spy keeps fs.openSync's own overload type; the narrowed
    // parameters are the (path, flags) overload production calls
    const spy = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: string | number) => {
      if (String(file) === snapshotPath()) reads += 1;
      return realOpenSync(file, flags);
    }) as typeof fs.openSync);
    try {
      conn.markDirty();
      await conn.persistIfDirty();
      expect(reads).toBe(1);

      reads = 0;
      await conn.persistIfDirty();
      expect(reads).toBe(1);
    } finally {
      spy.mockRestore();
      await conn.close();
    }
  });
});

describe("closed connection and unreadable paths (#291)", () => {
  it("drops a persist that arrives after close(), and names the drop in the log", async () => {
    const events: Array<{ event: string; message: string }> = [];
    const conn = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      fresh: true,
      logger: {
        warn: () => {},
        info: () => {},
        error: (event: string, message: string) => {
          events.push({ event, message });
        },
      },
    });
    conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('before')");
    conn.markDirty();
    await conn.persistIfDirty();
    await conn.close();
    const durable = fs.readFileSync(snapshotPath());

    // a flush after the close is an ordinary event (the process is going
    // down): it is refused quietly, and it must not name a loss that never
    // happened
    await expect(conn.flush()).resolves.toBeUndefined();
    expect(events.filter((entry) => entry.event === "SNAPSHOT_PERSIST_DROPPED")).toHaveLength(0);

    // a unit that arrives after the close: the handle is released and the key
    // is zeroed, so nothing was written and nothing can be
    conn.markDirty();
    await expect(conn.persistIfDirty()).resolves.toBe("dropped");
    expect(fs.readFileSync(snapshotPath()).equals(durable)).toBe(true);

    // the drop is not silent: it is named, once, at error. A committed unit
    // that never reached the snapshot is a real loss, and a caller that only
    // sees a resolved promise reports it as saved
    expect(events.filter((entry) => entry.event === "SNAPSHOT_PERSIST_DROPPED")).toHaveLength(1);
  });

  it("a path that is not a file is ABSENT, not unreadable, so the write is owed and the failure is loud", async () => {
    const events: string[] = [];
    const conn = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      fresh: true,
      // a stamp, so the fence is actually READ: an unfenced connection's fence
      // is trivially its own and the path is never opened
      writeStamp: () => "a".repeat(32),
      logger: {
        warn: (event: string) => {
          events.push(event);
        },
        info: () => {},
      },
    });
    conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
    conn.markDirty();

    // ENOTDIR and EISDIR answer the same question as ENOENT: there is no
    // snapshot file at this path. They are decidable statements about the
    // path, not a transient I/O failure, so the verdict is "absent" — a write
    // is owed — and never "unreadable", which would send the post-write
    // branch down its benign "written, fence unproven" exit over a snapshot
    // that is not there.
    // SAFETY: the fence reader (`lib/vault/fence.ts`) is the only code that opens the
    // snapshot path, and it passes exactly (path, "r"); the narrowed signature
    // names that one call so the spy can delegate to the real open
    const realOpenSync = fs.openSync.bind(fs) as (file: fs.PathLike, flags: string | number) => number;
    // SAFETY: the spy keeps fs.openSync's own overload type; the narrowed
    // parameters are the (path, flags) overload production calls
    const spy = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: string | number) => {
      if (String(file) === snapshotPath()) {
        // the errno Node puts on the error, so the code under test reads it
        const error = Object.assign(new Error("ENOTDIR: not a directory, open '...'"), { code: "ENOTDIR" });
        throw error;
      }
      return realOpenSync(file, flags);
    }) as typeof fs.openSync);
    try {
      // the write itself lands; the fence read after it does not, and the
      // verdict decides whether that is a benign "unproven" or a real
      // "the snapshot is gone"
      await expect(conn.persistIfDirty()).rejects.toThrow(SnapshotPersistenceError);
    } finally {
      spy.mockRestore();
    }
    expect(events).toContain("VAULT_SNAPSHOT_FENCE_MISSING");
    expect(events).not.toContain("VAULT_SNAPSHOT_FENCE_UNREADABLE");
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
