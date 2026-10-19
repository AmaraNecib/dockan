import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Hono } from "hono";
import { z } from "zod";

import type { AppConfig } from "../../config";
import { tokenMatches } from "../boot-token";
import { errnoCode, probePidLiveness, type PidLiveness, type PidLivenessProbe } from "../pid-liveness";

/**
 * Single-writer lock for the vault data folder (issue #142). The runtime
 * database is an in-memory image and the only database file is the encrypted
 * snapshot, so two sidecars on one folder would each load their own image and
 * last-writer-win `dokan.db.enc` — silently losing sales and payments.
 *
 * Mechanism: an exclusive lock file created with `O_CREAT | O_EXCL` (`wx`).
 * That single syscall is atomic on NTFS, on SMB/UNC shares and on local POSIX
 * filesystems, so it never silently degrades to "no lock" the way a
 * probe-then-create or an advisory-only scheme can. The holder writes
 * `{ pid, host, startedAt, heartbeatAt, token }`, keeps the file descriptor
 * open, and heartbeats every 10s. A second process refuses; a lock left by a
 * dead holder is reclaimed:
 *   - same host: the PID must be gone, or the probe must be inconclusive AND
 *     the heartbeat older than the staleness window. `process.kill(pid, 0)`
 *     answers exactly while it does not throw (`ESRCH` = gone); `EPERM`, which
 *     on Windows also covers a pid that no longer runs, cannot tell, so the
 *     heartbeat decides (`lib/pid-liveness.ts`, ADR-0012);
 *   - another host (a stick moved while a process was killed): the heartbeat
 *     must be older than 60s, because a live remote process keeps beating.
 * The heartbeat is what makes the portable-stick case recoverable without ever
 * trusting a clock-only timeout for a live same-host process.
 *
 * Losing the lock file while running (someone deleted it) is fail-stop: the
 * `onLost` callback fires so the caller can stop writing and refuse rather than
 * run without exclusivity. The module never exits by itself when `onLost` is
 * provided.
 *
 * A read that fails without the file being gone is NOT that loss (#281): a
 * Windows sharing violation (`EACCES`/`EBUSY`/`EPERM`, antivirus or the indexer
 * holding `vault.lock`) is `unreadable`, not missing, so the holder retries it a
 * bounded number of times and only then fails closed. A record caught mid-write
 * is a different class, `malformed` (#288): the bytes were read fine and are not
 * a lock record yet. The held-lock path retries both and never stops a holder on
 * either, but the acquisition path acts on the difference — a `malformed` record
 * is stale and reclaimable, while an `unreadable` one withholds the reclaim
 * entirely, because a read that failed cannot prove a live holder is gone
 * (#287). `ENOENT` and a different owner's token still lose the lock at
 * once, so this is not a new way to strand the folder. `release()` never
 * unlinks a record it could not read, for the same reason: an unreadable file
 * may be a new owner's. When `onLost` keeps the process alive after a loss
 * (the refusal path), the release it could not complete is owed, not dropped:
 * the process retries the cleanup on a capped backoff and unlinks the record
 * only once a read confirms it is still ours (#281, Greptile P1). A live pid
 * with an old heartbeat is still left alone — that is a suspended holder, not
 * a dead one (ADR-0012).
 */

export type VaultLockOwner = {
  pid: number;
  host: string;
  startedAt: string;
  heartbeatAt: string;
  token: string;
};

const ownerSchema = z.object({
  pid: z.number().int().positive(),
  // length-bounded on read; the display path additionally strips anything
  // outside the hostname charset and HTML-escapes the result (see the page)
  host: z.string().min(1).max(64),
  startedAt: z.string(),
  heartbeatAt: z.string(),
  token: z.string().min(1),
});

export type VaultLockLogger = {
  warn(event: string, message: string): void;
  error(event: string, message: string, error?: Error): void;
};

/** Runs one read of the lock file; injectable so tests can force a read error. */
export type VaultLockFileReader = (lockPath: string) => string;

/** Extra reads a HELD lock's unreadable file gets before the holder fails closed. */
const DEFAULT_TRANSIENT_READ_RETRIES = 10;
const DEFAULT_TRANSIENT_READ_RETRY_DELAY_MS = 100;
/**
 * Absolute bounds on a synchronous retry loop. The defaults are already
 * bounded; these stop a misconfigured knob (or a boot with a pathological
 * `readRetries`) from turning a boot or a write into an event-loop stall.
 */
const MAX_RETRY_ATTEMPTS = 100;
const MAX_RETRY_DELAY_MS = 500;
/** One held-lock read sequence may block for at most this long, whatever the knobs. */
const MAX_HELD_RETRY_WINDOW_MS = 1_000;
/**
 * The deferred cleanup of an unreadable record never reads faster than this
 * once its backoff has grown: a long-lived refusal process retries for as long
 * as it stays alive, so the interval between its reads needs a ceiling
 * (Greptile P1).
 */
const MAX_OWED_RELEASE_DELAY_MS = 30_000;
/**
 * How many distinct error codes the loss reason spells out. The attempt ceiling
 * (101) already bounds the assembled reason, but 101 distinct hostile codes are
 * still ~4.5 KB of JSONL; the reason names a few and counts the rest.
 */
const MAX_REASON_CODES = 5;

