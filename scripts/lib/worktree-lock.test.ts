/**
 * Tests for the base worktree lock.
 *
 * Three properties decide whether a stale lock may be removed, and each one has
 * a test here that fails when the property goes:
 *
 *   1. a live lock cannot be moved — a reclaimer holding an observation of a
 *      lock that is already gone leaves the lock that took the name alone;
 *   2. a replacement cannot be removed — the removal is bound to the directory
 *      that was observed, not to the name, so a directory that took the name
 *      with an identical pid file survives it;
 *   3. two reclaimers cannot both enter — the claim inside the lock has exactly
 *      one winner, and the two-process case proves it with two real processes.
 *
 * The rest of the suite is the rounds that produced those rules: the pid file's
 * format, the token that tells two locks with one pid apart, the identity that
 * tells two directories with one pid file apart, the claim left behind by a dead
 * reclaimer, and the wait budget a waiter derives from the holder's own file
 * count. They are grouped by the round that added them, so a reader can find the
 * finding each one answers.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { INSTALL_TIMEOUT_MS, LOCK_WAIT_SLACK_MS, testTimeoutMs } from "./gate-limits";
import {
  clearDeadClaim,
  effectiveWaitDeadline,
  lockContentionMessage,
  lockHolderIsGone,
  lockPidFileContent,
  lockWaitBudget,
  observeLockHolder,
  RECLAIM_CLAIM_FILE,
  reclaimStaleLock,
  releaseWorktreeLock,
  type LockIdentity,
} from "./worktree-lock";

/** The module the two-process fixture's children import. */
const LOCK_MODULE = pathToFileURL(join(import.meta.dir, "worktree-lock.ts")).href;

