import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Hono } from "hono";
import { z } from "zod";

import type { AppConfig } from "../../config";
import { tokenMatches } from "../boot-token";

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
 *   - same host: the PID must be gone (`process.kill(pid, 0)` → ESRCH);
 *   - another host (a stick moved while a process was killed): the heartbeat
 *     must be older than 60s, because a live remote process keeps beating.
 * The heartbeat is what makes the portable-stick case recoverable without ever
 * trusting a clock-only timeout for a live same-host process.
 *
 * Losing the lock file while running (someone deleted it) is fail-stop: the
 * `onLost` callback fires so the caller can exit rather than run without
 * exclusivity. The module never exits by itself when `onLost` is provided.
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
  host: z.string().min(1),
  startedAt: z.string(),
  heartbeatAt: z.string(),
  token: z.string().min(1),
});

export type VaultLockLogger = {
  warn(event: string, message: string): void;
  error(event: string, message: string, error?: Error): void;
};

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
  /** fail-stop hook: the lock disappeared or became unwritable while held */
  onLost?: (reason: string) => void;
};

export class VaultAlreadyLockedError extends Error {
  constructor(
    readonly owner: VaultLockOwner | undefined,
    readonly lockPath: string,
  ) {
    super(
      owner === undefined
        ? `another Dokan instance is using this data folder (${lockPath})`
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

function errnoCode(error: Error): string | undefined {
  if (!("code" in error)) return undefined;
  // SAFETY: the `"code" in error` probe above established the NodeJS errno shape
  return (error as NodeJS.ErrnoException).code;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else
    return error instanceof Error && errnoCode(error) === "EPERM";
  }
}

function readOwnerOnce(lockPath: string): VaultLockOwner | undefined {
  try {
    const parsed = ownerSchema.safeParse(JSON.parse(fs.readFileSync(lockPath, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function readOwner(lockPath: string, options: VaultLockOptions): VaultLockOwner | undefined {
  const retries = options.readRetries ?? 20;
  const delayMs = options.readRetryDelayMs ?? 50;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (!fs.existsSync(lockPath)) return undefined;
    const owner = readOwnerOnce(lockPath);
    if (owner !== undefined) return owner;
    // a creator may still be writing its JSON; retry before calling it stale
    if (attempt < retries) Bun.sleepSync(delayMs);
  }
  return undefined;
}

/** True when the recorded holder is (or may be) still running. */
function holderIsLive(owner: VaultLockOwner, options: VaultLockOptions): boolean {
  if (owner.host === os.hostname()) return isAlive(owner.pid);
  const heartbeat = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeat)) return false;
  return Date.now() - heartbeat <= (options.staleHeartbeatMs ?? 60_000);
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

  private arm(): void {
    activeLocks.add(this);
    ensureExitHook();
    this.timer = setInterval(() => this.heartbeat(), this.options.heartbeatIntervalMs ?? 10_000);
    // the heartbeat must never keep a closing process alive
    this.timer.unref?.();
  }

  private heartbeat(): void {
    if (this.released || this.fd === undefined) return;
    try {
      if (!fs.existsSync(this.path)) {
        this.lost("the lock file disappeared");
        return;
      }
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

  private lost(reason: string): void {
    this.options.logger?.error("VAULT_LOCK_LOST", `the single-writer lock was lost: ${reason}`);
    const handler = this.options.onLost;
    this.release();
    if (handler !== undefined) handler(reason);
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
    try {
      const current = readOwnerOnce(this.path);
      if (current !== undefined && current.token !== this.owner.token) return;
      fs.unlinkSync(this.path);
    } catch {
      /* already gone */
    }
  }
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
    // settle, re-read, then remove only if the same stale owner is still there
    Bun.sleepSync(options.stealSettleMs ?? 200);
    const current = readOwner(lockPath, options);
    if (existing !== undefined && current !== undefined && current.token !== existing.token) continue;
    try {
      fs.unlinkSync(lockPath);
      options.logger?.warn(
        "VAULT_LOCK_RECLAIMED",
        existing === undefined
          ? `reclaimed an unreadable lock at ${lockPath}`
          : `reclaimed a stale lock left by ${existing.host} pid ${existing.pid}`,
      );
    } catch {
      /* another process raced us; the next attempt sees its fresh lock */
    }
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

/** The Arabic refusal shown when another instance owns the folder. */
export function vaultLockRefusalMessage(owner: VaultLockOwner | undefined): string {
  if (owner === undefined) {
    return "البيانات مفتوحة في نسخة أخرى من دكان على هذا المجلد. أغلق النسخة الأخرى ثم أعد فتح التطبيق.";
  }
  return (
    `البيانات مفتوحة في نسخة أخرى من دكان على هذا المجلد (الجهاز ${owner.host}، العملية ${owner.pid}). ` +
    "أغلق النسخة الأخرى ثم أعد فتح التطبيق."
  );
}

/** Standalone Arabic page for the second instance (mirrors the schema page). */
export function vaultLockRefusalPageHtml(owner: VaultLockOwner | undefined): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>دكان — قيد الاستعمال</title>
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
      <h1>البيانات قيد الاستعمال</h1>
      <p>${vaultLockRefusalMessage(owner)}</p>
      <p class="hint">لا تُعدّل بيانات المتجر ولا تحذف أي ملف. أغلق النسخة الأخرى فقط.</p>
    </main>
  </body>
</html>
`;
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
  app.all("*", (c) => c.html(vaultLockRefusalPageHtml(error.owner), 503));
  return app;
}
