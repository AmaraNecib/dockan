/**
 * The base worktree lock: who may hold it, and how a dead holder is removed
 * without deleting a live one.
 *
 * Two invocations from the same checkout and the same base copy their added
 * files into the same cached worktree, and `--fresh` deletes the directory the
 * other run is testing in. The lock directory is the atomic acquire available
 * on both platforms (`mkdir` fails with EEXIST, unlike a test-then-write).
 *
 * ## The charter
 *
 * Two properties have to hold whenever a stale lock is removed, and neither is
 * enough alone.
 *
 * **Recovery is exclusive.** The removal is one `rmSync` of one name, and two
 * runs that read the same dead pid would both reach it: one replaces the
 * directory and starts work, the other deletes the live lock it just took. So a
 * reclaimer claims a generation inside the directory with `wx` before it removes
 * anything, and exactly one caller can win that create. The generation is marked
 * released when the lock is left alone, and it goes with the directory when the
 * removal succeeds.
 *
 * **The removal is bound to the observed object.** The claim can be taken
 * inside a *different* directory than the one observed: between the caller's
 * observation and the claim, another run can remove the stale lock and take the
 * name with a live one. Removing by name after that deletes a live run's lock,
 * and that run then writes its pid file into a directory that is no longer at
 * the name — so the lock is gone but two runs still hold the worktree. The
 * directory's identity is therefore compared with the identity captured in the
 * observation, and the evidence re-read, before anything is removed.
 *
 * Those two guards together are why the three reported findings are one defect.
 * With recovery exclusive there is no second reclaimer to race at all, and with
 * the removal bound to the identity the one window left — the lock replaced
 * under the claim — can only ever refuse. There is no per-call-site check to
 * forget, because there is one removal and it is guarded by both.
 *
 * **The release is the second removal, and it is bound the same way.** A run
 * removes only the lock it took: `releaseWorktreeLock` compares the token it
 * wrote *and* the object it wrote it into, before it reads anything. The token
 * alone names the pid file's content, and content is the one thing a
 * replacement can reproduce: a directory that took the name after this run's
 * lock was reclaimed can carry a pid file that reads identically, and a release
 * comparing content alone then deletes the live lock of the run that holds the
 * name now. One rule for both removals, and no per-call-site check to forget.
 *
 * A claim generation is never replaced, moved or deleted to take the claim,
 * which is what keeps every claim name occupied for as long as the lock
 * exists: a dead generation stays where it is and the next run supersedes it
 * with a higher number, and the run that won a generation can still prove it
 * owns it at the removal. Replacing a claim instead is what let a third run
 * create its own in the gap a rename left behind, and two runs then removed one
 * lock.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { GateError } from "./gate-error";
import { INSTALL_TIMEOUT_MS, LOCK_WAIT_SLACK_MS, testTimeoutMs } from "./gate-limits";

const LOCK_RETRY_MS = 250;
/**
 * How long a lock directory may exist without its pid file before it is read as
 * abandoned. The pid is written immediately after `mkdirSync` takes the lock, so
 * anything older than this lost the writer in that window.
 */
const LOCK_PID_GRACE_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A directory's identity, which its name does not carry.
 *
 * A reclaim deletes a *directory*, and the only thing standing between it and
 * the wrong directory is a name another run can reuse the instant the name is
 * freed. `dev`/`ino` name the object rather than the name, and `birthMs` covers
 * the one case inode numbering hands a fresh directory the number its
 * predecessor had: the three together are what a successor cannot share with
 * the directory it replaced.
 */
export type LockIdentity = { dev: number; ino: number; birthMs: number };

/**
 * What a lock directory says about its holder, and how strongly.
 *
 * `holder` names a pid whose process is gone (ESRCH). `unclaimed` is a
 * directory with no pid file that is older than the grace: the only evidence a
 * crash between `mkdirSync` and the pid write leaves behind. `identity` is the
 * directory all of that was read from, so a later removal can be bound to the
 * object and not to the name.
 */
export type LockObservation =
  | { kind: "alive"; token?: string; fileCount?: number; identity?: LockIdentity }
  | { kind: "holder"; pid: number; token?: string; fileCount?: number; identity?: LockIdentity }
  | { kind: "unclaimed"; mtimeMs: number; identity?: LockIdentity };

