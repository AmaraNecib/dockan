import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquireVaultLock, closeVaultThenReleaseLock, connectionToCloseAtShutdown, createVaultLockRefusalApp, holderToken, requireHeldLock, VaultAlreadyLockedError, VaultLockLostError, VaultLockUnavailableError, VaultLockUnreadableError, vaultLockRefusalPageHtml, type VaultLock, type VaultLockOwner, type VaultLockRefusal } from "./lock";
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

/**
 * Make reads of the lock file fail with a non-ENOENT errno, the way an
 * antivirus scan, a network drive or a rename in flight does (#287). `matches`
 * selects the paths to fail, so a test can fail the record at `vault.lock`, its
 * renamed-aside reclaim copy, or both. The real read is captured before the spy
 * so unrelated reads still work and the test can inspect the file after
 * `restore`.
 */
function spyLockReadFailure(matches: (target: string) => boolean, code = "EBUSY"): () => void {
  const originalRead = fs.readFileSync;
  // SAFETY: fs.readFileSync is overloaded (string when an encoding is given,
  // Buffer otherwise); this helper only intercepts the lock module's utf8
  // reads, so the captured original is used through the string overload.
  const readUtf8 = originalRead as (file: fs.PathLike, ...args: unknown[]) => string;
  const spy = spyOn(fs, "readFileSync").mockImplementation(
    // SAFETY: bun types the mock as the callee's whole overload set; this
    // implementation forwards every read that does not match to the original.
    ((target: fs.PathLike, ...args: unknown[]) => {
      if (matches(String(target))) {
        throw Object.assign(new Error(`${code}: simulated lock-file read failure`), { code });
      }
      return readUtf8(target, ...args);
    }) as typeof fs.readFileSync,
  );
  return () => spy.mockRestore();
}

/**
 * A read fault that fails the first matching attempt and lets the next one
 * through, so every `readOwner` window at `readRetries: 1` is one failed
 * attempt followed by a readable one (#287). Unlike `spyLockReadFailure`,
 * which fails every matching read, this models the intermittent sharing
 * violation the sticky `blocked` flag exists for: a later readable but
 * malformed read in the same window must not clear the failure before it.
 */
function spyLockIntermittentReadFailure(matches: (target: string) => boolean, code = "EBUSY"): () => void {
  const originalRead = fs.readFileSync;
  // SAFETY: see spyLockReadFailure: only the lock module's utf8 reads are intercepted.
  const readUtf8 = originalRead as (file: fs.PathLike, ...args: unknown[]) => string;
  let failNext = true;
  const spy = spyOn(fs, "readFileSync").mockImplementation(
    // SAFETY: bun types the mock as the callee's whole overload set; this
    // implementation forwards every read that does not match to the original.
    ((target: fs.PathLike, ...args: unknown[]) => {
      if (matches(String(target))) {
        if (failNext) {
          failNext = false;
          throw Object.assign(new Error(`${code}: simulated lock-file read failure`), { code });
        }
        failNext = true;
      }
      return readUtf8(target, ...args);
    }) as typeof fs.readFileSync,
  );
  return () => spy.mockRestore();
}

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
 * A driven clock and sleep for the held-lock retry loop: time moves only when
 * the loop sleeps, so its bounds are asserted by arithmetic rather than against
 * a loaded machine's wall clock (#281, Greptile P2). `sleeps` is every delay
 * the loop asked for, in order. A non-positive or non-finite ask moves time by
 * one millisecond, so a sequence whose configured delay is 0 still reaches the
 * one-second window: a mutant with no attempt ceiling terminates there instead
 * of spinning the event loop where no bun timeout can interrupt it.
 */
type ControlledClock = {
  now: () => number;
  sleep: (milliseconds: number) => void;
  sleeps: number[];
};

function controlledClock(): ControlledClock {
  const sleeps: number[] = [];
  let time = 0;
  return {
    sleeps,
    now: () => time,
    sleep: (milliseconds: number): void => {
      sleeps.push(milliseconds);
      time += Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 1;
    },
  };
}

/**
 * Poll `predicate` until it holds or the timeout expires. The owed-release
 * retry runs on a real `setTimeout`, so the test that observes it polls instead
 * of sleeping for a fixed slice and hoping.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The VaultAlreadyLockedError a refused acquire threw, or undefined when it did not throw. */
function refusalFrom(acquire: () => VaultLock): VaultAlreadyLockedError | undefined {
  try {
    acquire();
    return undefined;
  } catch (error) {
    if (error instanceof VaultAlreadyLockedError) return error;
    throw error;
  }
}