export type VaultLockOptions = {
  logger?: VaultLockLogger;
  /** heartbeat cadence while the lock is held */
  heartbeatIntervalMs?: number;
  /** a heartbeat older than this on ANOTHER host means the holder is gone */
  staleHeartbeatMs?: number;
  /** attempts to read a just-created lock file before calling it malformed */
  readRetries?: number;
  readRetryDelayMs?: number;
  /** settle window before stealing a stale lock, to lose a steal race safely */
  stealSettleMs?: number;
  /**
   * how many extra reads the lock file of a HELD lock gets when it exists but
   * cannot be read — a sharing violation (`EACCES`/`EBUSY`/`EPERM`), or a record
   * caught mid-write, which is `malformed` rather than `unreadable` (#288) —
   * before the holder fails closed (#281); 10 x 100 ms by default, which is a
   * whole second of patience for an antivirus scanner holding the file, while
   * a genuine theft is still judged on the first read (a replacement record or
   * a missing file), and the budget cannot close the gap between this holder's
   * read and its own rewrite — a file stolen inside that gap still fails the
   * holder closed, which is the conservative outcome, not a wrong one.
   */
  transientReadRetries?: number;
  transientReadRetryDelayMs?: number;
  /** the lock-file read; injectable so tests can force a read error (#281) */
  readLockFile?: VaultLockFileReader;
  /**
   * @internal The lock-file unlink; defaults to `fs.unlinkSync`. Injectable so a
   * test can force the non-ENOENT failure the owed-release chain logs
   * (code-review P3-2), the same way `readLockFile` forces a read error.
   */
  unlinkLockFile?: (lockPath: string) => void;
  /**
   * @internal The clock and sleep the held-lock retry loop runs on. Both
   * default to the real `Date.now` and `Bun.sleepSync`, so production is
   * unchanged; tests inject a controlled pair so the loop's attempt ceiling and
   * one-second window are proved by arithmetic, not against a loaded machine's
   * wall clock (#281).
   */
  now?: () => number;
  sleep?: (milliseconds: number) => void;
  /**
   * fail-stop hook: the lock disappeared or became unwritable while held. The
   * holder argument is the new owner when the record named one, so the caller
   * can say who took the folder.
   */
  onLost?: (reason: string, holder?: VaultLockOwner) => void;
  /** the pid-liveness probe; injectable so tests can force `unknown` (EPERM) */
  probePid?: PidLivenessProbe;
};

export class VaultAlreadyLockedError extends Error {
  /**
   * `lockPath` is optional: a live holder identified by its own record needs no
   * path to be named (the refusal page shows the holder), and inventing an
   * empty-string sentinel at those call sites would be worse than omitting it.
   *
   * `staleHeartbeatOverAlivePid` is the refusal's story, not its decision: the
   * pid answers alive but the record has not beat in several windows, so the
   * pid is probably recycled and there may be no other Dokan copy at all. The
   * refusal still refuses; only the copy names the lock file as the exit.
   */
  constructor(
    readonly owner: VaultLockOwner | undefined,
    readonly lockPath?: string,
    readonly staleHeartbeatOverAlivePid = false,
  ) {
    super(
      owner === undefined
        ? `another Dokan instance is using this data folder${lockPath === undefined ? "" : ` (${lockPath})`}`
        : `another Dokan instance is using this data folder (${owner.host}, pid ${owner.pid})`,
    );
    this.name = "VaultAlreadyLockedError";
  }
}

/**
 * The lock file EXISTS and could not be read (#287): every read in the boot's
 * window failed with an errno that is not `ENOENT` (a Windows sharing
 * violation, an I/O error), so no holder can be named — and the folder may
 * well be free. It is not a `VaultAlreadyLockedError`: that refusal claims an
 * instance on this folder and tells the owner to close it, while here the one
 * exit is the file itself. The errno rides along so the boot's log says why.
 */
export class VaultLockUnreadableError extends Error {
  constructor(
    readonly lockPath: string,
    readonly code: string | undefined,
  ) {
    super(`the data-folder lock at ${lockPath} could not be read (${code ?? "unknown"})`);
    this.name = "VaultLockUnreadableError";
  }
}

/** The lock could not be created at all (permissions, read-only media, ...). */
export class VaultLockUnavailableError extends Error {
  constructor(
    readonly cause: Error,
    readonly lockPath: string,
  ) {
    super(`the data-folder lock could not be created at ${lockPath}: ${cause.message}`);
    this.name = "VaultLockUnavailableError";
  }
}

/**
 * A write was refused because this process no longer owns the single-writer
 * lock (ADR-0012 clause 3). The write path asks `VaultLock.assertHeld()` at
 * the instant of each write, so it does not wait for the heartbeat timer.
 */
export class VaultLockLostError extends Error {
  constructor(readonly lockPath: string) {
    super(`the single-writer lock at ${lockPath} is no longer held by this process`);
    this.name = "VaultLockLostError";
  }
}

/**
 * One read of the lock file, classified (#281, #287). `ENOENT` is the only
 * canonical "gone": the path does not resolve, so there is nothing left to
 * hold. A record that parsed and failed the schema, or did not parse at all, is
 * `malformed`: the bytes were read fine and are not a lock record. Every other
 * failure — a sharing violation (`EACCES`/`EBUSY`/`EPERM`) or an I/O error — is
 * `unreadable`: the file is there and may well be ours, we just cannot attest
 * to it at this instant.
 *
 * The split is a wait/stop axis, not a naming choice. A `malformed` record is
 * what a reclaim caught between its create and its write looks like, so the
 * held-lock path retries it like an errno and never stops on it (#288). The
 * acquisition path cares about the opposite: `malformed` is staleness evidence
 * a reclaim may act on, while `unreadable` withholds the reclaim entirely
 * (#287), because a read that failed cannot prove a live holder is gone.
 */
type LockFileRead =
  | { readonly kind: "owner"; readonly owner: VaultLockOwner }
  | { readonly kind: "gone" }
  | { readonly kind: "malformed"; readonly error: Error }
  | { readonly kind: "unreadable"; readonly code: string; readonly error: Error };

function lockFileReader(options: VaultLockOptions): VaultLockFileReader {
  return options.readLockFile ?? ((lockPath: string) => fs.readFileSync(lockPath, "utf8"));
}