/**
 * The pid file's owner: a pid, and a token only the run that wrote it knows.
 *
 * The pid alone is not an identity. The operating system hands a dead holder's
 * pid to a later process, and the pid file of a *live* lock then reads exactly
 * like the dead one a reclaimer judged stale. The token is written once, by
 * the run that took the lock, and is never reused, so a lock that was replaced
 * carries a different one and the reclaimer can tell the two apart.
 */
type LockOwner = { pid: number; token: string; fileCount: number };

/**
 * The pid file's content: the pid, the token, and how many files the holder is
 * judging.
 *
 * The count is what a waiter needs. The lock may be held by a run that judges
 * twenty files while the waiter judges one, and a waiter that waits for its
 * own guess gives up while the holder is still working.
 */
export function lockPidFileContent(pid: number, token: string, fileCount: number): string {
  return `${pid} ${token} ${fileCount}\n`;
}

/**
 * The owner a pid file names, or null when it names none.
 */
function readLockOwner(raw: string): LockOwner | null {
  const parts = raw.trim().split(/\s+/u);
  const pid = Number.parseInt(parts[0] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // The holder's own file count, when it wrote one. A lock written before this
  // field existed has none, and a waiter that cannot see the count waits for
  // its own guess.
  const fileCount = Number.parseInt(parts[2] ?? "", 10);
  return {
    pid,
    token: parts[1] ?? "",
    fileCount: Number.isInteger(fileCount) && fileCount > 0 ? fileCount : 0,
  };
}

/**
 * Whether two observations name the same directory.
 *
 * Undefined on either side is false: an observation that carries no identity
 * cannot bind anything, and a reclaim built on it is refused rather than
 * trusted.
 */
function sameIdentity(a: LockIdentity | undefined, b: LockIdentity | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.dev === b.dev && a.ino === b.ino && a.birthMs === b.birthMs;
}

/**
 * Whether two observations name the same lock.
 *
 * The identity has to match as well as the evidence. The evidence is
 * re-readable and the object is not: a live lock that took the name after the
 * caller observed a stale one can hand back a pid file the old code read as
 * identical — a recycled pid, a token it never looked at — and a comparison on
 * content alone then called two different directories the same lock.
 */
function sameLock(a: LockObservation, b: LockObservation): boolean {
  if (a.kind !== b.kind) return false;
  if (!sameIdentity(a.identity, b.identity)) return false;
  if (a.kind === "holder" && b.kind === "holder") {
    return a.pid === b.pid && (a.token ?? "") === (b.token ?? "");
  }
  if (a.kind === "unclaimed" && b.kind === "unclaimed") return a.mtimeMs === b.mtimeMs;
  return false;
}

/** Whether a pid belongs to a running process (EPERM counts as running). */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: it exists but belongs to another user.
    // SAFETY: `process.kill` is the only throw source here and rejects with a
    // NodeJS.ErrnoException, whose string `code` is what this test reads.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The directory at `lockPath`, named by object rather than by path. */
function lockIdentity(lockPath: string): LockIdentity | undefined {
  try {
    const stats = statSync(lockPath);
    return { dev: stats.dev, ino: stats.ino, birthMs: stats.birthtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Observe the lock without deciding, so a reclaimer can bind its removal to
 * the exact state it judged stale.
 *
 * The pid file's existence is not checked separately from reading it: a release
 * can `rmSync` the directory between the two calls, and an unguarded
 * `readFileSync` then throws ENOENT out of `acquireWorktreeLock` (which only
 * catches `EEXIST`) and kills the run with a stack trace instead of retrying.
 * A vanished pid file is "not gone": the waiter retries and the next pass either
 * takes the lock or judges the directory it now sees.
 */
export function observeLockHolder(lockPath: string): LockObservation {
  const pidFile = join(lockPath, "pid");
  let raw: string;
  try {
    raw = readFileSync(pidFile, "utf8");
  } catch (error) {
    // A read error that is not "the file is not there" says nothing about the
    // holder: a sharing violation or a permission problem is not evidence of a
    // dead one, and reading it as one lets a reclaimer take a live lock away
    // from the run that holds it. Only a missing pid file is the evidence.
    // SAFETY: `readFileSync` is the only throw source here and rejects with a
    // NodeJS.ErrnoException, whose string `code` is what this test reads.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { kind: "alive", identity: lockIdentity(lockPath) };
    }
    // No pid file. If the directory is gone too, or young, there is no evidence
    // of a dead holder: retry rather than reclaim.
    try {
      const stats = statSync(lockPath);
      const identity = { dev: stats.dev, ino: stats.ino, birthMs: stats.birthtimeMs };
      return Date.now() - stats.mtimeMs > LOCK_PID_GRACE_MS
        ? { kind: "unclaimed", mtimeMs: stats.mtimeMs, identity }
        : { kind: "alive", identity };
    } catch {
      return { kind: "alive" };
    }
  }
  const owner = readLockOwner(raw);
  // The identity is read beside the pid file, not before it: a reclaim is bound
  // to the directory the evidence came out of, and here the evidence is the pid
  // file this call just read.
  const identity = lockIdentity(lockPath);
  if (owner === null) return { kind: "alive", identity };
  return processIsAlive(owner.pid)
    ? { kind: "alive", token: owner.token, fileCount: owner.fileCount, identity }
    : { kind: "holder", pid: owner.pid, token: owner.token, fileCount: owner.fileCount, identity };
}

/** Whether the process that wrote this lock's pid file is gone. */
export function lockHolderIsGone(lockPath: string): boolean {
  return observeLockHolder(lockPath).kind !== "alive";
}

/**
 * What a reclaim did.
 *
 * `reclaimed` is the stale lock removed. `refused` is the name left exactly
 * where it was — another run holds the lock, another run holds the reclaim, or
 * the name now holds a directory the caller never observed. `not-stale` is an
 * observation that named a live holder, so there was nothing to reclaim.
 */
export type ReclaimOutcome = "reclaimed" | "refused" | "not-stale";

/**
 * The prefix of the claim generations a reclaimer creates inside the lock it is
 * removing: `reclaim.<n>`, `n` a decimal generation.
 *
 * A generation rather than one fixed name, because the name must never be free
 * while a run holds it. Taking a claim displaces nothing: a claim is the
 * exclusive create of the *next* generation, so exactly one caller wins and the
 * generation below it — dead or not — stays exactly where it is.
 */
export const RECLAIM_CLAIM_PREFIX = "reclaim.";

/**
 * What a released generation says in place of an owner.
 *
 * A reclaimer that refuses the lock has to stop blocking it, and deleting its
 * generation frees a name for the next claimant to race on. Marking it
 * superseded in place keeps the name occupied and sends the next run to the
 * generation above it, which is the path a dead generation takes too.
 */
export const RECLAIM_RELEASED_MARKER = "released\n";

/** The file name of one claim generation. */
export function reclaimClaimName(generation: number): string {
  return `${RECLAIM_CLAIM_PREFIX}${generation}`;
}

/** The generation a claim file name encodes, or null when it is not one. */
function claimGenerationOf(name: string): number | null {
  if (!name.startsWith(RECLAIM_CLAIM_PREFIX)) return null;
  const digits = name.slice(RECLAIM_CLAIM_PREFIX.length);
  if (!/^[1-9][0-9]*$/u.test(digits)) return null;
  const generation = Number.parseInt(digits, 10);
  return Number.isSafeInteger(generation) ? generation : null;
}

/** A claim this run created, and the generation it owns. */
export type ReclaimClaim = { path: string; generation: number; token: string };

/** What one claim generation says, and how strongly. */
type ClaimGeneration = {
  generation: number;
  owner: LockOwner | null;
  released: boolean;
  ageMs: number;
};

/** The highest claim generation in the lock, or null when it claims none. */
function highestClaimGeneration(lockPath: string): number | null {
  let names: string[];
  try {
    names = readdirSync(lockPath);
  } catch {
    return null;
  }
  let highest: number | null = null;
  for (const name of names) {
    const generation = claimGenerationOf(name);
    if (generation !== null && (highest === null || generation > highest)) highest = generation;
  }
  return highest;
}

/** Read one claim generation, or null when it is no longer there to read. */
function readClaimGeneration(lockPath: string, generation: number): ClaimGeneration | null {
  const path = join(lockPath, reclaimClaimName(generation));
  let raw: string;
  let ageMs: number;
  try {
    raw = readFileSync(path, "utf8");
    ageMs = Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (raw === RECLAIM_RELEASED_MARKER) {
    return { generation, owner: null, released: true, ageMs };
  }
  return { generation, owner: readLockOwner(raw), released: false, ageMs };
}

/**
 * Whether a generation blocks a claimant.
 *
 * A live owner is someone already removing the lock. A generation with no
 * readable owner blocks only while it is young: its writer may still be inside
 * the create, exactly as for a lock directory whose pid file is not written yet.
 * A released generation blocks nothing, and neither does a dead one.
 */
function blocksClaim(generation: ClaimGeneration): boolean {
  if (generation.released) return false;
  if (generation.owner === null) return generation.ageMs <= LOCK_PID_GRACE_MS;
  return processIsAlive(generation.owner.pid);
}

/**
 * Take this run's claim on the lock, or report that another run holds it.
 *
 * The claim is the exclusive create of the next generation, so there is no
 * check-then-act: `wx` has exactly one winner whatever the interleaving, and a
 * run that loses the create re-reads the highest generation and either claims
 * the one above that or refuses. A generation is never replaced, so the run that
 * won it can still prove it owns it afterwards.
 */
export function claimReclaimGeneration(lockPath: string): ReclaimClaim | null {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const highest = highestClaimGeneration(lockPath);
    if (highest !== null) {
      const current = readClaimGeneration(lockPath, highest);
      // The highest generation vanished between the listing and the read, which
      // only happens when the lock directory itself is going. Re-list rather
      // than claim a number that may already be taken.
      if (current === null) continue;
      if (blocksClaim(current)) return null;
    }
    const generation = (highest ?? 0) + 1;
    const path = join(lockPath, reclaimClaimName(generation));
    const token = randomUUID();
    try {
      writeFileSync(path, lockPidFileContent(process.pid, token, 0), { flag: "wx" });
    } catch (error) {
      // SAFETY: `writeFileSync` rejects with a NodeJS.ErrnoException, whose
      // string `code` is what this reads.
      const code = (error as NodeJS.ErrnoException).code;
      // Another run created this generation first. That is not a failure: the
      // next pass reads the generation it created and refuses, or supersedes it
      // when its writer is gone.
      if (code === "EEXIST") continue;
      return null;
    }
    return { path, generation, token };
  }
  return null;
}

/**
 * Whether this run still owns the highest claim generation, which is the only
 * thing that licenses removing the lock.
 *
 * Read again immediately before the `rmSync`: a higher live generation is
 * another run's claim on the same lock, and removing the lock would delete it
 * under the run that holds it.
 */
export function claimStillLicensed(lockPath: string, claim: ReclaimClaim): boolean {
  const highest = highestClaimGeneration(lockPath);
  if (highest !== claim.generation) return false;
  const current = readClaimGeneration(lockPath, claim.generation);
  if (current === null || current.owner === null) return false;
  return current.owner.pid === process.pid && current.owner.token === claim.token;
}

/**
 * Mark this run's claim released, and only its own.
 *
 * In place, not by deleting the name: a freed generation is one the next
 * claimant can race on, and the whole point of a generation is that the next
 * claimant takes the one above instead. The generation stays as a superseded
 * record, and it goes with the lock directory.
 */
function releaseReclaimClaim(claim: ReclaimClaim): void {
  let raw: string;
  try {
    raw = readFileSync(claim.path, "utf8");
  } catch {
    return;
  }
  const owner = readLockOwner(raw);
  if (owner === null || owner.pid !== process.pid || owner.token !== claim.token) return;
  try {
    writeFileSync(claim.path, RECLAIM_RELEASED_MARKER);
  } catch {
    // The directory is going, or gone, and takes the claim with it.
  }
}

/**
 * Whether the name still holds the lock that was observed.
 *
 * An `unclaimed` observation cannot be re-read as one: the claim just created
 * inside the directory refreshed its mtime, so its age is gone. What is left is
 * that the directory is still the same object and that no pid file has
 * appeared in it. A `holder` observation is re-read whole, pid and token
 * included, because that content is what a replacement cannot reproduce.
 */
function stillObservedLock(lockPath: string, observed: LockObservation): boolean {
  const current = observeLockHolder(lockPath);
  if (!sameIdentity(current.identity, observed.identity)) return false;
  if (observed.kind === "holder") return sameLock(current, observed);
  if (observed.kind === "unclaimed") return !existsSync(join(lockPath, "pid"));
  return false;
}

/**
 * Remove the stale lock `observed` described, and only that lock.
 *
 * The two properties this has to satisfy — recovery is exclusive, and the
 * removal is bound to the observed object — are the module's charter at the top
 * of this file. This is where each is met: the claim generation below is the
 * exclusivity, `stillObservedLock` is the binding, and `claimStillLicensed` is
 * the licence read one last time before the removal.
 */
export function reclaimStaleLock(lockPath: string, observed: LockObservation): ReclaimOutcome {
  if (observed.kind === "alive") return "not-stale";
  // An observation with no identity binds nothing, so it is refused rather than
  // trusted: a hand-built observation must not become a licence to delete.
  if (observed.identity === undefined) return "refused";
  const claim = claimReclaimGeneration(lockPath);
  if (claim === null) return "refused";
  if (!stillObservedLock(lockPath, observed) || !claimStillLicensed(lockPath, claim)) {
    releaseReclaimClaim(claim);
    return "refused";
  }
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // A parent directory that will not let the entry go, or a directory in use.
    // Leaving the lock is the safe half: the waiter sleeps and its budget runs
    // out with a message naming the lock, instead of a throw out of the loop.
    releaseReclaimClaim(claim);
    return "refused";
  }
  return "reclaimed";
}

/**
 * Serialize every run that touches one base worktree.
 *
 * The lock directory is the atomic acquire. A holder that died is detected by
 * its pid and removed under an exclusive claim, so unknown has to cover the
 * whole worst case: wait too little and a legitimate second run is refused with
 * "wait for it to finish", which is advice it cannot follow because the
 * deadline has already fired. The caller therefore derives the budget from the
 * work it is about to do. `RED_ON_PARENT_LOCK_WAIT_MS` overrides it, which is
 * how the lock's refusal is pinned in milliseconds.
 */
export function acquireWorktreeLock(lockPath: string, lockWaitMs: number, fileCount = 0): () => void {
  // The cache root does not exist on a cold first run, and `mkdirSync(lockPath)`
  // stays non-recursive because that is exactly what makes it the exclusive
  // acquire. Create the lock's parent first, never the lock itself.
  mkdirSync(dirname(lockPath), { recursive: true });
  let deadline = Date.now() + lockWaitMs;
  // The holder whose file count the budget was already extended for.
  let countedHolder: string | null = null;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      // SAFETY: `mkdirSync` rejects with a NodeJS.ErrnoException, and its `code`
      // is the documented way to tell "already held" from a real failure.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const observed = observeLockHolder(lockPath);
      // The holder's own file count says what the lock is working on. The
      // waiter's count is a guess, and a budget that expires while the holder
      // is still judging its files tells the waiter to delete a live lock. The
      // count is taken once per holder: a deadline that grew on every pass
      // would never expire.
      if (observed.kind !== "unclaimed" && observed.token !== countedHolder) {
        countedHolder = observed.token ?? null;
        deadline = effectiveWaitDeadline(deadline, observed, Date.now());
      }
      if (Date.now() > deadline) {
        throw new GateError(lockContentionMessage(lockPath, observed));
      }
      if (observed.kind !== "alive" && reclaimStaleLock(lockPath, observed) === "reclaimed") {
        // The stale lock is gone, so the next `mkdirSync` can take the name.
        continue;
      }
      // A reclaim that refused leaves the lock exactly where it was, and the
      // next pass would observe the same stale lock and reclaim it again. The
      // `continue` this used to take skipped both the deadline check and the
      // sleep, so a lock that could not be reclaimed spun the run at full speed
      // until somebody killed it.
      sleepSync(LOCK_RETRY_MS);
    }
  }
  // The directory this run took, named by object, before anything is written
  // into it: the release below is the second place a lock directory is removed,
  // and it is bound to this the way the reclaim is bound to its observation.
  const identity = lockIdentity(lockPath);
  // The pid file carries a token as well as the pid, so a later run can tell
  // this lock from one that took the same pid after the operating system
  // handed that pid out again.
  const token = randomUUID();
  writeFileSync(join(lockPath, "pid"), lockPidFileContent(process.pid, token, fileCount));
  return () => {
    releaseWorktreeLock(lockPath, token, identity);
  };
}

