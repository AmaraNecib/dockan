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
 * holding `vault.lock`) and a record caught mid-write are `unreadable`, not
 * missing, so the holder retries them a bounded number of times and only then
 * fails closed. `ENOENT` and a different owner's token still lose the lock at
 * once, so this is not a new way to strand the folder. `release()` never
 * unlinks a record it could not read, for the same reason: an unreadable file
 * may be a new owner's.
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
   * cannot be read (`EACCES`/`EBUSY`/`EPERM`, or a record caught mid-write),
   * before the holder fails closed (#281); 10 x 100 ms by default, which is a
   * whole second of patience for an antivirus scanner holding the file — the
   * holder never fails closed wrongly, and a genuine theft is not delayed by
   * it (a replacement record or a missing file is judged on the first read)
   */
  transientReadRetries?: number;
  transientReadRetryDelayMs?: number;
  /** the lock-file read; injectable so tests can force a read error (#281) */
  readLockFile?: VaultLockFileReader;
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
   */
  constructor(
    readonly owner: VaultLockOwner | undefined,
    readonly lockPath?: string,
  ) {
    super(
      owner === undefined
        ? `another Dokan instance is using this data folder${lockPath === undefined ? "" : ` (${lockPath})`}`
        : `another Dokan instance is using this data folder (${owner.host}, pid ${owner.pid})`,
    );
    this.name = "VaultAlreadyLockedError";
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
 * One read of the lock file, classified (#281). `ENOENT` is the only canonical
 * "gone": the path does not resolve, so there is nothing left to hold. Every
 * other failure — a sharing violation (`EACCES`/`EBUSY`/`EPERM`), an I/O error,
 * or a record that does not parse or does not satisfy the schema — is
 * `unreadable`: the file is there and may well be ours, we just cannot attest
 * to it at this instant. A record another instance is in the middle of writing
 * — a reclaim renames our file away and creates its own before writing it —
 * is one way to see `MALFORMED` on a perfectly healthy lock.
 */
type LockFileRead =
  | { readonly kind: "owner"; readonly owner: VaultLockOwner }
  | { readonly kind: "gone" }
  | { readonly kind: "unreadable"; readonly code: string; readonly error: Error };

function lockFileReader(options: VaultLockOptions): VaultLockFileReader {
  return options.readLockFile ?? ((lockPath: string) => fs.readFileSync(lockPath, "utf8"));
}

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
    return { kind: "unreadable", code: "MALFORMED", error: new Error("the record did not parse as JSON") };
  }
  const parsed = ownerSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: "unreadable", code: "MALFORMED", error: new Error("the record did not satisfy the owner schema") };
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
 * The acquisition path's read: "what, if anything, does the lock file say?".
 * `gone` and an error that does not clear within the budget both answer
 * `undefined`, which the caller treats as reclaimable — unchanged from before
 * #281, which is what keeps an unreadable stale lock from blocking a boot.
 */
function readOwner(lockPath: string, options: VaultLockOptions): VaultLockOwner | undefined {
  const retries = retryBudget(options.readRetries, 20, MAX_RETRY_ATTEMPTS);
  const delayMs = retryBudget(options.readRetryDelayMs, 50, MAX_RETRY_DELAY_MS);
  const reader = lockFileReader(options);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const read = readOwnerOnce(lockPath, reader);
    if (read.kind === "owner") return read.owner;
    if (read.kind === "gone") return undefined;
    // a creator may still be writing its JSON, or another process holds the
    // file open: retry before calling the lock stale (and reclaimable)
    if (attempt < retries) Bun.sleepSync(delayMs);
  }
  return undefined;
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
 * True when the recorded holder is (or may be) still running.
 *
 * On this host the pid probe is exact whenever it answers: no throw is alive,
 * `ESRCH` is gone, and anything else is inconclusive, so the recorded
 * heartbeat decides. A pid that answers as alive still wins over an old
 * heartbeat (the round-5 rule); only the unknowable case changes (ADR-0012).
 */
function holderIsLive(owner: VaultLockOwner, options: VaultLockOptions): boolean {
  if (owner.host !== os.hostname()) return heartbeatIsFresh(owner, options);
  const probe = options.probePid ?? probePidLiveness;
  const liveness: PidLiveness = probe(owner.pid);
  if (liveness === "alive") return true;
  if (liveness === "gone") return false;
  return heartbeatIsFresh(owner, options);
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
  // the window bounds the stall whatever the knobs say: this runs inside
  // `writeGuard`, so an unbounded wait here is an unbounded stalled write
  const budgetEndsAt = Date.now() + MAX_HELD_RETRY_WINDOW_MS;
  const codes: string[] = [];
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
    // and a code is only ever a token, never a smuggled log line
    const code = oneLine(read.code, 40);
    if (!codes.includes(code)) codes.push(code);
    if (attempt >= retries || Date.now() >= budgetEndsAt) {
      // every code seen, the attempt count and the OS's own sentence ride in
      // the reason, which `lost()` logs as VAULT_LOCK_LOST: the api's log
      // vocabulary is a contract shared with the web badge, so a new event
      // code is not this module's to add
      return {
        kind: "lost",
        reason: `the lock file could not be read (${codes.join(", ")} after ${attempt + 1} attempts: ${oneLine(read.error.message)})`,
      };
    }
    Bun.sleepSync(Math.min(delayMs, Math.max(0, budgetEndsAt - Date.now())));
  }
}