/**
 * The held-lock retry loop's real clock and sleep; the defaults for
 * `now`/`sleep`. The clock is `performance.now()`: it only moves forward, so a
 * wall-clock step (an NTP correction, a user changing the date) cannot spend
 * the one-second budget before a second of real time has passed and fail-stop
 * a healthy holder (#281, Greptile P2). The heartbeat comparison at
 * `heartbeatIsFresh` deliberately stays on `Date.now()`: a persisted
 * `heartbeatAt` carries wall time, and a monotonic reading cannot be compared
 * to it across processes or restarts.
 */
const realNow = (): number => performance.now();
const realSleep = (milliseconds: number): void => Bun.sleepSync(milliseconds);

function readOwnerOnce(lockPath: string, reader: VaultLockFileReader): LockFileRead {
  let raw: string;
  try {
    raw = reader(lockPath);
  } catch (error) {
    // the code is read off the thrown value, not the wrapped Error: the seam
    // may throw a bare `{ code }`, and flattening it first would lose the errno
    const thrown = thrownCodeSchema.safeParse(error);
    const code = thrown.success ? thrown.data.code : undefined;
    if (code === "ENOENT") return { kind: "gone" };
    return {
      kind: "unreadable",
      code: code ?? "UNKNOWN",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // a fixed single-line detail, never the raw content: the reason reaches a
    // JSONL log line, and the record is a file on disk
    return { kind: "malformed", error: new Error("the record did not parse as JSON") };
  }
  const parsed = ownerSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: "malformed", error: new Error("the record did not satisfy the owner schema") };
  }
  return { kind: "owner", owner: parsed.data };
}

/**
 * The errno on any thrown value, Error or not. Node's fs errors are Errors, so
 * `errnoCode` covers production; the read seam is injectable, and a bare
 * `{ code }` thrown through it must still classify as its real errno.
 */
const thrownCodeSchema = z.object({ code: z.string() });

/** One bounded line: the reason reaches a JSONL log line, not a log page. */
function oneLine(value: string, cap = 200): string {
  return value.replace(/\s+/g, " ").trim().slice(0, cap);
}

/**
 * A retry/delay knob, clamped to `[0, ceiling]`: the loop is synchronous, so an
 * absurd or non-finite value must not be able to make it unbounded.
 */
function retryBudget(configured: number | undefined, fallback: number, ceiling: number): number {
  if (configured === undefined || !Number.isFinite(configured)) return fallback;
  return Math.min(ceiling, Math.max(0, Math.trunc(configured)));
}

/**
 * The acquisition read: the owner it settled on, plus whether ANY read in the
 * window failed for a reason other than ENOENT — an errno that never cleared
 * within the budget. That flag is the #287 guard.
 *
 * A malformed record still counts toward staleness: the bytes were read and are
 * not a lock record, so nobody holds it, and the corrupt-lock reclaim keeps
 * working. A read that errored out proves nothing about the holder, and the
 * caller must refuse to reclaim rather than unlink a live holder's
 * renamed-aside file.
 */
type OwnerRead = {
  readonly owner: VaultLockOwner | undefined;
  /** true when any read in this window failed for a reason other than ENOENT */
  readonly blocked: boolean;
  /** the last non-ENOENT read error code, for the diagnostic */
  readonly code: string | undefined;
};

function readOwner(lockPath: string, options: VaultLockOptions): OwnerRead {
  const retries = retryBudget(options.readRetries, 20, MAX_RETRY_ATTEMPTS);
  const delayMs = retryBudget(options.readRetryDelayMs, 50, MAX_RETRY_DELAY_MS);
  const reader = lockFileReader(options);
  let blocked = false;
  let code: string | undefined;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const read = readOwnerOnce(lockPath, reader);
    if (read.kind === "owner") return { owner: read.owner, blocked, code };
    // a real ENOENT is final: there is nothing left to read, so the retry loop
    // must not burn its budget on an absent file
    if (read.kind === "gone") return { owner: undefined, blocked, code };
    // only a read that FAILED blocks the reclaim (#287): a malformed record was
    // read fine and is not a lock record, so it stays staleness evidence
    if (read.kind === "unreadable") {
      blocked = true;
      code = read.code;
    }
    // a creator may still be writing its JSON, or another process holds the
    // file open: retry before calling the lock stale (and reclaimable)
    if (attempt < retries) Bun.sleepSync(delayMs);
  }
  return { owner: undefined, blocked, code };
}

/** True when the recorded heartbeat is inside the staleness window. */
function heartbeatIsFresh(owner: VaultLockOwner, options: VaultLockOptions): boolean {
  const heartbeat = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeat)) return false;
  const age = Date.now() - heartbeat;
  // A stamp in the future is not evidence of death: a foreign clock running
  // ahead must hold the conservative refusal, never invite a reclaim. Only
  // non-negative ages are measured against the window.
  if (age < 0) return true;
  return age <= (options.staleHeartbeatMs ?? 60_000);
}

/**
 * A live Dokan beats every 10s, so a heartbeat this many staleness windows old
 * is not a holder that paused: the recorded process stopped beating long ago
 * and the pid the OS answers for probably belongs to something else.
 */
const PID_REUSE_HEARTBEAT_WINDOWS = 3;

/**
 * True when the recorded heartbeat is older than the suspicion window. An
 * unparseable stamp counts as stale; a stamp in the future does not, because a
 * foreign clock running ahead is not evidence of a recycled pid.
 */
function heartbeatIsStaleByWindows(owner: VaultLockOwner, options: VaultLockOptions): boolean {
  const heartbeat = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeat)) return true;
  const age = Date.now() - heartbeat;
  if (age < 0) return false;
  return age > (options.staleHeartbeatMs ?? 60_000) * PID_REUSE_HEARTBEAT_WINDOWS;
}