describe("the lock's three properties", () => {

  test("a live lock cannot be moved: another reclaimer cannot remove the lock the first reclaimer took", () => {
    // The deterministic core of the finding, without a race: both waiters read
    // the same stale lock, the first reclaims and takes the name with its own
    // token, and the second now holds an observation of a lock that is no
    // longer there. Its reclaim may not delete what the name holds.
    const roundDir = mkdtempSync(join(tmpdir(), "ronp-reclaim-"));
    const lockPath = join(roundDir, "wt.lock");
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "pid"), lockPidFileContent(2_147_483_647, "dead-token", 1));
      const stale = observeLockHolder(lockPath);
      expect(stale.kind).toBe("holder");
      // The first waiter reclaims and takes the lock exactly as the gate does.
      expect(reclaimStaleLock(lockPath, stale)).toBe("reclaimed");
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "pid"), lockPidFileContent(process.pid, "live-token", 1));
      expect(reclaimStaleLock(lockPath, stale)).toBe("refused");
      expect(readFileSync(join(lockPath, "pid"), "utf8")).toContain("live-token");
    } finally {
      rmSync(roundDir, { recursive: true, force: true });
    }
  });

  test("a replacement cannot be removed: the reclaim is bound to the directory it observed", () => {
    // The claim can be taken inside a different directory than the one the
    // caller observed, so the removal is bound to the directory's identity and
    // not to the name. This replacement carries the observation's own pid file —
    // the one shape a content check calls identical — so only the identity can
    // tell the two directories apart. Red before the binding: the reclaim
    // renamed and deleted the replacement.
    const dir = mkdtempSync(join(tmpdir(), "ronp-lock-"));
    const lockPath = join(dir, "wt.lock");
    const pidFile = lockPidFileContent(2_147_483_647, "stale-token", 0);
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), pidFile);
    try {
      const observed = observeLockHolder(lockPath);
      expect(observed.kind).toBe("holder");
      // The replacement is created beside the lock and renamed into place, and
      // the original is renamed aside rather than deleted. A `mkdir` after an
      // `rm` can reuse the deleted directory's `dev`, `ino` and `birthtimeMs` —
      // that happened on Bun 1.4.3 — and then the identity check calls the
      // replacement the same object and the reclaim succeeds, which is the
      // failure this test exists to catch. Two directories that both exist
      // cannot share an identity, so the rename keeps them distinct.
      const replacement = join(dir, "wt.replacement");
      mkdirSync(replacement);
      writeFileSync(join(replacement, "pid"), pidFile);
      renameSync(lockPath, join(dir, "wt.displaced"));
      renameSync(replacement, lockPath);
      // The fixture has to present a different object, or the assertion below
      // passes for the wrong reason and the test stops proving the binding.
      const now = statSync(lockPath);
      expect([now.dev, now.ino]).not.toEqual([observed.identity?.dev, observed.identity?.ino]);
      expect(reclaimStaleLock(lockPath, observed)).toBe("refused");
      expect(readFileSync(join(lockPath, "pid"), "utf8")).toBe(pidFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two reclaimers cannot both enter: a live claim has exactly one winner, so a second reclaimer cannot remove a stale lock another reclaimer is removing", () => {
    // Two runs read the same dead pid and both went on to remove it, so one
    // replaced the directory and started work while the other deleted the live
    // lock it had just taken. Recovery is exclusive now: a reclaimer takes a
    // claim inside the lock with `wx`, and exactly one caller can win that
    // create. Red before the claim existed — the second reclaimer reported
    // `reclaimed` and the lock was gone.
    const dir = mkdtempSync(join(tmpdir(), "ronp-lock-"));
    const lockPath = join(dir, "wt.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), lockPidFileContent(2_147_483_647, "stale-token", 0));
    try {
      const observed = observeLockHolder(lockPath);
      expect(observed.kind).toBe("holder");
      // The first reclaimer's claim, taken and still held by a live process.
      writeFileSync(
        join(lockPath, RECLAIM_CLAIM_FILE),
        lockPidFileContent(process.pid, "first-reclaimer", 0),
      );
      expect(reclaimStaleLock(lockPath, observed)).toBe("refused");
      expect(existsSync(join(lockPath, "pid"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two processes reclaiming one stale lock cannot both enter", async () => {
    // The same thing with two real processes, which is the only shape that
    // settles an argument about an interleaving: both read the stale lock
    // before either reclaims, the first takes it, and the second reclaims with
    // its old observation. With a reclaim that renames and deletes by name the
    // second removed the first's live lock, both took the name, and both judged
    // one worktree.
    const script = writeLockRaceChild();
    for (let round = 0; round < 3; round += 1) {
      const roundDir = mkdtempSync(join(tmpdir(), "ronp-race-"));
      const lockPath = join(roundDir, "wt.lock");
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "pid"), lockPidFileContent(2_147_483_647, "dead-token", 1));
      const started = await Promise.all([
        runLockChild(script, lockPath, "a", roundDir),
        runLockChild(script, lockPath, "b", roundDir),
      ]);
      const read = (name: string): string => readFileSync(join(roundDir, name), "utf8").trim();
      try {
        expect(started.map((run) => run.status)).toEqual([0, 0]);
        // Both acted on the stale lock, or the fixture tested nothing.
        expect(read("a.observed")).toBe("holder");
        expect(read("b.observed")).toBe("holder");
        expect(read("a.outcome")).toBe("reclaimed");
        expect(read("b.outcome")).toBe("refused");
        // The holder kept its own lock for the whole hold, and the second
        // process never entered beside it.
        expect(read("a.hold")).toBe("HOLD-OK");
        expect(existsSync(join(roundDir, "b.entered"))).toBe(false);
      } finally {
        rmSync(roundDir, { recursive: true, force: true });
      }
    }
    rmSync(script, { force: true });
  }, 60_000);
});

describe("red-on-parent round 5 — the defects no earlier round named", () => {
  test("a lock with no pid is reclaimed once it is older than the grace", () => {
    // A crash between taking the lock and writing its pid used to leave a lock
    // nothing could reclaim: "no pid" read as "holder alive", so every later
    // run waited its whole budget (11 minutes) and refused, forever.
    const lockPath = mkdtempSync(join(tmpdir(), "ronp-lock-"));
    try {
      expect(lockHolderIsGone(lockPath)).toBe(false);
      const stale = new Date(Date.now() - 60_000);
      utimesSync(lockPath, stale, stale);
      expect(lockHolderIsGone(lockPath)).toBe(true);
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  });
});

describe("red-on-parent round 9 — the lock", () => {
  test("a vanished lock is not-gone and does not throw", () => {
    // The pid file's existence and its read are not atomic, and a release can
    // remove the directory in between. `acquireWorktreeLock` only catches
    // EEXIST, so an unguarded read threw ENOENT out of runGate and killed the
    // run with a stack trace instead of retrying.
    const lockDir = mkdtempSync(join(tmpdir(), "ronp-lock-"));
    const lockPath = join(lockDir, "gone.lock");
    try {
      expect(() => lockHolderIsGone(lockPath)).not.toThrow();
      expect(lockHolderIsGone(lockPath)).toBe(false);
      expect(observeLockHolder(lockPath).kind).toBe("alive");
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  test("a stale unclaimed lock is reclaimed", () => {
    const lockDir = mkdtempSync(join(tmpdir(), "ronp-lock-"));
    const lockPath = join(lockDir, "wt.lock");
    try {
      mkdirSync(lockPath);
      const stale = new Date(Date.now() - 60_000);
      utimesSync(lockPath, stale, stale);
      const observed = observeLockHolder(lockPath);
      expect(observed.kind).toBe("unclaimed");
      reclaimStaleLock(lockPath, observed);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  test("reclaiming does not delete a live lock another waiter already took", () => {
    // Two waiters read the same dead pid; the first reclaims and takes the lock
    // with its own pid file. The second, holding its earlier observation, may
    // not delete what the name holds.
    const lockDir = mkdtempSync(join(tmpdir(), "ronp-lock-"));
    const lockPath = join(lockDir, "wt.lock");
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "pid"), lockPidFileContent(2_147_483_647, "dead-token", 1));
      const observed = observeLockHolder(lockPath);
      expect(observed.kind).toBe("holder");
      expect(reclaimStaleLock(lockPath, observed)).toBe("reclaimed");
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "pid"), lockPidFileContent(process.pid, "live-token", 1));
      expect(reclaimStaleLock(lockPath, observed)).toBe("refused");
      expect(existsSync(join(lockPath, "pid"))).toBe(true);
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });
});

describe("red-on-parent round 10 — the findings at 5ab9a2c4", () => {
  test("the lock wait budget covers both runs of every file", () => {
    // The holder runs each file on the parent side and again on the change side,
    // and the lock covers both. A budget of one run per file expires while the
    // holder is still inside its second, and the waiter is then refused for
    // waiting on work that is still in progress. The absolute value pins the
    // install and the slack as well as the slope.
    const saved = process.env.RED_ON_PARENT_LOCK_WAIT_MS;
    // An ambient override would decide the first two assertions, so it is out
    // of the way for the whole test and put back afterwards.
    delete process.env.RED_ON_PARENT_LOCK_WAIT_MS;
    try {
      expect(lockWaitBudget(2) - lockWaitBudget(1)).toBe(2 * testTimeoutMs());
      expect(INSTALL_TIMEOUT_MS).toBe(600_000);
      expect(LOCK_WAIT_SLACK_MS).toBe(60_000);
      expect(lockWaitBudget(3)).toBe(
        INSTALL_TIMEOUT_MS + 3 * 2 * testTimeoutMs() + LOCK_WAIT_SLACK_MS,
      );
      process.env.RED_ON_PARENT_LOCK_WAIT_MS = "1234";
      expect(lockWaitBudget(3)).toBe(1234);
      // An override that is not a number, or is not positive, is no override:
      // the formula decides, or a waiter would wait for the wrong time.
      for (const bad of ["abc", "0", "-5"]) {
        process.env.RED_ON_PARENT_LOCK_WAIT_MS = bad;
        expect(lockWaitBudget(3)).toBe(
          INSTALL_TIMEOUT_MS + 3 * 2 * testTimeoutMs() + LOCK_WAIT_SLACK_MS,
        );
      }
    } finally {
      if (saved === undefined) delete process.env.RED_ON_PARENT_LOCK_WAIT_MS;
      else process.env.RED_ON_PARENT_LOCK_WAIT_MS = saved;
    }
  });
});

describe("red-on-parent round 12 — the findings at 8a618ed9", () => {
  test("a reclaim that judged a dead pid does not touch the lock that took it", () => {
    // The pid is not an identity. The operating system hands a dead holder's
    // pid to a later process, so the pid file of a *live* lock can read
    // exactly like the dead one this run judged stale. The reclaim compared
    // pids alone, so it renamed that live lock away and deleted it — and both
    // runs then held "the lock" and shared one worktree. The token in the pid
    // file is what tells the two locks apart.
    const lockDir = mkdtempSync(join(tmpdir(), "ronp-lock-"));
    const lockPath = join(lockDir, "wt.lock");
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "pid"), "999999 stale-token\n");
      const observed = observeLockHolder(lockPath);
      expect(observed.kind).toBe("holder");

      // The first reclaimer takes the stale lock, and a later run takes the
      // name with the same pid and a different token. The operating system
      // handing a dead holder's pid out again is what that looks like from
      // here, and this fixture does not recreate the live half of it — 999999
      // is not a running process. What it does recreate is what the code
      // reads: the pid alone cannot tell the two locks apart, and the token
      // can.
      expect(reclaimStaleLock(lockPath, observed)).toBe("reclaimed");
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "pid"), "999999 live-token\n");

      // The second reclaimer, holding the same earlier observation, must leave
      // the lock that took the name exactly where it is. It is not even moved:
      // moving it would take it out from under the run that holds it, and the
      // restore only puts it back while the name is free.
      expect(reclaimStaleLock(lockPath, observed)).toBe("refused");
      expect(existsSync(join(lockPath, "pid"))).toBe(true);
      expect(readFileSync(join(lockPath, "pid"), "utf8")).toContain("live-token");
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  test("a live claim that took the name while a dead one was being cleared is put back", () => {
    // The `wx` create is the exclusivity, but a rename proves only that one run
    // moved a name. A reclaimer that already cleared the dead claim can create
    // its own live one between this run's read and its rename, and a blind
    // rename then carries that away and unlinks it: the owner believes it still
    // holds the claim, a second run takes the name, and both enter the
    // worktree. The moved file must still read as the bytes that were observed.
    const dir = mkdtempSync(join(tmpdir(), "ronp-claim-"));
    const lockPath = join(dir, "wt.lock");
    mkdirSync(lockPath);
    const claimPath = join(lockPath, RECLAIM_CLAIM_FILE);
    const deadRaw = lockPidFileContent(2_147_483_647, "dead-claim-token", 0);
    const liveRaw = lockPidFileContent(process.pid, "live-claim-token", 0);
    writeFileSync(claimPath, liveRaw);
    try {
      // this run read the DEAD bytes a moment ago and now tries to clear them
      expect(clearDeadClaim(claimPath, deadRaw)).toBe(false);
      // the live claim is back where its owner expects it, not deleted
      expect(readFileSync(claimPath, "utf8")).toBe(liveRaw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a claim that still reads as the observed dead one is cleared", () => {
    const dir = mkdtempSync(join(tmpdir(), "ronp-claim-"));
    const lockPath = join(dir, "wt.lock");
    mkdirSync(lockPath);
    const claimPath = join(lockPath, RECLAIM_CLAIM_FILE);
    const deadRaw = lockPidFileContent(2_147_483_647, "dead-claim-token", 0);
    writeFileSync(claimPath, deadRaw);
    try {
      expect(clearDeadClaim(claimPath, deadRaw)).toBe(true);
      expect(existsSync(claimPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a claim left behind by a dead reclaimer does not block the reclaim", () => {
    // Recovery is exclusive because a reclaimer takes a claim inside the lock
    // before it removes anything, and a claim whose writer was killed between
    // claiming and removing would block every later run on this lock forever.
    // A dead claim is cleared by renaming it — one winner — and the mover has to
    // win the name back before it may proceed. This pins that recovery: without
    // it the reclaim refuses and the lock outlives every run that wants it.
    const dir = mkdtempSync(join(tmpdir(), "ronp-lock-"));
    const lockPath = join(dir, "wt.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), lockPidFileContent(2_147_483_647, "stale-token", 0));
    writeFileSync(
      join(lockPath, RECLAIM_CLAIM_FILE),
      lockPidFileContent(2_147_483_647, "dead-claim-token", 0),
    );
    try {
      const observed = observeLockHolder(lockPath);
      expect(observed.kind).toBe("holder");
      expect(reclaimStaleLock(lockPath, observed)).toBe("reclaimed");
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a claim with no readable owner is only cleared once it is old", () => {
    // The other half of the same recovery: a claim file whose writer died before
    // it wrote its pid. Only age is evidence, exactly as for a lock directory in
    // that state — clearing a fresh empty claim would let two reclaimers run at
    // once in the window between a live reclaimer's create and its write.
    const dir = mkdtempSync(join(tmpdir(), "ronp-lock-"));
    const lockPath = join(dir, "wt.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), lockPidFileContent(2_147_483_647, "stale-token", 0));
    writeFileSync(join(lockPath, RECLAIM_CLAIM_FILE), "");
    try {
      const observed = observeLockHolder(lockPath);
      expect(reclaimStaleLock(lockPath, observed)).toBe("refused");
      expect(existsSync(join(lockPath, "pid"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("red-on-parent round 15 — the edge-audit findings at 8a618ed9", () => {
  test("the holder's pid file says how many files it is judging", () => {
    // The pid alone is not an identity, and the file count is what a waiter
    // needs: the lock may be held by a run that judges twenty files while the
    // waiter judges one.
    const dir = mkdtempSync(join(tmpdir(), "ronp-lock-"));
    const lockPath = join(dir, "wt.lock");
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "pid"), `999999 token-abc 20\n`);
      const observed = observeLockHolder(lockPath);
      expect(observed.kind).toBe("holder");
      expect(observed.kind === "holder" ? observed.fileCount : 0).toBe(20);
      // A lock written before the count existed has none, and a waiter that
      // cannot see it waits for its own guess.
      writeFileSync(join(lockPath, "pid"), `999999 token-abc\n`);
      const older = observeLockHolder(lockPath);
      expect(older.kind === "holder" ? older.fileCount : 0).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a waiter waits for the holder's own work", () => {
    const savedWait = process.env.RED_ON_PARENT_LOCK_WAIT_MS;
    const savedTimeout = process.env.RED_ON_PARENT_TEST_TIMEOUT_MS;
    delete process.env.RED_ON_PARENT_LOCK_WAIT_MS;
    delete process.env.RED_ON_PARENT_TEST_TIMEOUT_MS;
    try {
      const now = Date.now();
      const observed = { kind: "holder", pid: 999999, token: "t", fileCount: 20 } as const;
      // The holder's twenty files are twenty files' worth of waiting, even
      // though the waiter itself judges one.
      expect(effectiveWaitDeadline(now + 1_000, observed, now)).toBeGreaterThan(
        now + 20 * 2 * testTimeoutMs(),
      );
      // A lock that says nothing about its work does not move the deadline.
      expect(effectiveWaitDeadline(now + 1_000, { kind: "alive" }, now)).toBe(now + 1_000);
      expect(
        effectiveWaitDeadline(now + 1_000, { kind: "holder", pid: 1 }, now),
      ).toBe(now + 1_000);
      // The message says what the holder is doing, so a waiter that gave up
      // does not read a live holder as an idle one.
      const message = lockContentionMessage("/tmp/wt.lock", observed);
      expect(message).toContain("another red-on-parent run is using /tmp/wt.lock");
      expect(message).toContain("it says it is judging 20 files");
    } finally {
      if (savedWait === undefined) delete process.env.RED_ON_PARENT_LOCK_WAIT_MS;
      else process.env.RED_ON_PARENT_LOCK_WAIT_MS = savedWait;
      if (savedTimeout === undefined) delete process.env.RED_ON_PARENT_TEST_TIMEOUT_MS;
      else process.env.RED_ON_PARENT_TEST_TIMEOUT_MS = savedTimeout;
    }
  });
});

describe("red-on-parent round 16 — the standards-review findings at 8a618ed9", () => {
  test("the holder's pid file says how many files it is judging", () => {
    // The pid file is how a waiter learns what the holder is doing, and the
    // file count is the only part of it the holder can be behind on. The
    // format is pinned here because the reader parses it: a waiter that
    // cannot read the count waits for its own guess instead of the holder's
    // work.
    expect(lockPidFileContent(4242, "token-abc", 7)).toBe("4242 token-abc 7\n");
  });
});

describe("red-on-parent round 19 — the Greptile findings at 4c689c95", () => {
  test("a refused reclaim gives its claim back", () => {
    // The claim is the serialization, so a reclaimer that walks away from a
    // refusal and leaves its claim behind would block every later run on this
    // lock. The observation here names another directory holding the same dead
    // pid file, so the reclaim is refused after the claim is taken; the next
    // reclaim of the lock it really observed has to succeed.
    const dir = mkdtempSync(join(tmpdir(), "ronp-lock-"));
    const lockPath = join(dir, "wt.lock");
    const otherDir = mkdtempSync(join(tmpdir(), "ronp-lock-"));
    const otherPath = join(otherDir, "wt.lock");
    const pidFile = lockPidFileContent(2_147_483_647, "stale-token", 0);
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "pid"), pidFile);
    mkdirSync(otherPath);
    writeFileSync(join(otherPath, "pid"), pidFile);
    try {
      const other = observeLockHolder(otherPath);
      expect(other.kind).toBe("holder");
      expect(reclaimStaleLock(lockPath, other)).toBe("refused");
      expect(existsSync(join(lockPath, RECLAIM_CLAIM_FILE))).toBe(false);
      expect(reclaimStaleLock(lockPath, observeLockHolder(lockPath))).toBe("reclaimed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

describe("red-on-parent round 20 — the Greptile findings at e1ea567c", () => {
  /** A directory's identity, read the way the lock reads it. */
  function identityOf(path: string): LockIdentity {
    const stats = statSync(path);
    return { dev: stats.dev, ino: stats.ino, birthMs: stats.birthtimeMs };
  }

  test("a release cannot remove a lock that took the name with an identical pid file", () => {
    // The release is the second of the two places a lock directory is removed,
    // and it decided on the pid file's content alone. Content is the one thing a
    // replacement reproduces: a run that takes the name after this lock was
    // reclaimed writes its own pid file, and a release that compared content
    // deleted the live lock of the run holding the name now — so the name was
    // free again while two runs judged one worktree. The replacement here is a
    // different directory, not the same name re-created, so only the identity
    // can tell them apart.
    const dir = mkdtempSync(join(tmpdir(), "ronp-lock-"));
    const lockPath = join(dir, "wt.lock");
    const token = "this-runs-token";
    const pidFile = lockPidFileContent(process.pid, token, 2);
    try {
      mkdirSync(lockPath);
      const identity = identityOf(lockPath);
      writeFileSync(join(lockPath, "pid"), pidFile);
      // The run holding the name now: same pid file, different directory.
      const replacement = join(dir, "replacement");
      mkdirSync(replacement);
      writeFileSync(join(replacement, "pid"), pidFile);
      rmSync(lockPath, { recursive: true, force: true });
      renameSync(replacement, lockPath);
      expect(releaseWorktreeLock(lockPath, token, identity)).toBe(false);
      expect(readFileSync(join(lockPath, "pid"), "utf8")).toBe(pidFile);
      // And the release still takes away the directory it actually created: a
      // guard that refused everything would pin the removal shut instead.
      expect(releaseWorktreeLock(lockPath, token, identityOf(lockPath))).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
/**
 * The two-process lock fixture's child.
 *
 * Both children read the stale lock before either reclaims, and the second one
 * waits until the first has taken the name, so the state the finding describes
 * is reached every run instead of once in a hundred. The child then takes the
 * lock the way the acquire does and says whether it kept it: `HOLD-LOST` when its
 * own pid file is gone or replaced, `OVERLAP` when the other process entered
 * beside it.
 */
function writeLockRaceChild(): string {
  const script = String.raw`
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { observeLockHolder, reclaimStaleLock } from "__GATE__";

const lockPath = process.argv[2];
const tag = process.argv[3];
const roundDir = process.argv[4];
const other = tag === "a" ? "b" : "a";

const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (path) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    wait(10);
  }
  return false;
};

const observed = observeLockHolder(lockPath);
writeFileSync(join(roundDir, tag + ".observed"), observed.kind);
waitFor(join(roundDir, "a.observed"));
waitFor(join(roundDir, "b.observed"));

if (tag === "b") {
  waitFor(join(roundDir, "a.entered"));
  wait(20);
}

const outcome = reclaimStaleLock(lockPath, observed);
writeFileSync(join(roundDir, tag + ".outcome"), outcome);
if (outcome !== "reclaimed") process.exit(0);

mkdirSync(lockPath);
writeFileSync(join(lockPath, "pid"), process.pid + " " + tag + " 1\n");
writeFileSync(join(roundDir, tag + ".entered"), "1");
wait(200);
let hold = "HOLD-OK";
if (existsSync(join(roundDir, other + ".entered"))) hold = "OVERLAP";
try {
  if (!readFileSync(join(lockPath, "pid"), "utf8").includes(" " + tag + " ")) hold = "HOLD-LOST";
} catch {
  hold = "HOLD-LOST";
}
writeFileSync(join(roundDir, tag + ".hold"), hold);
rmSync(lockPath, { recursive: true, force: true });
`;
  const dir = mkdtempSync(join(tmpdir(), "ronp-child-"));
  const path = join(dir, "lock-child.ts");
  writeFileSync(path, script.replace("__GATE__", LOCK_MODULE));
  return path;
}

function runLockChild(
  script: string,
  lockPath: string,
  tag: string,
  roundDir: string,
): Promise<{ status: number | null; output: string }> {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [script, lockPath, tag, roundDir]);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("close", (status) => settle({ status, output }));
  });
}