/** The page's held variant, which every refusal-page test below builds by hand. */
function heldRefusal(owner: VaultLockOwner | undefined, staleHeartbeatOverAlivePid = false): VaultLockRefusal {
  return { kind: "held", owner, staleHeartbeatOverAlivePid };
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

  it("names a recycled pid only once the recorded heartbeat is several windows stale (#283)", () => {
    // An alive pid over a quiet heartbeat is the recycled-pid box. The refusal
    // decision stands either way; only the story differs, so the flag is true
    // only once the heartbeat is past the several-windows threshold.
    const options = { ...fastSteal, staleHeartbeatMs: 1000, probePid: () => "alive" as const };
    writeLock({ pid: process.pid, host: os.hostname(), heartbeatAt: new Date(Date.now() - 2_000).toISOString() });
    const recent = refusalFrom(() => acquireVaultLock(dir, options));
    expect(recent).toBeInstanceOf(VaultAlreadyLockedError);
    expect(recent?.staleHeartbeatOverAlivePid).toBe(false);
    fs.rmSync(lockPath(), { force: true });
    writeLock({ pid: process.pid, host: os.hostname(), heartbeatAt: new Date(Date.now() - 5_000).toISOString() });
    const recycled = refusalFrom(() => acquireVaultLock(dir, options));
    expect(recycled?.staleHeartbeatOverAlivePid).toBe(true);
  });

  it("pins the recycled-pid threshold at three default heartbeat windows on both sides (#283)", () => {
    // The threshold is `staleHeartbeatMs` x 3 and the default window is 60s, so
    // the boundary is 180s. Both sides matter: raise the multiplier and a
    // genuinely recycled pid stops being named; lower it and a holder
    // suspended for three minutes is told to delete a live lock file. The
    // 2s/5s pair above runs at `staleHeartbeatMs: 1000` and so pins neither
    // edge of the shipped default.
    const options = { ...fastSteal, probePid: () => "alive" as const };
    writeLock({ pid: process.pid, host: os.hostname(), heartbeatAt: new Date(Date.now() - 179_000).toISOString() });
    const inside = refusalFrom(() => acquireVaultLock(dir, options));
    expect(inside).toBeInstanceOf(VaultAlreadyLockedError);
    expect(inside?.staleHeartbeatOverAlivePid).toBe(false);
    fs.rmSync(lockPath(), { force: true });
    writeLock({ pid: process.pid, host: os.hostname(), heartbeatAt: new Date(Date.now() - 181_000).toISOString() });
    const past = refusalFrom(() => acquireVaultLock(dir, options));
    expect(past).toBeInstanceOf(VaultAlreadyLockedError);
    expect(past?.staleHeartbeatOverAlivePid).toBe(true);
  });

  it("does not claim a recycled pid when the refusal rests on a heartbeat (#283)", () => {
    const options = { ...fastSteal, staleHeartbeatMs: 1000, probePid: () => "unknown" as const };
    // An inconclusive probe defers to a FRESH heartbeat: it refuses, but the
    // evidence is the heartbeat, not an alive pid that may have been recycled.
    writeLock({ pid: 4242, host: os.hostname(), heartbeatAt: new Date().toISOString() });
    const inconclusive = refusalFrom(() => acquireVaultLock(dir, options));
    expect(inconclusive).toBeInstanceOf(VaultAlreadyLockedError);
    expect(inconclusive?.staleHeartbeatOverAlivePid).toBe(false);
    // A foreign host never reads an alive pid: its heartbeat is the evidence.
    writeLock({ host: "another-machine", heartbeatAt: new Date().toISOString() });
    const foreign = refusalFrom(() => acquireVaultLock(dir, options));
    expect(foreign?.staleHeartbeatOverAlivePid).toBe(false);
  });

  it("refuses an unparseable heartbeat over an alive pid as a recycled one (#283)", () => {
    writeLock({ pid: process.pid, host: os.hostname(), heartbeatAt: "not a stamp" });
    const refusal = refusalFrom(() =>
      acquireVaultLock(dir, { ...fastSteal, staleHeartbeatMs: 1000, probePid: () => "alive" as const }),
    );
    expect(refusal?.staleHeartbeatOverAlivePid).toBe(true);
  });

  it("keeps a future-stamped heartbeat out of the recycled-pid story (#283)", () => {
    // clock skew or a hand-edited record: a stamp ahead of now is not a quiet
    // holder that stopped beating. The refusal stands (the pid answers alive),
    // but the story must stay the honest one, so the app never sends the owner
    // to delete `vault.lock` over a clock that merely runs ahead.
    const options = { ...fastSteal, staleHeartbeatMs: 1000, probePid: () => "alive" as const };
    writeLock({ pid: process.pid, host: os.hostname(), heartbeatAt: new Date(Date.now() + 5 * 60_000).toISOString() });
    const refusal = refusalFrom(() => acquireVaultLock(dir, options));
    expect(refusal).toBeInstanceOf(VaultAlreadyLockedError);
    expect(refusal?.staleHeartbeatOverAlivePid).toBe(false);
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

  it("the snapshot stamp is the lock's own token, and no lock is a hard failure (#280)", () => {
    // the token production stamps into every snapshot is the one the lock
    // file records, read from the lock and not from the caller's memory
    const lock = acquireVaultLock(dir, fastSteal);
    expect(holderToken(lock)).toBe(lock.currentOwner().token);
    lock.release();
    // no lock, no token: the snapshot would be unfenced, which is the hole
    // the fence closes, so this must fail loudly rather than fall back
    expect(() => holderToken(undefined)).toThrow("the vault write stamp ran without a held lock");
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

  it("names the lock file at the post-settle check too, not only the first look (#283)", () => {
    // `acquireVaultLock` classifies the holder twice: before the settle window
    // and again immediately before the rename. Both throws carry the
    // recycled-pid story, so dropping it from the second one would send a botched
    // boot back to "close the other copy" for a pid that looks recycled.
    writeLock({ pid: 4242, host: os.hostname(), heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(), token: "quiet" });
    // first look: gone, so the first check does not throw and the settle window
    // runs; the second look answers alive over the same quiet heartbeat
    let probes = 0;
    const probePid = (): "gone" | "alive" => (probes++ === 0 ? "gone" : "alive");
    const refusal = refusalFrom(() => acquireVaultLock(dir, { ...fastSteal, stealSettleMs: 20, probePid }));
    expect(probes).toBeGreaterThanOrEqual(2);
    expect(refusal).toBeInstanceOf(VaultAlreadyLockedError);
    expect(refusal?.staleHeartbeatOverAlivePid).toBe(true);
    // the record is untouched: the reclaim was abandoned, not raced
    // SAFETY: the test wrote this JSON itself above
    const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { token: string };
    expect(owner.token).toBe("quiet");
  });

  it("reclaims an unreadable lock file instead of blocking forever", () => {
    fs.writeFileSync(lockPath(), "{ not json");
    const lock = acquireVaultLock(dir, { ...fastSteal, onLost: () => undefined });
    expect(lock.currentOwner().pid).toBe(process.pid);
    lock.release();
  });

  it("refuses a reclaim and leaves a live record alone when every read fails with a non-ENOENT errno (#287)", () => {
    const record = JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      heartbeatAt: new Date().toISOString(),
      token: "live-holder",
    });
    fs.writeFileSync(lockPath(), record);
    // the read fails on the record AND on any renamed-aside copy, as a
    // sustained sharing violation does; "no owner" is then unprovable and the
    // reclaim must not touch the file at all
    const restore = spyLockReadFailure((target) => target.startsWith(lockPath()));
    try {
      // every read failed, so no holder can be named: the refusal is the
      // unreadable-lock one, not a claim that an instance holds the folder
      expect(() => acquireVaultLock(dir, fastSteal)).toThrow(VaultLockUnreadableError);
      expect(fs.existsSync(lockPath())).toBe(true);
    } finally {
      restore();
    }
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(record);
    expect(fs.readdirSync(dir).filter((name) => name.includes(".reclaim-"))).toEqual([]);
  });

  it("puts back a renamed-aside record it could not read instead of unlinking it (#287)", () => {
    fs.writeFileSync(lockPath(), "{ not json");
    // the record at vault.lock reads (malformed, so reclaimable), but its
    // renamed-aside copy cannot be read: the reclaim must restore it, never
    // delete an inode it failed to identify
    const restore = spyLockReadFailure((target) => target.includes(".reclaim-"));
    try {
      expect(() => acquireVaultLock(dir, fastSteal)).toThrow(VaultAlreadyLockedError);
    } finally {
      restore();
    }
    expect(fs.readFileSync(lockPath(), "utf8")).toBe("{ not json");
    expect(fs.readdirSync(dir).filter((name) => name.includes(".reclaim-"))).toEqual([]);
  });

  it("withholds a reclaim when a read in the window failed, even if the renamed copy reads (#287)", () => {
    // a live holder that created its record but has not written it yet: the
    // record's own read fails, while the renamed copy reads as an empty
    // (malformed) file. Only the blocked flag stops the unlink
    fs.writeFileSync(lockPath(), "");
    const restore = spyLockReadFailure((target) => target === lockPath());
    try {
      expect(() => acquireVaultLock(dir, fastSteal)).toThrow(VaultLockUnreadableError);
    } finally {
      restore();
    }
    expect(fs.existsSync(lockPath())).toBe(true);
    expect(fs.readdirSync(dir).filter((name) => name.includes(".reclaim-"))).toEqual([]);
  });

  it("keeps refusing a reclaim when the settled read fails once and a later read in the same window reads malformed content (#287)", () => {
    // a holder's record hidden by an intermittent read fault: the first read
    // attempt errors, the retry reads bytes that are not a lock record. If that
    // readable retry cleared `blocked`, this attempt would rename the file
    // aside and unlink it — the eviction #287 exists to stop.
    fs.writeFileSync(lockPath(), "{ still not a lock record");
    const restore = spyLockIntermittentReadFailure((target) => target === lockPath());
    try {
      expect(() => acquireVaultLock(dir, fastSteal)).toThrow(VaultLockUnreadableError);
    } finally {
      restore();
    }
    // not renamed aside, not deleted, not replaced by a fresh acquisition
    expect(fs.readFileSync(lockPath(), "utf8")).toBe("{ still not a lock record");
    expect(fs.readdirSync(dir).filter((name) => name.includes(".reclaim-"))).toEqual([]);
  });

  it("puts back a renamed-aside record whose first read failed and retry read only malformed content (#287)", () => {
    // the record at vault.lock reads (malformed, so reclaimable), but its
    // renamed-aside copy's first read fails while the retry reads malformed
    // bytes: the earlier failure must keep the reclaim from unlinking an inode
    // it could not identify.
    fs.writeFileSync(lockPath(), "{ not json");
    const restore = spyLockIntermittentReadFailure((target) => target.includes(".reclaim-"));
    try {
      expect(() => acquireVaultLock(dir, fastSteal)).toThrow(VaultAlreadyLockedError);
    } finally {
      restore();
    }
    expect(fs.readFileSync(lockPath(), "utf8")).toBe("{ not json");
    expect(fs.readdirSync(dir).filter((name) => name.includes(".reclaim-"))).toEqual([]);
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
    const html = vaultLockRefusalPageHtml(
      heldRefusal({
        pid: 4242,
        host: "shop-pc",
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        token: "t",
      }),
    );
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
    const html = vaultLockRefusalPageHtml(
      heldRefusal({
        pid: 7,
        host: '<img src=x onerror="alert(1)">',
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        token: "t",
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=");
    expect(html).not.toContain("<script");
    // the record is still identified, stripped to the hostname charset
    expect(html).toContain("imgsrcxonerroralert1");
  });

  it("escapes a hostile lock-record host in the stale page too (#283)", () => {
    // The stale template shares `sanitizeHostForDisplay` and `escapeHtml` with
    // the honest one, but nothing pinned that: interpolating the host straight
    // into `staleOwnerTemplate` would keep the honest-page test above green.
    const html = vaultLockRefusalPageHtml(
      heldRefusal(
        {
          pid: 4242,
          host: '<img src=x onerror="alert(1)">',
          startedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          token: "t",
        },
        true,
      ),
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=");
    expect(html).not.toContain("<script");
    // the holder is still named, so escaping is not simply dropping it
    expect(html).toContain("imgsrcxonerroralert1");
    expect(html).toContain("4242");
    expect(html).toContain("vault.lock");
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
    // the summary is deduped, not merely "contains both": a reader that flaps
    // must not repeat a code. Without `seenCodes` this reads
    // "EBUSY, EACCES, EBUSY, EACCES" and over-counts (audit N1).
    const reason = lost[0]!;
    expect(reason.slice(reason.indexOf("(") + 1, reason.indexOf(" after"))).toBe("EBUSY, EACCES");
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
    // NaN is not a budget: it falls back to the default 10 x 100 ms instead of
    // zeroing it OR spinning. The reader never recovers, so the 11th attempt
    // (the default budget) is what ends it; a mutant that lets NaN through has
    // no attempt ceiling and only the 1 s window stops it, thousands of reads
    // later. A reader that recovers on attempt 3 would pass either way. The
    // clock is driven, so the 11 is arithmetic, not the wall (Greptile P2).
    const clock = controlledClock();
    const nan = countingReader(() => {
      throw errno("EBUSY", "EBUSY: resource busy or locked");
    });
    const nanLost: string[] = [];
    const nanLock = acquireVaultLock(dir, {
      transientReadRetries: Number.NaN,
      transientReadRetryDelayMs: Number.NaN,
      now: clock.now,
      sleep: clock.sleep,
      readLockFile: nan.readLockFile,
      logger: nan.logger,
      onLost: (reason) => nanLost.push(reason),
    });
    expect(() => nanLock.assertHeld()).toThrow(VaultLockLostError);
    // the default budget ends the loop at read 11, after ten 100 ms sleeps
    expect(nan.state.readsAtLoss).toBe(11);
    expect(clock.sleeps).toEqual(Array.from({ length: 10 }, () => 100));
    expect(nanLost).toHaveLength(1);
    nanLock.release();

    // -1 truncates to no retries at all: one read, then the loss. Last, because
    // a lock lost this way leaves its file behind for the next boot
    // the NaN half above left its unreadable record at the path; clear it so
    // this acquisition does not spend the read seam reclaiming it first
    fs.rmSync(lockPath(), { force: true });
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
    // Driven clock: eight 100 ms sleeps must fit the one-second window, and on
    // the real clock a pause between them spends the reader's remaining
    // patience, so assertHeld() would throw for a reason that has nothing to do
    // with the budget under test (test-audit F1, Greptile P2).
    const clock = controlledClock();
    const reads = countingReader((lockPath, call) => {
      if (call <= 8) throw errno("EBUSY", "EBUSY: resource busy or locked");
      return realRead(lockPath);
    });
    // the knobs nobody sets: 8 x 100 ms of a scanner holding the file is inside
    // the default patience, where the old 5 x 50 ms budget failed the holder
    // closed on a healthy machine (critic r3-2). 800 of the 1000 ms window is
    // arithmetic on the driven clock, not a race against it.
    const lock = acquireVaultLock(dir, {
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      now: clock.now,
      sleep: clock.sleep,
      onLost: () => undefined,
    });
    try {
      expect(() => lock.assertHeld()).not.toThrow();
      expect(reads.state.reads).toBe(9);
      expect(clock.sleeps).toEqual(Array.from({ length: 8 }, () => 100));
    } finally {
      lock.release();
    }
  });

  it("caps the held sequence at the one-second window even when the attempt ceiling cannot do it", () => {
    // the knobs are legal at their ceilings (100 attempts x 500 ms = 50 s) and
    // the reader never recovers, so only MAX_HELD_RETRY_WINDOW_MS can end this
    // sequence: a mutant that drops the window check alone runs all 101
    // attempts before it loses. The clock is driven, so the same read ends the
    // sequence on any machine (Greptile P2).
    const clock = controlledClock();
    const reads = countingReader(() => {
      throw errno("EBUSY", "EBUSY: resource busy or locked, read 'vault.lock'");
    });
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, {
      transientReadRetries: 10_000,
      transientReadRetryDelayMs: 500,
      now: clock.now,
      sleep: clock.sleep,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      onLost: (reason) => lost.push(reason),
    });
    expect(() => lock.assertHeld()).toThrow(VaultLockLostError);
    // 500 ms, then 500 ms, and the third read is already past the window
    expect(clock.sleeps).toEqual([500, 500]);
    expect(reads.state.readsAtLoss).toBe(3);
    expect(lost).toHaveLength(1);
    lock.release();
  });

  it("caps the number of distinct codes it names in the loss reason", () => {
    // driven clock with a 0 ms delay: time advances one millisecond per ask, so
    // the 101 reads are ended by the attempt ceiling and the window is only the
    // backstop that keeps a ceiling-less mutant from spinning
    const clock = controlledClock();
    const reads = countingReader((_lockPath, call) => {
      // a distinct 40-char code on every read: without a count cap the reason
      // packs one per attempt and reaches kilobytes (code-review finding 2)
      throw errno(`E${String(call).padStart(3, "0")}${"x".repeat(40)}`, "EBUSY: resource busy or locked");
    });
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, {
      transientReadRetries: 100,
      transientReadRetryDelayMs: 0,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      now: clock.now,
      sleep: clock.sleep,
      onLost: (reason) => lost.push(reason),
    });
    expect(() => lock.assertHeld()).toThrow(VaultLockLostError);
    expect(reads.state.readsAtLoss).toBe(101);
    expect(clock.sleeps).toEqual(Array.from({ length: 100 }, () => 0));
    expect(lost).toHaveLength(1);
    // five codes, then a count of the rest: bounded by the cap, not by the
    // 101-attempt ceiling
    expect(lost[0]).toContain("+96 more");
    expect(lost[0]).not.toContain("E101");
    expect(lost[0]!.length).toBeLessThan(600);
  }, 10_000);

  it("bounds the boot-path read attempts even when a knob asks for ten thousand", () => {
    // acquisition reads through the same clamped budget: every readOwner call is
    // capped at 100 retries, so the refusal below is a few hundred reads, not
    // 10 001 per call. #287: every read here fails, so nothing may be renamed
    // aside and the boot refuses rather than unlinking an unattested record
    const reads = countingReader(() => {
      throw errno("EBUSY", "EBUSY: resource busy or locked, read 'vault.lock'");
    });
    fs.writeFileSync(lockPath(), "{ not json");
    const startedAt = Date.now();
    expect(() =>
      acquireVaultLock(dir, {
        readRetries: 10_000,
        readRetryDelayMs: 0,
        stealSettleMs: 1,
        readLockFile: reads.readLockFile,
        logger: reads.logger,
        onLost: () => undefined,
      }),
    ).toThrow(VaultLockUnreadableError);
    expect(reads.state.reads).toBeLessThan(1_000);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    // the refusal renamed nothing: the record is still exactly where it was
    expect(fs.readFileSync(lockPath(), "utf8")).toBe("{ not json");
  }, 10_000);

  it("bounds the boot-path read delay even when a knob asks for five seconds", () => {
    // every readOwner call folds the knob to the 500 ms ceiling, so the refusal
    // path's handful of calls is a few seconds, not 5 s per call. #287: every
    // read fails, so the refusal is the outcome
    const reads = countingReader(() => {
      throw errno("EBUSY", "EBUSY: resource busy or locked, read 'vault.lock'");
    });
    fs.writeFileSync(lockPath(), "{ not json");
    const startedAt = Date.now();
    expect(() =>
      acquireVaultLock(dir, {
        readRetries: 1,
        readRetryDelayMs: 5_000,
        stealSettleMs: 1,
        readLockFile: reads.readLockFile,
        logger: reads.logger,
        onLost: () => undefined,
      }),
    ).toThrow(VaultLockUnreadableError);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(reads.state.reads).toBeLessThan(20);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe("{ not json");
  }, 30_000);

  it("caps the whole retry window even when a knob asks for hours", () => {
    // Driven clock: on the real clock a pause before the third read spends the
    // window and the sequence ends as a loss the test did not ask for
    // (Greptile P2). The sleeps are asserted instead of elapsed wall time.
    const clock = controlledClock();
    const reads = countingReader((lockPath, call) => {
      if (call <= 2) throw errno("EBUSY", "EBUSY: resource busy or locked");
      return realRead(lockPath);
    });
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, {
      transientReadRetries: 10_000,
      transientReadRetryDelayMs: 3_000,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      now: clock.now,
      sleep: clock.sleep,
      onLost: (reason) => lost.push(reason),
    });
    try {
      expect(() => lock.assertHeld()).not.toThrow();
      expect(reads.state.reads).toBe(3);
      // unclamped this is 2 x 3 s; the per-sleep ceiling asks 500 ms twice and
      // the window leaves exactly the second 500 ms, because the whole sequence
      // runs inside the write guard (critic N2). A regression that drops either
      // clamp shows up as a different ask here, not as a slow test.
      expect(clock.sleeps).toEqual([500, 500]);
      expect(lost).toEqual([]);
    } finally {
      lock.release();
    }
  });

  it("caps the attempt ceiling even when a knob asks for ten thousand", () => {
    // driven clock with a 0 ms delay: the window is far away (100 ms of driven
    // time after 100 asks), so the 101st read is ended by the attempt ceiling
    // alone and the count is arithmetic rather than a race (Greptile P2)
    const clock = controlledClock();
    const reads = countingReader(() => {
      throw errno("EBUSY", "EBUSY: resource busy or locked");
    });
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, {
      transientReadRetries: 10_000,
      transientReadRetryDelayMs: 0,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      now: clock.now,
      sleep: clock.sleep,
      onLost: (reason) => lost.push(reason),
    });
    expect(() => lock.assertHeld()).toThrow(VaultLockLostError);
    expect(reads.state.readsAtLoss).toBe(101);
    expect(clock.sleeps).toEqual(Array.from({ length: 100 }, () => 0));
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
    const acquiredHeartbeatAt = lock.currentOwner().heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lost).toEqual([]);
    expect(reads.state.reads).toBeGreaterThan(1);
    // the heartbeat kept writing: the record still names us AND its stamp moved
    // past what acquisition wrote. The token alone would stay green for a
    // holder that recovered from the read error and then stopped refreshing,
    // because acquisition already wrote that token (Greptile P2).
    // SAFETY: the test wrote this JSON itself in acquireVaultLock
    const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { token: string; heartbeatAt: string };
    expect(owner.token).toBe(lock.currentOwner().token);
    expect(Date.parse(owner.heartbeatAt)).toBeGreaterThan(Date.parse(acquiredHeartbeatAt));
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

  it("removes its own abandoned record once reads recover, so the next instance is not blocked (Greptile P1)", async () => {
    // the held-read budget spends transientReadRetries + 1 reads, release spends
    // one more, and the chain's FIRST attempt must fail too: recovery on the
    // first attempt would let a single-attempt chain (no re-arm) pass. Recovery
    // lands on attempt two, so the re-arm is load-bearing here (test-audit P2).
    const failingReads = fastRead.transientReadRetries + 3;
    const reads = countingReader((lockPath, call) => {
      if (call <= failingReads) throw errno("EBUSY", "EBUSY: resource busy or locked, read 'vault.lock'");
      return realRead(lockPath);
    });
    const lost: string[] = [];
    const first = acquireVaultLock(dir, {
      ...fastRead,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      onLost: (reason) => lost.push(reason),
    });
    expect(() => first.assertHeld()).toThrow(VaultLockLostError);
    expect(lost).toHaveLength(1);
    expect(reads.state.readsAtLoss).toBe(fastRead.transientReadRetries + 1);
    // the release read failed too, so the record is still there...
    expect(fs.existsSync(lockPath())).toBe(true);
    // ...but this process stays alive and owes the cleanup, so a later read
    // that succeeds removes its OWN record
    await waitUntil(() => !fs.existsSync(lockPath()));
    expect(fs.existsSync(lockPath())).toBe(false);
    // the first lock was never stopped; a second instance takes the folder now
    const second = acquireVaultLock(dir, { ...fastRead, readLockFile: reads.readLockFile, logger: reads.logger });
    expect(second.currentOwner().pid).toBe(process.pid);
    second.release();
  });

  it("never unlinks a record that comes back naming another owner (Greptile P1)", async () => {
    // The own-record chain is armed because the budget and the release read all
    // failed. Before its first attempt fires, a reclaim of the unreadable record
    // puts a stranger's live record at the path: the chain must leave it alone,
    // or it would delete a live holder's lock and make two writers.
    const failingReads = fastRead.transientReadRetries + 2;
    const reads = countingReader((lockPath, call) => {
      if (call <= failingReads) throw errno("EBUSY", "EBUSY: resource busy or locked, read 'vault.lock'");
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
    expect(lost).toHaveLength(1);
    // "behind the reader's back": the swap happens before the armed chain gets
    // an event-loop turn, so its recovered read is the one that sees the stranger
    writeLock({ host: "shop-pc", pid: 4242, token: "the-new-owner" });
    await waitUntil(() => reads.state.reads > failingReads);
    const readsAtResolution = reads.state.reads;
    // no second attempt: an owner it does not own is an ending, not a retry
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reads.state.reads).toBe(readsAtResolution);
    // the stranger's record is untouched and still names the stranger
    expect(fs.existsSync(lockPath())).toBe(true);
    // SAFETY: the test wrote this JSON itself through writeLock
    const owner = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as { token: string };
    expect(owner.token).toBe("the-new-owner");
  });

  it("logs the record and attempt when the owed release's unlink fails (code-review P3-2)", async () => {
    // A non-ENOENT unlink failure is the exact state this chain exists to
    // surface: a record that should be gone and is not. The read seam hands
    // back our own record after the budget, and the unlink seam fails with
    // EACCES, so the only question is whether the failure reaches the log.
    const failingReads = fastRead.transientReadRetries + 2;
    const reads = countingReader((lockPath, call) => {
      if (call <= failingReads) throw errno("EBUSY", "EBUSY: resource busy or locked, read 'vault.lock'");
      return realRead(lockPath);
    });
    const lost: string[] = [];
    const lock = acquireVaultLock(dir, {
      ...fastRead,
      readLockFile: reads.readLockFile,
      unlinkLockFile: () => {
        throw errno("EACCES", "EACCES: permission denied, unlink 'vault.lock'");
      },
      logger: reads.logger,
      onLost: (reason) => lost.push(reason),
    });
    expect(() => lock.assertHeld()).toThrow(VaultLockLostError);
    expect(lost).toHaveLength(1);
    await waitUntil(() => reads.events.some((line) => line.includes("could not remove")));
    const logged = reads.events.filter((line) => line.includes("could not remove"));
    expect(logged).toHaveLength(1);
    // the record and the attempt both ride in the message
    expect(logged[0]).toContain("VAULT_LOCK_LOST");
    expect(logged[0]).toContain(lockPath());
    expect(logged[0]).toContain("attempt 1");
    expect(logged[0]).toContain("EACCES");
  });

  it("stops the owed-release chain when the record has gone (code-review P3-3)", async () => {
    // The budget and the release read fail, arming the chain. The record is
    // removed before the armed chain gets an event-loop turn, so its recovered
    // read comes back ENOENT ("gone"). Gone is an ending: the chain must stop
    // rather than re-arm on a record that no longer exists.
    const failingReads = fastRead.transientReadRetries + 2;
    const reads = countingReader((lockPath, call) => {
      if (call <= failingReads) throw errno("EBUSY", "EBUSY: resource busy or locked, read 'vault.lock'");
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
    expect(lost).toHaveLength(1);
    // "behind the chain's back": removed before the armed setTimeout runs
    fs.rmSync(lockPath(), { force: true });
    await waitUntil(() => reads.state.reads > failingReads);
    const readsAtResolution = reads.state.reads;
    // nothing left to remove: no re-arm, so the reader is not called again
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(reads.state.reads).toBe(readsAtResolution);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("keeps the one-second budget when the wall clock jumps mid-retry (Greptile P2)", () => {
    // The budget measures ELAPSED time, so this is not an elapsed-time test:
    // the real default clock and sleep drive the loop and only `Date.now` is
    // jumped, from inside the read seam. A forward wall-clock step lands on the
    // second read; the production clock must not read it, or a healthy holder
    // fails closed before its second of patience is up. `options.now` still
    // overrides the source, so the controlledClock tests stay in charge.
    let jumped = false;
    const reads = countingReader((lockPath, call) => {
      if (call === 2) jumped = true;
      if (call <= 5) throw errno("EBUSY", "EBUSY: resource busy or locked, read 'vault.lock'");
      return realRead(lockPath);
    });
    const lock = acquireVaultLock(dir, {
      transientReadRetries: 20,
      transientReadRetryDelayMs: 1,
      readLockFile: reads.readLockFile,
      logger: reads.logger,
      onLost: () => undefined,
    });
    const realDateNow = Date.now;
    const dateSpy = spyOn(Date, "now").mockImplementation(() => (jumped ? realDateNow() + 10 ** 9 : realDateNow()));
    try {
      expect(() => lock.assertHeld()).not.toThrow();
      // every retry ran: the jumped wall clock did not end the sequence
      expect(reads.state.reads).toBe(6);
    } finally {
      dateSpy.mockRestore();
      lock.release();
    }
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

  it("serves the stale-lock page from the catch-all route, not only from the helper (#283)", async () => {
    // the catch-all route is what an owner's browser actually hits, so a
    // dropped `stale` argument would leave the old "close the other copy"
    // advice on screen while the JSON routes and the helper test stayed green
    const suspected = createVaultLockRefusalApp(createAppConfig({}), new VaultAlreadyLockedError(owner, lockPath(), true));
    const suspectedPage = await suspected.fetch(new Request("http://localhost/"));
    expect(suspectedPage.status).toBe(503);
    const suspectedHtml = await suspectedPage.text();
    expect(suspectedHtml).toContain("vault.lock");
    expect(suspectedHtml).toContain("لا تبدو نسخة أخرى من دكان");

    // a live, non-stale holder must not carry the stale instruction, or the
    // stale assertion above would pass on a page that always shows it
    const honest = createVaultLockRefusalApp(createAppConfig({}), new VaultAlreadyLockedError(owner, lockPath()));
    const honestPage = await honest.fetch(new Request("http://localhost/"));
    const honestHtml = await honestPage.text();
    expect(honestHtml).not.toContain("vault.lock");
    expect(honestHtml).toContain("لا تحذف أي ملف");
  });

  it("carries the recycled-pid discriminator on the status route alone (#283)", async () => {
    // a genuine holder: the envelope is exactly the #276 body, so an older web
    // build keeps working
    const honest = createVaultLockRefusalApp(createAppConfig({}), new VaultAlreadyLockedError(owner, lockPath()));
    const honestStatus = await honest.fetch(new Request("http://localhost/api/vault/status"));
    expect(await honestStatus.json()).toEqual({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE" } });

    // a suspected recycled pid: the same code plus the story, on the route the
    // app calls; /health stays a plain refusal
    const suspected = createVaultLockRefusalApp(createAppConfig({}), new VaultAlreadyLockedError(owner, lockPath(), true));
    const suspectedStatus = await suspected.fetch(new Request("http://localhost/api/vault/status"));
    expect(await suspectedStatus.json()).toEqual({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE", staleHeartbeat: true } });
    const suspectedHealth = await suspected.fetch(new Request("http://localhost/health"));
    expect(await suspectedHealth.json()).toEqual({ ok: false, error: "VAULT_LOCKED_BY_OTHER_INSTANCE" });
  });

  it("names the lock file on the recycled-pid page and keeps the honest page intact (#283)", () => {
    const suspected = vaultLockRefusalPageHtml(heldRefusal(owner, true));
    expect(suspected).toContain("vault.lock");
    expect(suspected).toContain("لا تبدو نسخة أخرى من دكان");
    expect(suspected).toContain("shop-pc");
    expect(suspected).toContain("4242");
    expect(suspected).not.toContain("لا تحذف أي ملف");
    // the honest page keeps its story, whose hint asks for no file deletion
    const honest = vaultLockRefusalPageHtml(heldRefusal(owner));
    expect(honest).toContain("البيانات مفتوحة في نسخة أخرى");
    expect(honest).toContain("لا تحذف أي ملف");
    expect(honest).not.toContain("vault.lock");
  });

  it("names the lock file on the unreadable page and asks for no instance that does not exist (#287)", async () => {
    // the state the code-review lens found: the file is there, no read could
    // attest to it, so no holder can be named. The held page would tell the
    // owner to close a copy that is not running and to delete no file, which
    // leaves no way out at all.
    const path = lockPath();
    const error = new VaultLockUnreadableError(path, "EBUSY");
    const page = vaultLockRefusalPageHtml({ kind: "unreadable", lockPath: path });
    expect(page).toContain(path);
    expect(page).toContain("تعذّر قراءة ملف القفل");
    // the one exit is deleting that single file, so the blanket ban must be gone
    expect(page).not.toContain("لا تحذف أي ملف");
    expect(page).toContain("احذف ملف vault.lock وحده");
    // and it must not claim a copy holds the folder
    expect(page).not.toContain("البيانات مفتوحة في نسخة أخرى");
    // the app's JSON route stays the honest code with no stale flag: an
    // unreadable file is not a recycled pid
    const app = createVaultLockRefusalApp(createAppConfig({}), error);
    const status = await app.fetch(new Request("http://localhost/api/vault/status"));
    expect(status.status).toBe(503);
    expect(await status.json()).toEqual({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE" } });
    const html = await app.fetch(new Request("http://localhost/"));
    expect(await html.text()).toContain(path);
  });

  it("tells the owner the instance takes the folder by itself instead of asking for a restart (#298)", () => {
    // The sentence #277 exists to delete. The refused start now takes the
    // folder as soon as the other copy closes (lib/vault/reclaim-retry.ts), so
    // "close the other copy and reopen the app" sends the owner through a
    // restart the instance has already removed. All three held variants carry
    // it: a named holder, a suspected recycled pid, and no record at all.
    const honest = vaultLockRefusalPageHtml(heldRefusal(owner));
    const stale = vaultLockRefusalPageHtml(heldRefusal(owner, true));
    const unknown = vaultLockRefusalPageHtml(heldRefusal(undefined));
    for (const page of [honest, stale, unknown]) {
      expect(page).not.toContain("ثم أعد فتح التطبيق");
      expect(page).toContain("من تلقاء نفسها");
    }
    // and the instructions that still apply survive the rewrite
    expect(honest).toContain("لا تحذف أي ملف");
    expect(stale).toContain("vault.lock");
  });

  it("keeps the reopen instruction on the unreadable page, which no loop clears (#298)", () => {
    // The deliberate opposite of the test above, so a blanket rewrite cannot
    // pass both. An unreadable lock file starts no retry loop at boot (#287)
    // and stops the one that meets it later (main.ts), so nothing on this page
    // may promise a self-take: the file has to go and the app has to restart.
    const page = vaultLockRefusalPageHtml({ kind: "unreadable", lockPath: "/data/vault.lock" });
    expect(page).toContain("أعد فتح التطبيق");
    expect(page).not.toContain("من تلقاء نفسها");
  });

  it("refreshes the held page so it recovers once the folder is free (#298)", () => {
    // The refusal page is the whole screen in the packaged app: the shell loads
    // the sidecar's own origin and never the SPA, so a static page means the
    // instance heals while the screen keeps showing the refusal until the owner
    // reloads by hand. A meta refresh is the one control that needs no script
    // and no second route.
    //
    // It is NOT on the unreadable page: that story has no loop (main.ts stops
    // one that meets an unreadable file), so the reload could never change what
    // the owner reads and would be a request every five seconds for nothing.
    for (const page of [
      vaultLockRefusalPageHtml(heldRefusal(owner)),
      vaultLockRefusalPageHtml(heldRefusal(owner, true)),
      vaultLockRefusalPageHtml(heldRefusal(undefined)),
    ]) {
      // SAFETY: the regex asserts the attribute shape; a miss fails below
      const meta = /<meta http-equiv="refresh" content="(\d+)">/.exec(page);
      expect(meta).not.toBeNull();
      const seconds = Number(meta?.[1]);
      // quick enough that the vault shows up a few seconds after the folder
      // frees, slow enough that a page left open all day is not a request loop
      expect(seconds).toBeGreaterThanOrEqual(1);
      expect(seconds).toBeLessThanOrEqual(10);
    }
    expect(vaultLockRefusalPageHtml({ kind: "unreadable", lockPath: "/data/vault.lock" })).not.toContain(
      'http-equiv="refresh"',
    );
  });

  it("escapes a hostile lock path before it reaches the unreadable page (#287)", () => {
    const hostile = { kind: "unreadable", lockPath: '/data/<script>alert("x")</script>/vault.lock' } as const;
    const page = vaultLockRefusalPageHtml(hostile);
    expect(page).not.toContain("<script>");
    expect(page).toContain("&lt;script&gt;");
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