/** How a recorded holder reads right now: the refusal decision, plus its story. */
type HolderVerdict = {
  /** the old `holderIsLive` answer, unchanged: refuse when this is true */
  live: boolean;
  /** true only for an alive pid whose recorded heartbeat is many windows stale */
  staleHeartbeatOverAlivePid: boolean;
};

/**
 * The refusal decision and the reason it reads that way.
 *
 * On this host the pid probe is exact whenever it answers: no throw is alive,
 * `ESRCH` is gone, and anything else is inconclusive, so the recorded
 * heartbeat decides. A pid that answers as alive still wins over an old
 * heartbeat (the round-5 rule); only the unknowable case changes (ADR-0012).
 * That same "alive pid wins with an old heartbeat" case is the recycled-pid
 * story, so it carries a second answer without changing `live`.
 */
function holderVerdict(owner: VaultLockOwner, options: VaultLockOptions): HolderVerdict {
  if (owner.host !== os.hostname()) {
    return { live: heartbeatIsFresh(owner, options), staleHeartbeatOverAlivePid: false };
  }
  const probe = options.probePid ?? probePidLiveness;
  const liveness: PidLiveness = probe(owner.pid);
  if (liveness === "alive") {
    return { live: true, staleHeartbeatOverAlivePid: heartbeatIsStaleByWindows(owner, options) };
  }
  if (liveness === "gone") return { live: false, staleHeartbeatOverAlivePid: false };
  return { live: heartbeatIsFresh(owner, options), staleHeartbeatOverAlivePid: false };
}

/** What the holder's own read of its lock file established (#281). */
type HeldRead =
  | { readonly kind: "held" }
  | { readonly kind: "lost"; readonly reason: string; readonly holder?: VaultLockOwner };

/**
 * The holder's own read of its lock file (#281). Same classification as every
 * other read, plus the decision only the holder needs:
 * - `gone` — lost NOW (someone deleted the file);
 * - another owner's token — lost NOW (someone replaced it);
 * - `unreadable` — retried, bounded, and only then lost. It is NOT theft: a
 *   transient Windows sharing violation, or a reclaim caught between its
 *   create and its write, used to fail-stop a healthy holder — which released
 *   its own lock, unlinked the file and served the refusal page, after which a
 *   third instance could take the folder.
 */
function readHeldLock(lockPath: string, token: string, options: VaultLockOptions): HeldRead {
  const retries = retryBudget(options.transientReadRetries, DEFAULT_TRANSIENT_READ_RETRIES, MAX_RETRY_ATTEMPTS);
  const delayMs = retryBudget(
    options.transientReadRetryDelayMs,
    DEFAULT_TRANSIENT_READ_RETRY_DELAY_MS,
    MAX_RETRY_DELAY_MS,
  );
  const reader = lockFileReader(options);
  const now = options.now ?? realNow;
  const sleep = options.sleep ?? realSleep;
  // the window bounds the stall whatever the knobs say: this runs inside
  // `writeGuard`, so an unbounded wait here is an unbounded stalled write
  const budgetEndsAt = now() + MAX_HELD_RETRY_WINDOW_MS;
  const codes: string[] = [];
  const seenCodes = new Set<string>();
  let omittedCodes = 0;
  for (let attempt = 0; ; attempt += 1) {
    const read = readOwnerOnce(lockPath, reader);
    if (read.kind === "owner") {
      return read.owner.token === token
        ? { kind: "held" }
        : { kind: "lost", reason: "the lock file was replaced by another owner", holder: read.owner };
    }
    if (read.kind === "gone") {
      // a reclaim renames the file aside before it writes its own, so a
      // replacement can surface here as a disappearance; the outcome is the
      // same prompt fail-stop, only the holder goes unnamed (critic N5)
      return { kind: "lost", reason: "the lock file disappeared" };
    }
    // the errno is folded and bounded like the message: it reaches the reason,
    // and a code is only ever a token, never a smuggled log line. Only the
    // first few distinct codes are spelled out; the rest are counted, so a
    // hostile reader cannot grow the reason with fresh codes on every attempt
    // a malformed record is a read that succeeded on bytes that are not a lock
    // record (a reclaim caught between its create and its write): it retries
    // and waits exactly like an errno, and never stops the holder
    const code = read.kind === "malformed" ? "MALFORMED" : oneLine(read.code, 40);
    if (!seenCodes.has(code)) {
      seenCodes.add(code);
      if (codes.length < MAX_REASON_CODES) codes.push(code);
      else omittedCodes += 1;
    }
    if (attempt >= retries || now() >= budgetEndsAt) {
      // the codes seen, the attempt count and the OS's own sentence ride in
      // the reason, which `lost()` logs as VAULT_LOCK_LOST: the api's log
      // vocabulary is a contract shared with the web badge, so a new event
      // code is not this module's to add
      const codeSummary = omittedCodes === 0 ? codes.join(", ") : `${codes.join(", ")}, +${omittedCodes} more`;
      return {
        kind: "lost",
        reason: `the lock file could not be read (${codeSummary} after ${attempt + 1} attempts: ${oneLine(read.error.message)})`,
      };
    }
    sleep(Math.min(delayMs, Math.max(0, budgetEndsAt - now())));
  }
}

export class VaultLock {
  readonly path: string;
  private fd: number | undefined;
  private owner: VaultLockOwner;
  private timer: ReturnType<typeof setInterval> | undefined;
  private owedReleaseTimer: ReturnType<typeof setTimeout> | undefined;
  private released = false;

  constructor(
    lockPath: string,
    fd: number,
    owner: VaultLockOwner,
    private readonly options: VaultLockOptions,
  ) {
    this.path = lockPath;
    this.fd = fd;
    this.owner = owner;
    this.arm();
  }

