import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquireVaultLock, closeVaultThenReleaseLock, connectionToCloseAtShutdown, createVaultLockRefusalApp, requireHeldLock, VaultAlreadyLockedError, VaultLockLostError, VaultLockUnavailableError, vaultLockRefusalPageHtml, type VaultLockOwner } from "./lock";
import { createAppConfig } from "../../config";
import { createEncryptedConnection } from "../../db/encrypted-connection";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-vault-lock-"));
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

const lockPath = (): string => path.join(dir, "vault.lock");
const fastSteal = { readRetries: 1, readRetryDelayMs: 1, stealSettleMs: 5 } as const;

function writeLock(overrides: Partial<{ pid: number; host: string; heartbeatAt: string; token: string }>): void {
  fs.writeFileSync(
    lockPath(),
    JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      heartbeatAt: new Date().toISOString(),
      token: "other-owner",
      ...overrides,
    }),
  );
}

function errno(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * A counted read seam for the #281 tests. `reads` is every read the lock made;
 * `readsAtLoss` is how many had run when it decided the lock was lost. The
 * release that follows a loss reads again, so the raw count alone cannot pin
 * the retry budget.
 */
function countingReader(behaviour: (path: string, call: number) => string) {
  const state = { reads: 0, readsAtLoss: 0 };
  const events: string[] = [];
  const logger = {
    warn: (event: string, message: string): void => {
      events.push(`${event}::${message}`);
    },
    error: (event: string, message: string): void => {
      events.push(`${event}::${message}`);
      if (event === "VAULT_LOCK_LOST") state.readsAtLoss = state.reads;
    },
  };
  return {
    state,
    events,
    logger,
    readLockFile: (lockPath: string): string => {
      state.reads += 1;
      return behaviour(lockPath, state.reads);
    },
  };
}

/**
 * A pid the OS is guaranteed to answer `ESRCH` for: spawn a child and reap it.
 * The probe tests must not hang their outcome on whether a hardcoded pid
 * happens to exist on the runner.
 */
async function reapedPid(): Promise<number> {
  const child = Bun.spawn(["bun", "-e", ""], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

describe("vault single-writer lock", () => {
  it("does not block the normal single instance and releases cleanly", () => {
    const lock = acquireVaultLock(dir);
    expect(fs.existsSync(lockPath())).toBe(true);
    // SAFETY: the test wrote this JSON itself in acquireVaultLock
    const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { pid: number; host: string; token: string };
    expect(owner.pid).toBe(process.pid);
    expect(owner.host).toBe(os.hostname());
    expect(owner.token).toBe(lock.currentOwner().token);
    lock.release();
    expect(fs.existsSync(lockPath())).toBe(false);
    // release is idempotent
    lock.release();
  });

  it("refuses a second instance while the first is live, and lets it in after release", () => {
    const first = acquireVaultLock(dir);
    expect(() => acquireVaultLock(dir, fastSteal)).toThrow(VaultAlreadyLockedError);
    first.release();
    const second = acquireVaultLock(dir, fastSteal);
    expect(second.currentOwner().pid).toBe(process.pid);
    second.release();
  });

  it("reclaims a stale lock whose foreign host stopped heartbeating", () => {
    writeLock({ host: "some-other-machine", heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const lock = acquireVaultLock(dir, fastSteal);
    expect(lock.currentOwner().pid).toBe(process.pid);
    expect(lock.currentOwner().host).toBe(os.hostname());
    lock.release();
  });

  it("does NOT steal from a live same-host process even when its heartbeat is old", () => {
    // the PID wins over the heartbeat on the local host: a reused PID may look
    // quiet, and stealing from a live holder is worse than refusing
    writeLock({ pid: process.pid, host: os.hostname(), heartbeatAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    expect(() => acquireVaultLock(dir, fastSteal)).toThrow(VaultAlreadyLockedError);
  });

  it("reclaims a lock left by a dead same-host process", async () => {
    const deadPid = await reapedPid();
    writeLock({ pid: deadPid, host: os.hostname(), heartbeatAt: new Date().toISOString() });
    const lock = acquireVaultLock(dir, fastSteal);
    expect(lock.currentOwner().pid).toBe(process.pid);
    lock.release();
  });

  it("reclaims a lock the injected probe calls gone, even with a fresh heartbeat", async () => {
    writeLock({ pid: await reapedPid(), host: os.hostname(), heartbeatAt: new Date().toISOString() });
    const lock = acquireVaultLock(dir, { ...fastSteal, probePid: () => "gone" });
    expect(lock.currentOwner().pid).toBe(process.pid);
    lock.release();
  });

  it("reclaims an inconclusive probe once the heartbeat is stale (EPERM on Windows, ADR-0012)", async () => {
    writeLock({ pid: await reapedPid(), host: os.hostname(), heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const lock = acquireVaultLock(dir, { ...fastSteal, probePid: () => "unknown" });
    expect(lock.currentOwner().pid).toBe(process.pid);
    lock.release();
  });

  it("refuses an inconclusive probe while the heartbeat is fresh", async () => {
    // the pid is genuinely gone, so reverting the seam would reclaim and fail
    // this test deterministically; only the heartbeat may keep it refused
    writeLock({ pid: await reapedPid(), host: os.hostname(), heartbeatAt: new Date().toISOString() });
    expect(() => acquireVaultLock(dir, { ...fastSteal, probePid: () => "unknown" })).toThrow(VaultAlreadyLockedError);
  });

  it("refuses a pid the probe answers as alive however old the heartbeat", () => {
    writeLock({ pid: process.pid, host: os.hostname(), heartbeatAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    expect(() => acquireVaultLock(dir, { ...fastSteal, probePid: () => "alive" })).toThrow(VaultAlreadyLockedError);
  });

  it("pins the 60s heartbeat window at its edges", () => {
    // an inconclusive probe leaves the heartbeat as the only evidence
    writeLock({ pid: 4242, host: os.hostname(), heartbeatAt: new Date(Date.now() - 59_000).toISOString() });
    expect(() => acquireVaultLock(dir, { ...fastSteal, probePid: () => "unknown" })).toThrow(VaultAlreadyLockedError);
    fs.rmSync(lockPath(), { force: true });
    writeLock({ pid: 4242, host: os.hostname(), heartbeatAt: new Date(Date.now() - 61_000).toISOString() });
    const lock = acquireVaultLock(dir, { ...fastSteal, probePid: () => "unknown" });
    expect(lock.currentOwner().pid).toBe(process.pid);
    lock.release();
  });

  it("holds the conservative refusal for a heartbeat dated in the future", () => {
    // a foreign clock running ahead is not evidence of death: reclaiming would
    // risk two writers, so the holder must stay refused
    writeLock({ pid: 4242, host: os.hostname(), heartbeatAt: new Date(Date.now() + 5 * 60_000).toISOString() });
    expect(() => acquireVaultLock(dir, { ...fastSteal, probePid: () => "unknown" })).toThrow(VaultAlreadyLockedError);
    // SAFETY: the test wrote this JSON itself above
    const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { heartbeatAt: string };
    expect(Date.parse(owner.heartbeatAt)).toBeGreaterThan(Date.now());
  });

  it("assertHeld refuses a lock file that vanished, and fail-stops exactly once", () => {
    let lost = 0;
    const lock = acquireVaultLock(dir, {
      ...fastSteal,
      onLost: () => {
        lost += 1;
      },
    });
    fs.rmSync(lockPath(), { force: true });
    expect(() => lock.assertHeld()).toThrow(VaultLockLostError);
    expect(lost).toBe(1);
  });

  it("assertHeld refuses a released lock", () => {
    const lock = acquireVaultLock(dir, fastSteal);
    lock.release();
    expect(() => lock.assertHeld()).toThrow(VaultLockLostError);
  });

  it("the write guard refuses loudly when no lock was ever held, and passes while held", () => {
    expect(() => requireHeldLock(undefined)()).toThrow("the vault write guard ran without a held lock");
    const lock = acquireVaultLock(dir, fastSteal);
    expect(() => requireHeldLock(lock)()).not.toThrow();
    lock.release();
  });

  it("writes exactly the documented lock record at the documented path (criterion 10)", () => {
    const lock = acquireVaultLock(dir);
    expect(lock.path).toBe(path.join(dir, "vault.lock"));
    // SAFETY: the lock record is JSON this process just wrote
    const record = JSON.parse(fs.readFileSync(path.join(dir, "vault.lock"), "utf8")) as VaultLockOwner;
    expect(Object.keys(record).sort()).toEqual(["heartbeatAt", "host", "pid", "startedAt", "token"]);
    expect(record.pid).toBe(process.pid);
    expect(record.host).toBe(os.hostname());
    // both timestamps are real ISO instants, not a dropped field
    expect(Number.isFinite(Date.parse(record.startedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(record.heartbeatAt))).toBe(true);
    expect(record.token).toBe(lock.currentOwner().token);
    lock.release();
  });

  it("abandons a reclaim when the holder looks live again after the settle window", () => {
    writeLock({ pid: 4242, host: os.hostname(), heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(), token: "still-ours" });
    // first look: gone. After the settle it answers alive, as a holder whose
    // heartbeat or process came back inside the window would
    let probes = 0;
    const probePid = (): "gone" | "alive" => (probes++ === 0 ? "gone" : "alive");
    expect(() => acquireVaultLock(dir, { ...fastSteal, stealSettleMs: 20, probePid })).toThrow(VaultAlreadyLockedError);
    expect(probes).toBeGreaterThanOrEqual(2);
    // the record is untouched: the reclaim was abandoned, not raced
    // SAFETY: the test wrote this JSON itself above
    const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { token: string };
    expect(owner.token).toBe("still-ours");
  });

  it("reclaims an unreadable lock file instead of blocking forever", () => {
    fs.writeFileSync(lockPath(), "{ not json");
    const lock = acquireVaultLock(dir, fastSteal);
    expect(lock.currentOwner().pid).toBe(process.pid);
    lock.release();
  });

  it("fails loudly, never a silent no-op, when the lock cannot be created", () => {
    const spy = spyOn(fs, "openSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    try {
      expect(() => acquireVaultLock(dir)).toThrow(VaultLockUnavailableError);
    } finally {
      spy.mockRestore();
    }
    // and the failure did not leave a lock file behind
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("heartbeats while held", async () => {
    const lock = acquireVaultLock(dir, { heartbeatIntervalMs: 20 });
    const first = lock.currentOwner().heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 80));
    // SAFETY: the test wrote this JSON itself in acquireVaultLock
    const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { heartbeatAt: string; token: string };
    expect(owner.token).toBe(lock.currentOwner().token);
    expect(Date.parse(owner.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(first));
    lock.release();
  });

  it("release never deletes another owner's lock", () => {
    const lock = acquireVaultLock(dir);
    // simulate a steal of the file by a different owner
    fs.rmSync(lockPath(), { force: true });
    writeLock({ token: "the-new-owner" });
    lock.release();
    // SAFETY: the test wrote this JSON itself above
    const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { token: string };
    expect(owner.token).toBe("the-new-owner");
  });

  it("states the Arabic refusal with the holder identity", () => {
    const html = vaultLockRefusalPageHtml({
      pid: 4242,
      host: "shop-pc",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      token: "t",
    });
    expect(html).toContain("البيانات مفتوحة في نسخة أخرى");
    expect(html).toContain("shop-pc");
    expect(html).toContain("4242");
  });

  it("refuses instead of deleting a replacement lock when the stale file changes hands mid-reclaim (round-5)", () => {
    writeLock({ host: "old-dead-host", heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(), token: "stale-token" });
    const realRename = fs.renameSync.bind(fs);
    let swapped = false;
    // interleaving: our stale check passed, then another sidecar won the
    // reclaim and created its own lock before our rename ran
    const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!swapped && String(from) === lockPath()) {
        swapped = true;
        fs.writeFileSync(
          lockPath(),
          JSON.stringify({
            pid: 999_999,
            host: os.hostname(),
            startedAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            token: "replacement-token",
          }),
        );
      }
      // SAFETY: the spy is typed with fs.renameSync's own PathLike overload;
      // production only ever passes PathLike values here
      return realRename(from as fs.PathLike, to as fs.PathLike);
    });
    try {
      expect(() => acquireVaultLock(dir, fastSteal)).toThrow(VaultAlreadyLockedError);
    } finally {
      spy.mockRestore();
    }
    // the replacement survives at the path and no temp copy is left behind
    // SAFETY: the test wrote this JSON itself above
    const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { token: string };
    expect(owner.token).toBe("replacement-token");
    expect(fs.readdirSync(dir).filter((name) => name.includes(".reclaim-"))).toEqual([]);
  });

  it("fail-stops when the lock file is replaced by another owner (round-5)", async () => {
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, { heartbeatIntervalMs: 20, onLost: (reason) => lost.push(reason) });
    fs.rmSync(lockPath(), { force: true });
    writeLock({ token: "another-owner" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(lost.length).toBeGreaterThan(0);
    lock.release();
    // the heartbeat never deleted the replacement's file
    // SAFETY: the test wrote this JSON itself above
    const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { token: string };
    expect(owner.token).toBe("another-owner");
  });

  it("names the holder in the log and hands it to onLost on every loss", async () => {
    const logged: string[] = [];
    const holders: (VaultLockOwner | undefined)[] = [];
    const lock = acquireVaultLock(dir, {
      heartbeatIntervalMs: 20,
      logger: {
        warn() {
          /* no warns expected on this path */
        },
        error(event, message) {
          logged.push(`${event}::${message}`);
        },
      },
      onLost: (_reason, holder) => holders.push(holder),
    });
    fs.rmSync(lockPath(), { force: true });
    writeLock({ host: "shop-pc", pid: 4242, token: "another-owner" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(holders.length).toBeGreaterThan(0);
    expect(holders[0]?.host).toBe("shop-pc");
    expect(holders[0]?.pid).toBe(4242);
    expect(
      logged.some((line) => line.includes("VAULT_LOCK_LOST") && line.includes("shop-pc") && line.includes("4242")),
    ).toBe(true);
    lock.release();
  });

  it("reclaim logs name the holder's machine and pid", () => {
    const logged: string[] = [];
    writeLock({ host: "dead-laptop", pid: 7777, heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const lock = acquireVaultLock(dir, {
      ...fastSteal,
      probePid: () => "unknown",
      logger: {
        warn(event, message) {
          logged.push(`${event}::${message}`);
        },
        error() {
          /* no errors expected */
        },
      },
    });
    expect(logged.some((line) => line.includes("VAULT_LOCK_RECLAIMED") && line.includes("dead-laptop") && line.includes("7777"))).toBe(
      true,
    );
    lock.release();
  });

  it("abandons the store at shutdown once the folder is lost (ADR-0012 clause 3)", () => {
    // without this, the loser's final checkpoint writes its stale image over
    // the new owner's snapshot
    const store = { close: async (): Promise<void> => undefined };
    expect(connectionToCloseAtShutdown(true, store)).toBeUndefined();
    expect(connectionToCloseAtShutdown(false, store)).toBe(store);
    expect(connectionToCloseAtShutdown(true, undefined)).toBeUndefined();
  });

  it("a queued snapshot write refuses once the lock is stolen, and writes nothing (ADR-0012 clause 3)", async () => {
    const lock = acquireVaultLock(dir, { ...fastSteal, onLost: () => undefined });
    const snapshot = path.join(dir, "dokan.db.enc");
    const conn = createEncryptedConnection({
      vaultId: "11111111-2222-3333-4444-555555555555",
      masterKey: Buffer.alloc(32, 7),
      snapshotPath: snapshot,
      fresh: true,
      // the guard main.ts installs: the write path re-checks lock ownership
      writeGuard: () => lock.assertHeld(),
    });
    try {
      conn.raw.exec("CREATE TABLE t(a TEXT)");
      conn.markDirty();
      await conn.flush();
      const before = fs.readFileSync(snapshot);

      // the ADR ordering: mutate while we still hold the lock, QUEUE the
      // persist, steal the folder before the queued job runs
      conn.raw.exec("INSERT INTO t VALUES ('sale')");
      conn.markDirty();
      const queued = conn.persistIfDirty();
      fs.rmSync(lockPath(), { force: true });
      writeLock({ token: "the-new-owner" });

      // the queued persist must refuse when it drains rather than overwrite
      // the new owner's snapshot
      await expect(queued).rejects.toThrow(VaultLockLostError);
      expect(fs.readFileSync(snapshot)).toEqual(before);
      // the fail-stop ran once, and the replacement's record survived
      // SAFETY: the test wrote this JSON itself above
      const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { token: string };
      expect(owner.token).toBe("the-new-owner");
    } finally {
      conn.raw.close();
    }
  });

  it("holds the lock until the store close (final checkpoint) finishes (round-5)", async () => {
    const lock = acquireVaultLock(dir);
    let releaseObservedDuringClose: boolean | undefined;
    const closing = closeVaultThenReleaseLock(
      {
        async close() {
          await new Promise((resolve) => setTimeout(resolve, 40));
          releaseObservedDuringClose = !fs.existsSync(lockPath());
        },
      },
      lock,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    // while close is in flight the lock is still held
    expect(fs.existsSync(lockPath())).toBe(true);
    await closing;
    expect(releaseObservedDuringClose).toBe(false);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("releases the lock even when the store close fails (round-5)", async () => {
    const lock = acquireVaultLock(dir);
    await expect(
      closeVaultThenReleaseLock(
        {
          async close() {
            throw new Error("snapshot persist failed");
          },
        },
        lock,
      ),
    ).rejects.toThrow("snapshot persist failed");
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("escapes a hostile lock-record host in the refusal page (round-5)", () => {
    const html = vaultLockRefusalPageHtml({
      pid: 7,
      host: '<img src=x onerror="alert(1)">',
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      token: "t",
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=");
    expect(html).not.toContain("<script");
    // the record is still identified, stripped to the hostname charset
    expect(html).toContain("imgsrcxonerroralert1");
  });

  it("treats a lock record with an over-long host as unreadable (round-5)", () => {
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({
        pid: 1,
        host: "h".repeat(65),
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        token: "t",
      }),
    );
    const lock = acquireVaultLock(dir, fastSteal);
    expect(lock.currentOwner().pid).toBe(process.pid);
    lock.release();
  });
});

/**
 * #281: `ENOENT` is "gone" and everything else is "cannot read right now". The
 * holder must ride out the second, and must still lose the lock promptly on
 * the first — a retry budget spent on a deleted file is a stalled writer.
 */
describe("a transient lock-file read error is not theft (#281)", () => {
  const realRead = (lockPath: string): string => fs.readFileSync(lockPath, "utf8");
  const fastRead = { transientReadRetries: 3, transientReadRetryDelayMs: 1 } as const;

  it("rides out one failed read and keeps the lock", () => {
    const reads = countingReader((lockPath, call) => {
      if (call === 1) throw errno("EBUSY", "EBUSY: resource busy or locked, read 'vault.lock'");
      return realRead(lockPath);
    });
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, {
      ...fastRead,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      onLost: (reason) => lost.push(reason),
    });
    try {
      expect(() => lock.assertHeld()).not.toThrow();
      expect(reads.state.reads).toBe(2);
      expect(lost).toEqual([]);
      expect(reads.events.some((line) => line.startsWith("VAULT_LOCK_LOST"))).toBe(false);
      // the record is untouched: we never stopped holding it
      // SAFETY: the test wrote this JSON itself in acquireVaultLock
      const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { token: string };
      expect(owner.token).toBe(lock.currentOwner().token);
    } finally {
      lock.release();
    }
  });

  it("treats ENOENT as gone at once, with no retry budget spent", () => {
    const reads = countingReader(() => {
      throw errno("ENOENT", "ENOENT: no such file or directory, open 'vault.lock'");
    });
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, {
      ...fastRead,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      onLost: (reason) => lost.push(reason),
    });
    expect(() => lock.assertHeld()).toThrow(VaultLockLostError);
    expect(reads.state.readsAtLoss).toBe(1);
    expect(lost[0]).toBe("the lock file disappeared");
  });

  it("fail-stops when the lock file has genuinely gone (default reader)", () => {
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, { onLost: (reason) => lost.push(reason) });
    fs.rmSync(lockPath(), { force: true });
    expect(() => lock.assertHeld()).toThrow(VaultLockLostError);
    expect(lost).toEqual(["the lock file disappeared"]);
  });

  it("still fail-stops at once when another owner's record is there", () => {
    const reads = countingReader(realRead);
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, {
      ...fastRead,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      onLost: (reason) => lost.push(reason),
    });
    writeLock({ host: "shop-pc", pid: 4242, token: "the-new-owner" });
    expect(() => lock.assertHeld()).toThrow(VaultLockLostError);
    expect(reads.state.readsAtLoss).toBe(1);
    expect(lost[0]).toContain("replaced");
  });

  it("stops retrying at the bound and fails closed, naming the error and the count", () => {
    const reads = countingReader((lockPath, call) => {
      // readable on the attempt AFTER the budget: a loop that retried even once
      // more would see our record and not fail-stop
      if (call <= fastRead.transientReadRetries + 1) throw errno("EACCES", "EACCES: permission denied, open 'vault.lock'");
      return realRead(lockPath);
    });
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, {
      ...fastRead,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      onLost: (reason) => lost.push(reason),
    });
    expect(() => lock.assertHeld()).toThrow(VaultLockLostError);
    expect(reads.state.readsAtLoss).toBe(fastRead.transientReadRetries + 1);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("EACCES");
    expect(lost[0]).toContain(`${fastRead.transientReadRetries + 1} attempts`);
    // the OS's own sentence survives into the reason: the errno alone does not
    // say which syscall failed on which path (critic F1)
    expect(lost[0]).toContain("permission denied");
  });

  it("names a malformed record, not a disappearance, when the budget runs out", () => {
    const reads = countingReader(() => "{ not json");
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, {
      ...fastRead,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      onLost: (reason) => lost.push(reason),
    });
    expect(() => lock.assertHeld()).toThrow(VaultLockLostError);
    expect(reads.state.readsAtLoss).toBe(fastRead.transientReadRetries + 1);
    expect(lost[0]).toContain("MALFORMED");
  });

  it("retries a malformed record instead of calling a replacement a disappearance", () => {
    // a reclaim renames our file away and creates its own before writing it, so
    // a held read can catch a 0-byte record on a healthy lock; the retry must
    // resolve to "replaced by <holder>", not to "the lock file disappeared"
    const reads = countingReader((lockPath, call) => (call === 1 ? "" : realRead(lockPath)));
    const lost: string[] = [];
    const holders: (VaultLockOwner | undefined)[] = [];
    const lock = acquireVaultLock(dir, {
      ...fastRead,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      onLost: (reason, holder) => {
        lost.push(reason);
        holders.push(holder);
      },
    });
    writeLock({ host: "shop-pc", pid: 4242, token: "the-new-owner" });
    expect(() => lock.assertHeld()).toThrow(VaultLockLostError);
    // one retry, then the decision; the release that follows the loss reads again
    expect(reads.state.readsAtLoss).toBe(2);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("replaced");
    expect(holders[0]?.token).toBe("the-new-owner");
  });

  it("names every error code it hit, on one line", () => {
    const reads = countingReader((_lockPath, call) => {
      const code = call % 2 === 1 ? "EBUSY" : "EACCES";
      throw errno(code, `${code}: cannot read\n  'vault.lock'`);
    });
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, {
      transientReadRetries: 3,
      transientReadRetryDelayMs: 1,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      onLost: (reason) => lost.push(reason),
    });
    expect(() => lock.assertHeld()).toThrow(VaultLockLostError);
    // a flapping window names both codes, not just the last one, and the OS's
    // own multi-line sentence is folded to one line (critic N1)
    expect(lost[0]).toContain("EBUSY, EACCES");
    expect(lost[0]).not.toContain("\n");
  });

  it("classifies a non-Error throw by its errno code", () => {
    const reads = countingReader(() => {
      // the seam is injectable, so the thrown value is not guaranteed to be an
      // Error; flattening it first would lose the errno (critic N4)
      throw { code: "ENOENT" };
    });
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, {
      ...fastRead,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      onLost: (reason) => lost.push(reason),
    });
    expect(() => lock.assertHeld()).toThrow(VaultLockLostError);
    expect(reads.state.readsAtLoss).toBe(1);
    expect(lost[0]).toBe("the lock file disappeared");
  });

  it("bounds a hostile error code the same way as the message", () => {
    const reads = countingReader(() => {
      throw { code: `E\nBUSY: ${"x".repeat(5_000)}` };
    });
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, {
      ...fastRead,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      onLost: (reason) => lost.push(reason),
    });
    expect(() => lock.assertHeld()).toThrow(VaultLockLostError);
    // the code is folded and cut like the message: a code is a token, never a
    // smuggled log line (critic r3-1)
    expect(lost[0]).toContain("E BUSY: x");
    expect(lost[0]).not.toContain("\n");
    expect(lost[0]!.length).toBeLessThan(300);
  });

  it("clamps a negative or non-finite knob to the safe end", () => {
    // NaN is not a budget: it falls back to the default instead of zeroing it
    const nan = countingReader((lockPath, call) => {
      if (call <= 2) throw errno("EBUSY", "EBUSY: resource busy or locked");
      return realRead(lockPath);
    });
    const nanLock = acquireVaultLock(dir, {
      transientReadRetries: Number.NaN,
      transientReadRetryDelayMs: Number.NaN,
      readLockFile: nan.readLockFile,
      logger: nan.logger,
    });
    try {
      expect(() => nanLock.assertHeld()).not.toThrow();
      expect(nan.state.reads).toBe(3);
    } finally {
      nanLock.release();
    }

    // -1 truncates to no retries at all: one read, then the loss. Last, because
    // a lock lost this way leaves its file behind for the next boot
    const negative = countingReader(() => {
      throw errno("EBUSY", "EBUSY: resource busy or locked");
    });
    const negativeLost: string[] = [];
    const negativeLock = acquireVaultLock(dir, {
      transientReadRetries: -1,
      transientReadRetryDelayMs: -1,
      readLockFile: negative.readLockFile,
      logger: negative.logger,
      onLost: (reason) => negativeLost.push(reason),
    });
    expect(() => negativeLock.assertHeld()).toThrow(VaultLockLostError);
    expect(negative.state.readsAtLoss).toBe(1);
    expect(negativeLost).toHaveLength(1);
  });

  it("keeps its patience at the default budget for most of a second", () => {
    const reads = countingReader((lockPath, call) => {
      if (call <= 8) throw errno("EBUSY", "EBUSY: resource busy or locked");
      return realRead(lockPath);
    });
    // the knobs nobody sets: 8 x 100 ms of a scanner holding the file is inside
    // the default patience, where the old 5 x 50 ms budget failed the holder
    // closed on a healthy machine (critic r3-2)
    const lock = acquireVaultLock(dir, { readLockFile: reads.readLockFile, logger: reads.logger });
    try {
      expect(() => lock.assertHeld()).not.toThrow();
      expect(reads.state.reads).toBe(9);
    } finally {
      lock.release();
    }
  });

  it("caps the whole retry window even when a knob asks for hours", () => {
    const reads = countingReader((lockPath, call) => {
      if (call <= 2) throw errno("EBUSY", "EBUSY: resource busy or locked");
      return realRead(lockPath);
    });
    const lost: string[] = [];
    const startedAt = Date.now();
    const lock = acquireVaultLock(dir, {
      transientReadRetries: 10_000,
      transientReadRetryDelayMs: 3_000,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      onLost: (reason) => lost.push(reason),
    });
    try {
      expect(() => lock.assertHeld()).not.toThrow();
      expect(reads.state.reads).toBe(3);
      // unclamped this is 2 x 3 s; the window holds the whole sequence near a
      // second, because it runs inside the write guard, and a regression here
      // fails in seconds rather than after the unclamped budget (critic N2)
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(lost).toEqual([]);
    } finally {
      lock.release();
    }
  });

  it("caps the attempt ceiling even when a knob asks for ten thousand", () => {
    const reads = countingReader(() => {
      throw errno("EBUSY", "EBUSY: resource busy or locked");
    });
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, {
      transientReadRetries: 10_000,
      transientReadRetryDelayMs: 0,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      onLost: (reason) => lost.push(reason),
    });
    expect(() => lock.assertHeld()).toThrow(VaultLockLostError);
    expect(reads.state.readsAtLoss).toBe(101);
    expect(lost).toHaveLength(1);
  });

  it("heartbeats through a transient read error instead of declaring the lock lost", async () => {
    const reads = countingReader((lockPath, call) => {
      if (call === 1) throw errno("EBUSY", "EBUSY: resource busy or locked, read 'vault.lock'");
      return realRead(lockPath);
    });
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, {
      ...fastRead,
      heartbeatIntervalMs: 10,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      onLost: (reason) => lost.push(reason),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lost).toEqual([]);
    expect(reads.state.reads).toBeGreaterThan(1);
    // the heartbeat kept writing: the record still names us
    // SAFETY: the test wrote this JSON itself in acquireVaultLock
    const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { token: string };
    expect(owner.token).toBe(lock.currentOwner().token);
    lock.release();
  });

  it("fail-stops the heartbeat once the read error outlasts the budget", async () => {
    const reads = countingReader(() => {
      throw errno("EBUSY", "EBUSY: resource busy or locked, read 'vault.lock'");
    });
    const lost: string[] = [];
    acquireVaultLock(dir, {
      ...fastRead,
      heartbeatIntervalMs: 10,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      onLost: (reason) => lost.push(reason),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("EBUSY");
  });

  it("release never deletes a lock file it could not read", () => {
    const reads = countingReader(() => {
      throw errno("EACCES", "EACCES: permission denied, open 'vault.lock'");
    });
    const lock = acquireVaultLock(dir, { readLockFile: reads.readLockFile, logger: reads.logger });
    lock.release();
    // we cannot compare the token, so we must not unlink: the record may be a
    // new owner's, and a stale file is still reclaimable by the pid probe
    expect(reads.state.reads).toBe(1);
    expect(fs.existsSync(lockPath())).toBe(true);
  });
});

describe("the vault lock refusal app", () => {
  const owner: VaultLockOwner = {
    pid: 4242,
    host: "shop-pc",
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    token: "other-owner",
  };

  it("answers the status route and /health with 503 and the refusal code (ADR-0012)", async () => {
    const app = createVaultLockRefusalApp(createAppConfig({}), new VaultAlreadyLockedError(owner, lockPath()));
    const status = await app.fetch(new Request("http://localhost/api/vault/status"));
    expect(status.status).toBe(503);
    expect(await status.json()).toEqual({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE" } });

    const health = await app.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ ok: false, error: "VAULT_LOCKED_BY_OTHER_INSTANCE" });
  });

  it("serves the Arabic page elsewhere and never JSON for the UI route", async () => {
    const app = createVaultLockRefusalApp(createAppConfig({}), new VaultAlreadyLockedError(owner, lockPath()));
    const page = await app.fetch(new Request("http://localhost/"));
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("البيانات مفتوحة في نسخة أخرى");
  });

  it("echoes the boot token so the shell keeps verifying the child", async () => {
    const token = "c".repeat(64);
    const app = createVaultLockRefusalApp(createAppConfig({ DOKAN_BOOT_TOKEN: token }), new VaultAlreadyLockedError(owner, lockPath()));
    const ok = await app.fetch(new Request(`http://localhost/health-token?token=${token}`));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, token });
    const wrong = await app.fetch(new Request("http://localhost/health-token?token=wrong"));
    expect(wrong.status).toBe(404);
  });
});
