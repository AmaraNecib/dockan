import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildEncryptedSnapshot, createEncryptedConnection } from "../../db/encrypted-connection";
import { readSnapshotFence } from "./format";
import { acquireVaultLock } from "./lock";

/**
 * Issue #292 — the fence is checked lazily. #280 fenced the snapshot
 * envelope, but the fence was only read when the holder acted (a persist, a
 * checkpoint, a close) or when the next holder opened the file. A holder that
 * verified its write and then went idle never looked again: a zombie that
 * renamed its envelope over `dokan.db.enc` was served silently, and the
 * acknowledged transactions it carried were gone.
 *
 * These tests build that exact sequence and pin the bound the issue asks for:
 * a foreign stamp is detected within ONE HEARTBEAT, and it is logged.
 */

const vaultId = "11111111-2222-3333-4444-555555555555";
const masterKey = Buffer.alloc(32, 7);
/** the token a zombie seals under: a former holder's, recognisable forever */
const zombieToken = "f".repeat(32);
/** the heartbeat cadence the tests use: the production one is 10s */
const tickMs = 20;

let dir: string;
const snapshotPath = (): string => path.join(dir, "dokan.db.enc");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-fence-heartbeat-"));
});

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for a condition, and fail loudly rather than hang the suite. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${what} never happened within ${timeoutMs}ms`);
    await sleep(5);
  }
}

/** A serialized SQLite image, for the zombie's envelope. */
function serializedImage(rows: string[]): Buffer {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t(a TEXT)");
  for (const row of rows) db.exec(`INSERT INTO t VALUES ('${row}')`);
  const image = db.serialize();
  db.close();
  return image;
}

/** The stamp the envelope on disk carries. */
const diskStamp = (): string | undefined => readSnapshotFence(fs.readFileSync(snapshotPath()))?.stamp;

describe("the snapshot fence on the heartbeat tick (#292)", () => {
  it("detects a snapshot a zombie replaced while the holder was idle, within one heartbeat", async () => {
    const events: string[] = [];
    const lock = acquireVaultLock(dir, { heartbeatIntervalMs: tickMs });
    const conn = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      fresh: true,
      writeStamp: () => lock.currentOwner().token,
      logger: { warn: (event) => events.push(event) },
    });
    try {
      // the holder verifies its write
      conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
      conn.markDirty();
      await conn.persistIfDirty();
      expect(diskStamp()).toBe(lock.currentOwner().token);

      // and the fence rides the holder's heartbeat
      lock.addHeartbeatCheck(() => conn.recheckFence());

      // the fence is intact and the heartbeat is beating: nothing is reported
      await sleep(tickMs * 3);
      expect(events).toEqual([]);

      // a zombie renames its envelope over dokan.db.enc while the holder is
      // idle: no persist, no checkpoint, no close
      const zombie = path.join(dir, "zombie.db.enc");
      fs.writeFileSync(zombie, buildEncryptedSnapshot(masterKey, vaultId, serializedImage(["zombie"]), zombieToken));
      fs.renameSync(zombie, snapshotPath());

      // within one heartbeat the foreign stamp is observed, and it is NAMED
      await waitFor("the foreign stamp to be detected", () => events.length > 0);
      expect(events).toEqual(["VAULT_SNAPSHOT_FENCE_FOREIGN"]);

      // and the version is not durable: the holder's bytes are back on disk
      // only because it rewrote them
      await conn.persistIfDirty();
      expect(diskStamp()).toBe(lock.currentOwner().token);
    } finally {
      await conn.close();
      lock.release();
    }
  });

  it("names the foreign stamp once, not on every tick", async () => {
    const events: string[] = [];
    const lock = acquireVaultLock(dir, { heartbeatIntervalMs: tickMs });
    const conn = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      fresh: true,
      writeStamp: () => lock.currentOwner().token,
      logger: { warn: (event) => events.push(event) },
    });
    try {
      conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
      conn.markDirty();
      await conn.persistIfDirty();
      lock.addHeartbeatCheck(() => conn.recheckFence());

      const zombie = path.join(dir, "zombie.db.enc");
      fs.writeFileSync(zombie, buildEncryptedSnapshot(masterKey, vaultId, serializedImage(["zombie"]), zombieToken));
      fs.renameSync(zombie, snapshotPath());

      await waitFor("the foreign stamp to be detected", () => events.length > 0);
      // ten more ticks: the same foreign stamp is one event, not ten thousand
      await sleep(tickMs * 10);
      expect(events).toEqual(["VAULT_SNAPSHOT_FENCE_FOREIGN"]);
    } finally {
      await conn.close();
      lock.release();
    }
  });

  it("names a replacement the write path notices first, so no theft is silent", async () => {
    // the write path reads the fence too. When a checkpoint (the shutdown and
    // backup seam) runs before the next heartbeat, the checkpoint is the first
    // to notice the replacement — and it names it, so the theft is not silent
    // just because the tick was late.
    const events: string[] = [];
    // a cadence long enough that no tick fires during the test
    const lock = acquireVaultLock(dir, { heartbeatIntervalMs: 60_000 });
    const conn = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      fresh: true,
      writeStamp: () => lock.currentOwner().token,
      logger: { warn: (event) => events.push(event) },
    });
    try {
      conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
      conn.markDirty();
      await conn.persistIfDirty();

      const zombie = path.join(dir, "zombie.db.enc");
      fs.writeFileSync(zombie, buildEncryptedSnapshot(masterKey, vaultId, serializedImage(["zombie"]), zombieToken));
      fs.renameSync(zombie, snapshotPath());

      // the holder checkpoints, before any heartbeat
      conn.checkpoint();

      expect(events).toEqual(["VAULT_SNAPSHOT_FENCE_FOREIGN"]);
      // the holder's own bytes are back on disk: it rewrote them
      expect(diskStamp()).toBe(lock.currentOwner().token);
    } finally {
      await conn.close();
      lock.release();
    }
  });

  it("names a replacement a dirty write repairs, not only a clean checkpoint", async () => {
    // Greptile P2: a dirty version short-circuits `snapshotIsCurrent()` at the
    // version comparison, so the write used to repair the zombie's envelope and
    // then read back its own stamp — silent. The theft is still repaired, but an
    // operator who never sees it cannot tell a repair from a quiet day.
    const events: string[] = [];
    const lock = acquireVaultLock(dir, { heartbeatIntervalMs: 60_000 });
    const conn = createEncryptedConnection({
      vaultId,
      masterKey,
      snapshotPath: snapshotPath(),
      fresh: true,
      writeStamp: () => lock.currentOwner().token,
      logger: { warn: (event) => events.push(event) },
    });
    try {
      conn.raw.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('mine')");
      conn.markDirty();
      await conn.persistIfDirty();

      const zombie = path.join(dir, "zombie.db.enc");
      fs.writeFileSync(zombie, buildEncryptedSnapshot(masterKey, vaultId, serializedImage(["zombie"]), zombieToken));
      fs.renameSync(zombie, snapshotPath());

      // a NEW mutation arrives before the next heartbeat: the version is dirty,
      // so the write path is the only thing that can notice before repairing
      conn.raw.exec("INSERT INTO t VALUES ('second')");
      conn.markDirty();
      await conn.persistIfDirty();

      expect(events).toEqual(["VAULT_SNAPSHOT_FENCE_FOREIGN"]);
      expect(diskStamp()).toBe(lock.currentOwner().token);
    } finally {
      await conn.close();
      lock.release();
    }
  });

  it("keeps the lock when a heartbeat check throws", async () => {
    // a fence re-read that could not decide must not fail-stop a healthy
    // instance: the lock is still ours, and only the log says so
    const lost: string[] = [];
    const logged: string[] = [];
    const lock = acquireVaultLock(dir, {
      heartbeatIntervalMs: tickMs,
      onLost: (reason) => lost.push(reason),
      logger: {
        warn() {
          /* no warns expected on this path */
        },
        error: (event, message) => logged.push(`${event}::${message}`),
      },
    });
    lock.addHeartbeatCheck(() => {
      throw new Error("the fence could not be read");
    });
    await sleep(tickMs * 3);

    expect(lost).toEqual([]);
    expect(logged.some((line) => line.includes("SERVER_ERROR") && line.includes("heartbeat check"))).toBe(true);
    expect(() => lock.assertHeld()).not.toThrow();
    lock.release();
  });
});