  /** The recorded holder (for tests and diagnostics). */
  currentOwner(): VaultLockOwner {
    return this.owner;
  }

  /**
   * The WRITE-path ownership check (ADR-0012 clause 3). The
   * heartbeat alone is not enough: a snapshot persist already queued can run
   * before the next heartbeat and overwrite the new owner's data. Every write
   * asks here instead, and the answer is read from the lock file NOW (the same
   * identity comparison the heartbeat uses), so the guard does not depend on
   * `lost()` having already fired. The first loss still runs the fail-stop
   * synchronously, then this throws so the write is refused.
   */
  assertHeld(): void {
    if (this.released) throw new VaultLockLostError(this.path);
    const read = readHeldLock(this.path, this.owner.token, this.options);
    if (read.kind === "held") return;
    this.lost(read.reason, read.holder);
    throw new VaultLockLostError(this.path);
  }

  private arm(): void {
    activeLocks.add(this);
    ensureExitHook();
    this.timer = setInterval(() => this.heartbeat(), this.options.heartbeatIntervalMs ?? 10_000);
    // the heartbeat must never keep a closing process alive
    this.timer.unref?.();
  }

  private heartbeat(): void {
    if (this.released || this.fd === undefined) return;
    // verify IDENTITY, not mere existence: a reclaim/rename may have
    // replaced the path with another owner's record, and continuing to
    // write would make us a second writer (round-5 finding). A read that
    // cannot attest (sharing violation, mid-write record) is retried before
    // it is a loss (#281).
    const read = readHeldLock(this.path, this.owner.token, this.options);
    if (read.kind === "lost") {
      this.lost(read.reason, read.holder);
      return;
    }
    try {
      const next: VaultLockOwner = { ...this.owner, heartbeatAt: new Date().toISOString() };
      fs.ftruncateSync(this.fd, 0);
      // position 0: the fd position advanced past the first write
      fs.writeSync(this.fd, JSON.stringify(next), 0);
      try {
        fs.fsyncSync(this.fd);
      } catch {
        // some network filesystems refuse fsync; the O_EXCL create is the lock
      }
      this.owner = next;
    } catch (error) {
      this.lost(error instanceof Error ? error.message : String(error));
    }
  }

  private lost(reason: string, holder?: VaultLockOwner): void {
    // name the holder on every loss: a stuck install must be diagnosable from
    // the log alone
    const who = holder === undefined ? "the holder is unknown" : `the holder is ${holder.host} pid ${holder.pid}`;
    this.options.logger?.error("VAULT_LOCK_LOST", `the single-writer lock was lost (${reason}); ${who}`);
    const handler = this.options.onLost;
    this.release();
    if (handler !== undefined) handler(reason, holder);
    else process.exit(1);
  }

  /** Release the lock. Idempotent; never deletes another owner's file. */
  release(): void {
    if (this.released) return;
    this.released = true;
    activeLocks.delete(this);
    if (this.timer !== undefined) clearInterval(this.timer);
    try {
      if (this.fd !== undefined) fs.closeSync(this.fd);
    } catch {
      /* already closed */
    }
    this.fd = undefined;
    const read = readOwnerOnce(this.path, lockFileReader(this.options));
    // an unreadable or malformed record is never unlinked: the token cannot be
    // compared, so the file may be a new owner's, or one mid-write (#281). The
    // synchronous release stays ONE read — it runs from the exit hook, and
    // sleeping there to chase a file this process is about to stop caring about
    // is worse than leaving it (critic N3) — but when the process stays alive
    // (the refusal path) it owes the cleanup, so it arms the deferred retry that
    // can confirm the token later (Greptile P1).
    if (read.kind === "unreadable" || read.kind === "malformed") {
      if (this.options.onLost !== undefined) this.armOwedRelease();
      return;
    }
    if (read.kind === "owner" && read.owner.token !== this.owner.token) return;
    try {
      this.unlinkRecord();
    } catch {
      /* already gone */
    }
  }

  /**
   * Retry the cleanup this process still owes after `release()` could not read
   * its own record (#281, Greptile P1). The refusal path keeps the process
   * alive to serve the refusal page, and `holderIsLive()` answers "alive" for
   * a live pid whatever the heartbeat age, so this process's abandoned record
   * would refuse every later instance until a human stops it. The token is
   * compared on every attempt: the file is removed only once a successful read
   * shows it is still ours, a gone file stops the chain, and another owner's
   * record ends the retry untouched. Armed only when `onLost`
   * is set, which is exactly the module's "process continues" case. Unref'd, so
   * it never keeps a closing process alive.
   */
  private armOwedRelease(): void {
    if (this.owedReleaseTimer !== undefined) return;
    // the held-read delay is reused as the first owed-retry delay: both mean
    // "how long to wait before re-reading an unreadable lock", and the floor
    // stops a 0 ms knob from turning the retry into a spin
    let delay = Math.max(
      1,
      retryBudget(this.options.transientReadRetryDelayMs, DEFAULT_TRANSIENT_READ_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS),
    );
    let attemptCount = 0;
    const attempt = (): void => {
      this.owedReleaseTimer = undefined;
      attemptCount += 1;
      const read = readOwnerOnce(this.path, lockFileReader(this.options));
      if (read.kind === "owner") {
        // a readable record is removed only when it is still ours; another
        // owner's token is not ours to touch (#281, Greptile P1)
        if (read.owner.token !== this.owner.token) return;
        // read -> unlink is not atomic: a foreign reclaim could rename this
        // record aside and create its own between the two calls, and the
        // unlink would then drop the new owner's record. This is the same
        // window `release()` has always had, and the module's own actors
        // cannot reach it: a same-host reclaim is refused while our live pid
        // answers `alive`, and a foreign-host reclaim verifies the moved
        // record's token before it deletes. A manual replacement is outside
        // the threat model, so this comment is the fix, not a seam
        // (code-review P3-1).
        try {
          this.unlinkRecord();
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          // only a non-ENOENT failure is news: ENOENT means someone else
          // already removed the record, which is the outcome this retry wants.
          // The message names the record and the attempt so the state this
          // chain exists to surface — a record that should be gone and is not
          // — is never silent (code-review P3-2).
          if (errnoCode(failure) !== "ENOENT") {
            this.options.logger?.warn(
              "VAULT_LOCK_LOST",
              `the owed release at ${this.path} could not remove this process's record on attempt ${attemptCount}: ${oneLine(failure.message)}`,
            );
          }
        }
        return;
      }
      // gone is an ending: there is nothing left to remove, so stop rather
      // than re-arm (code-review P3-3)
      if (read.kind === "gone") return;
      // unreadable or malformed: the record may still be ours and mid-write,
      // so retry on a capped backoff, never stop (#287/#288 wait-on-malformed)
      delay = Math.min(MAX_OWED_RELEASE_DELAY_MS, Math.max(delay + 1, delay * 2));
      this.owedReleaseTimer = setTimeout(attempt, delay);
      this.owedReleaseTimer.unref?.();
    };
    this.owedReleaseTimer = setTimeout(attempt, delay);
    this.owedReleaseTimer.unref?.();
  }