/**
 * Remove the lock this run holds, and only that one.
 *
 * This is the second of the two places a lock directory is removed —
 * `reclaimStaleLock` is the first — and the charter at the top of this file says
 * how it is bound: to the token this run wrote *and* to the object it wrote it
 * into, compared before anything is read.
 *
 * An acquire that could not stamp its own directory keeps the lock instead of
 * removing it. A lock left behind is recovered by the next run once this process
 * is gone, because its pid file names a dead holder; a lock removed blind is
 * not recoverable at all.
 *
 * Returns whether the directory is gone.
 */
export function releaseWorktreeLock(
  lockPath: string,
  token: string,
  identity: LockIdentity | undefined,
): boolean {
  if (identity === undefined) return false;
  if (!sameIdentity(lockIdentity(lockPath), identity)) return false;
  let raw: string;
  try {
    raw = readFileSync(join(lockPath, "pid"), "utf8");
  } catch {
    return false;
  }
  const owner = readLockOwner(raw);
  if (owner === null || owner.pid !== process.pid || owner.token !== token) return false;
  try {
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    // A directory in use on Windows, or a parent that will not let the entry go.
    // It stays, and the next run reclaims it once this pid is dead.
    return false;
  }
}

/**
 * What a waiter says when the lock is still held.
 *
 * The holder's own file count is in the message when there is one: a waiter
 * that gave up after a budget computed from its own file count otherwise reads
 * the holder as idle, and the advice to delete the directory breaks a live run.
 */