export class VaultLock {
  readonly path: string;
  private fd: number | undefined;
  private owner: VaultLockOwner;
  private timer: ReturnType<typeof setInterval> | undefined;
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
    // an unreadable record is never unlinked: the token cannot be compared, so
    // the file may be a new owner's (#281). The cost is a stale file, which the
    // next boot reclaims through the pid probe; the cost of deleting it would be
    // dropping a fresh owner's lock. ONE read only, deliberately: release runs
    // from the exit hook, and sleeping there to chase a file this process is
    // about to stop caring about is worse than leaving it (critic N3).
    if (read.kind === "unreadable") return;
    if (read.kind === "owner" && read.owner.token !== this.owner.token) return;
    try {
      fs.unlinkSync(this.path);
    } catch {
      /* already gone */
    }
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
 */
function reclaimStaleLock(
  lockPath: string,
  expected: VaultLockOwner | undefined,
  options: VaultLockOptions,
): "reclaimed" | "raced" | "retry" {
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
    (expected === undefined && moved === undefined) ||
    (expected !== undefined && moved !== undefined && moved.token === expected.token);
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
  options.logger?.warn("VAULT_LOCK_RECLAIM_RACED", "a stale-lock reclaim lost the race to a newer owner; refusing this attempt");
  return "raced";
}

/**
 * Acquire the single-writer lock for `dataDir`. Throws
 * `VaultAlreadyLockedError` when a live instance holds it, and
 * `VaultLockUnavailableError` when the lock file cannot be created at all
 * (read-only media, permissions). It never returns without the lock.
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
    if (existing !== undefined && holderIsLive(existing, options)) throw new VaultAlreadyLockedError(existing, lockPath);
    // stale (dead same-host PID, quiet foreign heartbeat, or unreadable):
    // settle so a near-simultaneous reclaimer is likely decided, then re-read
    // and re-check IMMEDIATELY before the rename. Without the second check a
    // holder whose heartbeat lands inside the settle window would be stolen
    // from; a lost race refuses this boot instead of acquiring over it.
    Bun.sleepSync(options.stealSettleMs ?? 200);
    const settled = readOwner(lockPath, options);
    if (settled !== undefined && holderIsLive(settled, options)) throw new VaultAlreadyLockedError(settled, lockPath);
    const outcome = reclaimStaleLock(lockPath, settled, options);
    if (outcome === "raced") {
      throw new VaultAlreadyLockedError(readOwner(lockPath, options), lockPath);
    }
    if (outcome === "retry") continue;
  }
  throw new VaultAlreadyLockedError(readOwner(lockPath, options), lockPath);
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

/** The Arabic refusal shown when another instance owns the folder. */
export function vaultLockRefusalMessage(owner: VaultLockOwner | undefined): string {
  if (owner === undefined) return VAULT_LOCK_PAGE_COPY.unknownOwner;
  return VAULT_LOCK_PAGE_COPY.ownerTemplate
    .replace("{host}", sanitizeHostForDisplay(owner.host))
    .replace("{pid}", String(owner.pid));
}

/** Standalone Arabic page for the second instance (mirrors the schema page). */
export function vaultLockRefusalPageHtml(owner: VaultLockOwner | undefined): string {
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
      <p>${escapeHtml(vaultLockRefusalMessage(owner))}</p>
      <p class="hint">${escapeHtml(VAULT_LOCK_PAGE_COPY.hint)}</p>
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
export function createVaultLockRefusalApp(config: AppConfig, error: VaultAlreadyLockedError): Hono {
  const app = new Hono();
  app.get("/health-token", (c) => {
    if (config.bootToken !== undefined && tokenMatches(c.req.query("token"), config.bootToken)) {
      return c.json({ ok: true, token: config.bootToken });
    }
    return c.text("not found", 404);
  });
  app.get("/health", (c) => c.json({ ok: false, error: "VAULT_LOCKED_BY_OTHER_INSTANCE" }, 503));
  // the JSON route the app actually calls, so the web never parses the HTML
  // page: 503 with the same code /health already answers
  app.get("/api/vault/status", (c) => c.json({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE" } }, 503));
  app.all("*", (c) => c.html(vaultLockRefusalPageHtml(error.owner), 503));
  return app;
}