  /** The lock-file unlink, through the injectable `unlinkLockFile` seam. */
  private unlinkRecord(): void {
    const unlink = this.options.unlinkLockFile ?? ((lockPath: string): void => fs.unlinkSync(lockPath));
    unlink(this.path);
  }
}

/**
 * The snapshot write guard main.ts installs: refuse loudly when no lock was
 * ever held. A missing lock must never turn the guard into a silent no-op
 * (ADR-0012 clause 3); that would let a store write with no exclusivity at
 * all. Exported so the no-lock branch is pinned by a unit test.
 */
export function requireHeldLock(lock: VaultLock | undefined): () => void {
  return () => {
    if (lock === undefined) throw new Error("the vault write guard ran without a held lock");
    lock.assertHeld();
  };
}

/**
 * Remove a stale lock safely. The win is decided by ONE atomic rename: only
 * the process whose rename moved the file may reclaim it, and only after the
 * moved record is verified to be the SAME stale owner. If the lock changed
 * hands in between, the fresh owner's record is put back (best effort) and the
 * attempt reports "raced" so the caller refuses instead of acquiring over a
 * live replacement (round-5 finding).
 *
 * A read in the window that failed for any reason other than ENOENT (#287)
 * withholds the reclaim entirely: "no owner" is then indistinguishable from
 * "could not read", and unlinking on that answer can evict a live holder whose
 * record a concurrent rename moved aside. Nothing is renamed in that case, so
 * the next attempt re-reads rather than touching a live file.
 */