export function lockContentionMessage(lockPath: string, observed: LockObservation): string {
  const count = observed.kind === "unclaimed" ? 0 : observed.fileCount ?? 0;
  const note =
    count > 0
      ? ` (it says it is judging ${count} file${count === 1 ? "" : "s"}, so it may still be working)`
      : "";
  return `another red-on-parent run is using ${lockPath}${note}; wait for it to finish, or delete that directory if no run is alive`;
}

/** How long a run waits for the lock, given what can legitimately be inside it. */
export function lockWaitBudget(fileCount: number, holderFileCount = 0): number {
  const override = Number.parseInt(process.env.RED_ON_PARENT_LOCK_WAIT_MS ?? "", 10);
  const own = Number.isInteger(override) && override > 0
    ? override
    : INSTALL_TIMEOUT_MS + fileCount * 2 * testTimeoutMs() + LOCK_WAIT_SLACK_MS;
  // The holder's own work is not the waiter's to shorten. A waiter that judges
  // one file waits for one file's worth of time, while the lock may be held by
  // a run that judges twenty; the holder says how many in its pid file, and the
  // wait covers that many. The install is not counted here: the waiter cannot
  // know whether the holder paid it.
  const holderNeed = holderFileCount * 2 * testTimeoutMs();
  return Math.max(own, holderNeed);
}

/**
 * The deadline a waiter works to, given what the lock's holder says it is doing.
 *
 * The waiter's own file count is a guess about a lock it cannot see into. The
 * holder writes its own count into its pid file, so a waiter that reads it can
 * wait for the work that is actually there instead of for its own guess.
 */
export function effectiveWaitDeadline(
  deadline: number,
  observed: LockObservation,
  now: number,
): number {
  const count = observed.kind === "unclaimed" ? undefined : observed.fileCount;
  if (count === undefined || count <= 0) return deadline;
  return Math.max(deadline, now + lockWaitBudget(count, count));
}