function reclaimStaleLock(
  lockPath: string,
  settled: OwnerRead,
  options: VaultLockOptions,
): "reclaimed" | "raced" | "retry" {
  if (settled.blocked) {
    options.logger?.warn(
      "VAULT_LOCK_RECLAIM_RACED",
      `a stale-lock reclaim was refused: the lock file could not be read (${settled.code ?? "unknown"}); refusing this attempt`,
    );
    return "retry";
  }
  const expected = settled.owner;
  const temp = `${lockPath}.reclaim-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    fs.renameSync(lockPath, temp);
  } catch {
    // another process moved or removed it first, so we touched nothing:
    // retry and let the exclusive create decide the winner
    return "retry";
  }
  const moved = readOwner(temp, options);
  const isSameStaleOwner =
    (expected === undefined && moved.owner === undefined && !moved.blocked) ||
    (expected !== undefined && moved.owner !== undefined && moved.owner.token === expected.token);
  if (isSameStaleOwner) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* already gone */
    }
    options.logger?.warn(
      "VAULT_LOCK_RECLAIMED",
      expected === undefined
        ? `reclaimed an unreadable lock at ${lockPath}`
        : `reclaimed a stale lock left by ${expected.host} pid ${expected.pid}`,
    );
    return "reclaimed";
  }
  // we moved a lock that had already changed hands: put the SAME inode back
  // (a hard link keeps the displaced owner's fd bound to the path) and never
  // overwrite a third lock that may have appeared in the meantime. linkSync is
  // atomic-if-absent on NTFS and POSIX; FAT/exFAT has no hard links, so the
  // rename fallback applies only when the path is still free.
  try {
    try {
      fs.linkSync(temp, lockPath);
    } catch {
      if (fs.existsSync(lockPath)) throw new Error("the lock path was recreated while restoring");
      fs.renameSync(temp, lockPath);
    }
    fs.unlinkSync(temp);
  } catch {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* already gone */
    }
  }
  options.logger?.warn(
    "VAULT_LOCK_RECLAIM_RACED",
    moved.blocked
      ? `a stale-lock reclaim was refused: the moved lock file could not be read (${moved.code ?? "unknown"}); refusing this attempt`
      : "a stale-lock reclaim lost the race to a newer owner; refusing this attempt",
  );
  return "raced";
}

/**
 * The refusal a read that settled the boot deserves. A read in which ANY
 * attempt failed for a reason other than ENOENT cannot name a holder, so it
 * gets the unreadable-lock refusal instead of a claim that another instance
 * holds the folder (#287): with every read failing, `VaultAlreadyLockedError`
 * would name no owner and tell the owner to close a copy that does not exist.
 */
function refusalForRead(read: OwnerRead, lockPath: string): Error {
  return read.blocked
    ? new VaultLockUnreadableError(lockPath, read.code)
    : new VaultAlreadyLockedError(read.owner, lockPath);
}

/**
 * Acquire the single-writer lock for `dataDir`. Throws
 * `VaultAlreadyLockedError` when a live instance holds it,
 * `VaultLockUnreadableError` when the lock file is there and no read could
 * attest to it, and `VaultLockUnavailableError` when the lock file cannot be
 * created at all (read-only media, permissions). It never returns without the
 * lock.
 */
export function acquireVaultLock(dataDir: string, options: VaultLockOptions = {}): VaultLock {
  const lockPath = path.join(dataDir, "vault.lock");
  fs.mkdirSync(dataDir, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner: VaultLockOwner = {
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      token: randomBytes(16).toString("hex"),
    };
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, JSON.stringify(owner), 0);
      try {
        fs.fsyncSync(fd);
      } catch {
        // network shares may not support fsync; the exclusive create already won
      }
      return new VaultLock(lockPath, fd, owner, options);
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      if (errnoCode(wrapped) !== "EEXIST") throw new VaultLockUnavailableError(wrapped, lockPath);
    }
    const existing = readOwner(lockPath, options);
    if (existing.owner !== undefined) {
      const verdict = holderVerdict(existing.owner, options);
      if (verdict.live) throw new VaultAlreadyLockedError(existing.owner, lockPath, verdict.staleHeartbeatOverAlivePid);
    }
    // stale (dead same-host PID, quiet foreign heartbeat, or unreadable):
    // settle so a near-simultaneous reclaimer is likely decided, then re-read
    // and re-check IMMEDIATELY before the rename. Without the second check a
    // holder whose heartbeat lands inside the settle window would be stolen
    // from; a lost race refuses this boot instead of acquiring over it.
    Bun.sleepSync(options.stealSettleMs ?? 200);
    const settled = readOwner(lockPath, options);
    if (settled.owner !== undefined) {
      const verdict = holderVerdict(settled.owner, options);
      if (verdict.live) throw new VaultAlreadyLockedError(settled.owner, lockPath, verdict.staleHeartbeatOverAlivePid);
    }
    const outcome = reclaimStaleLock(lockPath, settled, options);
    if (outcome === "raced") {
      throw refusalForRead(readOwner(lockPath, options), lockPath);
    }
    if (outcome === "retry") continue;
  }
  throw refusalForRead(readOwner(lockPath, options), lockPath);
}

/** Locks still held by this process; the single exit hook releases them all. */
const activeLocks = new Set<VaultLock>();
let exitHookInstalled = false;

function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // process.exit() (including the fail-stop paths) runs "exit" listeners
  // synchronously, so the lock file never outlives a clean or fatal exit
  process.on("exit", () => {
    for (const lock of activeLocks) lock.release();
  });
}

/**
 * The one place the lock refusal copy lives. This standalone page is served on
 * the second instance's reserved port BEFORE the web bundle exists, so it has
 * no i18n runtime and its Arabic is deliberately embedded here (the web owns
 * all in-app copy — see apps/api/src/lib/locale-neutral.test.ts).
 */
const VAULT_LOCK_PAGE_COPY = {
  title: "دكان — قيد الاستعمال",
  heading: "البيانات قيد الاستعمال",
  hint: "لا تُعدّل بيانات المتجر ولا تحذف أي ملف. أغلق النسخة الأخرى فقط.",
  fallbackHost: "جهاز غير معروف",
  unknownOwner: "البيانات مفتوحة في نسخة أخرى من دكان على هذا المجلد. أغلق النسخة الأخرى ثم أعد فتح التطبيق.",
  ownerTemplate: "البيانات مفتوحة في نسخة أخرى من دكان على هذا المجلد (الجهاز {host}، العملية {pid}). أغلق النسخة الأخرى ثم أعد فتح التطبيق.",
  /**
   * The recycled-pid story: the holder named here answers alive but stopped
   * beating, so there may be no other Dokan copy. The hint cannot say "delete
   * no file", and the message must name the lock file as the one exit.
   */
  staleHint: "لا تُعدّل بيانات المتجر. إن تأكدت من عدم وجود نسخة أخرى مفتوحة، احذف ملف vault.lock وحده.",
  staleOwnerTemplate: "القفل ممسوك بعملية لا تبدو نسخة أخرى من دكان (الجهاز {host}، العملية {pid}). إن لم تكن هناك نسخة أخرى مفتوحة، فاحذف ملف vault.lock من مجلد البيانات ثم أعد فتح التطبيق.",
  /**
   * The unreadable-lock story (#287): the file is there and no read could
   * attest to it, so no holder can be named and the folder may well be free.
   * The hint here cannot say "delete no file" — the message names the one file,
   * and deleting it is half of the only recovery the owner has.
   */
  unreadableHint: "لا تُعدّل بيانات المتجر. إن لم تكن هناك نسخة أخرى مفتوحة، فاحذف ملف vault.lock وحده.",
  unreadableTemplate: "تعذّر قراءة ملف القفل في مجلد البيانات: {path}. أغلق أي نسخة أخرى من دكان إن كانت مفتوحة، وإن لم تكن هناك نسخة مفتوحة فاحذف ملف vault.lock وحده ثم أعد فتح التطبيق.",
} as const;

/**
 * Strip a lock record's host to the hostname charset before display. The
 * record is an on-disk file, so a hostile value must never reach the page as
 * markup; the length bound is enforced by the read schema as well.
 */
function sanitizeHostForDisplay(host: string): string {
  const cleaned = host.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
  return cleaned === "" ? VAULT_LOCK_PAGE_COPY.fallbackHost : cleaned;
}

function escapeHtml(value: string): string {
  let out = "";
  for (const char of value) {
    if (char === "&") out += "&amp;";
    else if (char === "<") out += "&lt;";
    else if (char === ">") out += "&gt;";
    else if (char === '"') out += "&quot;";
    else if (char === "'") out += "&#39;";
    else out += char;
  }
  return out;
}

/**
 * What a lock refusal is about, named once for the page and for its caller. A
 * held folder is a holder to name — or one that no record named; an unreadable
 * lock file (#287) is the third variant: no holder can be named, and the page
 * carries the path to the one file whose removal is the exit.
 */
export type VaultLockRefusal =
  | { readonly kind: "held"; readonly owner: VaultLockOwner | undefined; readonly staleHeartbeatOverAlivePid: boolean }
  | { readonly kind: "unreadable"; readonly lockPath: string };

/** The Arabic refusal the page shows for the refusal's variant. */
export function vaultLockRefusalMessage(refusal: VaultLockRefusal): string {
  if (refusal.kind === "unreadable") return VAULT_LOCK_PAGE_COPY.unreadableTemplate.replace("{path}", refusal.lockPath);
  if (refusal.owner === undefined) return VAULT_LOCK_PAGE_COPY.unknownOwner;
  const template = refusal.staleHeartbeatOverAlivePid ? VAULT_LOCK_PAGE_COPY.staleOwnerTemplate : VAULT_LOCK_PAGE_COPY.ownerTemplate;
  return template.replace("{host}", sanitizeHostForDisplay(refusal.owner.host)).replace("{pid}", String(refusal.owner.pid));
}

/** The small print under the refusal: the copy that says what may be deleted. */
function vaultLockRefusalHint(refusal: VaultLockRefusal): string {
  if (refusal.kind === "unreadable") return VAULT_LOCK_PAGE_COPY.unreadableHint;
  return refusal.staleHeartbeatOverAlivePid ? VAULT_LOCK_PAGE_COPY.staleHint : VAULT_LOCK_PAGE_COPY.hint;
}

/** Standalone Arabic page for the second instance (mirrors the schema page). */
export function vaultLockRefusalPageHtml(refusal: VaultLockRefusal): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(VAULT_LOCK_PAGE_COPY.title)}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fafafa; color: #111; font-family: system-ui, sans-serif; }
      main { max-width: 32rem; margin: 1rem; padding: 2rem; background: #fff; border: 1px solid #e5e5e5; border-radius: 1rem; text-align: center; box-shadow: 0 1px 2px rgb(0 0 0 / 0.05); }
      h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
      p { line-height: 1.8; margin: 0.5rem 0; }
      .hint { color: #666; font-size: 0.875rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(VAULT_LOCK_PAGE_COPY.heading)}</h1>
      <p>${escapeHtml(vaultLockRefusalMessage(refusal))}</p>
      <p class="hint">${escapeHtml(vaultLockRefusalHint(refusal))}</p>
    </main>
  </body>
</html>
`;
}

/**
 * Close the encrypted store BEFORE releasing the single-writer lock
 * (round-5 finding): `close()` drains the persist queue and runs the final
 * checkpoint, and a replacement instance must not open the folder while the
 * exiting sidecar can still write its snapshot. Release runs in `finally` so
 * a failing close cannot strand the lock. Every main.ts shutdown path uses
 * this helper.
 */
export async function closeVaultThenReleaseLock(
  connection: { close(): Promise<void> } | undefined,
  lock: VaultLock | undefined,
): Promise<void> {
  try {
    await connection?.close();
  } finally {
    lock?.release();
  }
}

/**
 * The connection a losing holder may close at shutdown. A lost lock means
 * another copy owns the folder now, so the abandoned store is `undefined`: its
 * final checkpoint would write this instance's stale image over the new
 * owner's snapshot (ADR-0012 clause 3). Exported so this decision is pinned by
 * a unit test and main.ts cannot drift away from it.
 */
export function connectionToCloseAtShutdown<T>(
  lockLost: boolean,
  connection: T | undefined,
): T | undefined {
  return lockLost ? undefined : connection;
}

/**
 * The minimal refusal app a second instance serves on its own reserved port:
 * `/health-token` keeps the desktop shell's identity probe working, `/health`
 * answers 503, and everything else is the Arabic lock page. The API, store and
 * vault gate never start.
 */
export function createVaultLockRefusalApp(
  config: AppConfig,
  error: VaultAlreadyLockedError | VaultLockUnreadableError,
): Hono {
  const app = new Hono();
  const refusal: VaultLockRefusal =
    error instanceof VaultLockUnreadableError
      ? { kind: "unreadable", lockPath: error.lockPath }
      : { kind: "held", owner: error.owner, staleHeartbeatOverAlivePid: error.staleHeartbeatOverAlivePid };
  // the recycled-pid flag only ever refines a held refusal: an unreadable lock
  // file is a different cause with its own page, not a stale heartbeat
  const stale = refusal.kind === "held" && refusal.staleHeartbeatOverAlivePid;
  app.get("/health-token", (c) => {
    if (config.bootToken !== undefined && tokenMatches(c.req.query("token"), config.bootToken)) {
      return c.json({ ok: true, token: config.bootToken });
    }
    return c.text("not found", 404);
  });
  app.get("/health", (c) => c.json({ ok: false, error: "VAULT_LOCKED_BY_OTHER_INSTANCE" }, 503));
  // the JSON route the app actually calls, so the web never parses the HTML
  // page: 503 with the same code /health already answers. `staleHeartbeat` is
  // the discriminator the web uses to name the lock file instead of promising
  // a copy that may not exist (#283); it is absent for a genuine holder, so an
  // older web build reads exactly the #276 body.
  app.get("/api/vault/status", (c) =>
    c.json(
      stale
        ? { error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE", staleHeartbeat: true } }
        : { error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE" } },
      503,
    ),
  );
  app.all("*", (c) => c.html(vaultLockRefusalPageHtml(refusal), 503));
  return app;
}
