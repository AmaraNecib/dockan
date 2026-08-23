import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { z } from "zod";

/**
 * Port-record lifecycle: a per-process registry of live API instances plus a
 * canonical `.dokan-port` the web proxy reads. All mutation is serialized by
 * a directory lock whose exclusivity is ONLY ever broken for a dead holder.
 *
 * Guarantees (unit-tested in port-record.test.ts):
 * - mutual exclusion: exactly one critical section at a time
 * - fresh locks are never taken over (mkdir->marker window is covered by a
 *   grace period, and a read-back verify makes a displaced owner back off)
 * - takeover of a dead holder never deletes a new owner's lock (rmdir fails
 *   ENOTEMPTY on a repopulated dir)
 */

export type RegistryEntry = { host: string; port: number; pidFile: string; mtime: number };

export type LockOpts = { deadlineMs?: number; graceMs?: number };

const registryEntrySchema = z.object({ host: z.string(), port: z.number().int().positive() });

/**
 * A bind host like 0.0.0.0 or :: cannot be CONNECTED to on Windows for a
 * liveness probe; the probe always targets the loopback the proxy uses.
 */
export function probeHostFor(bindHost: string): string {
  if (bindHost === "0.0.0.0" || bindHost === "::" || bindHost === "::0" || bindHost === "0:0:0:0:0:0:0:0") {
    return "127.0.0.1";
  }
  return bindHost;
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // SAFETY: process.kill throws only ErrnoException-shaped errors
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM"; // EPERM = exists but not ours; ESRCH = gone
  }
}

/** one shared TCP probe: succeeds when {host}:{port} accepts a connection */
export function portIsReachable(host: string, port: number, timeoutMs = 150): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function markerPath(lockDir: string): string {
  return path.join(lockDir, "pid");
}

async function lockMarkerPid(lockDir: string): Promise<number | null> {
  try {
    // SAFETY: the marker is written by us as a bare pid integer
    const pid = Number(fs.readFileSync(markerPath(lockDir), "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Directory lock. mkdir is atomic (one winner); ownership is proven by a
 * write-then-read-back marker check, so a process displaced between mkdir and
 * marker write never enters the critical section. Takeover is an rmdir that
 * fails ENOTEMPTY when the dir has been repopulated, so stale decisions
 * cannot destroy a fresh owner's lock. A crashed holder is recovered only
 * when its marker's pid is dead (or the marker-less dir is older than the
 * grace window) and nobody re-claimed first.
 */
export async function withPortFileLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  opts: LockOpts = {},
): Promise<T> {
  const deadline = Date.now() + (opts.deadlineMs ?? 5000);
  const graceMs = opts.graceMs ?? 500;
  for (;;) {
    let owned = false;
    try {
      fs.mkdirSync(lockDir); // atomic: exactly one process wins
      fs.writeFileSync(markerPath(lockDir), String(process.pid), "utf8");
      // SAFETY: the marker we just wrote is a plain pid or was replaced
      owned = (await lockMarkerPid(lockDir)) === process.pid;
      if (!owned) continue; // displaced (marker overwritten): never act on it
      return await fn();
    } catch (err) {
      // SAFETY: fs errors are ErrnoException-shaped here
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // SAFETY: non-contention fs failures surface as Error objects
        console.error(`[dokan] port record lock failed: ${(err as Error).message}`);
        throw err;
      }
      const holder = await lockMarkerPid(lockDir);
      if (holder !== null && pidIsAlive(holder)) {
        if (Date.now() > deadline) {
          // live holder but stuck: never break exclusivity; degrade loudly
          console.error(`[dokan] port record lock held by live pid ${holder} for >${deadline - Date.now() + 5000}ms; skipping reconciliation`);
          throw new Error("port record lock timeout");
        }
        await Bun.sleep(25);
        continue;
      }
      if (holder === null) {
        // no marker yet: a fresh lock mid-write, or a holder that died before
        // writing its marker. Fresh locks are never taken over; only a
        // marker-less dir OLDER than the grace window counts as abandoned.
        let age = Infinity;
        try {
          // SAFETY: lock dirs are created by us; mtime is a plain number
          age = Date.now() - (fs.statSync(lockDir).mtimeMs as number);
        } catch {
          // vanished; retry the mkdir instead of taking anything over
        }
        if (age < graceMs) {
          await Bun.sleep(25);
          continue;
        }
      }
      // dead holder (or abandoned marker-less dir): take over. Remove the
      // marker first (a dead holder's marker is ours to drop — no new owner
      // can exist inside a dir that is still present), then rmdir, which
      // still fails ENOTEMPTY if a new owner repopulated the dir after the
      // unlink (double-takeover protection survives).
      try {
        fs.unlinkSync(markerPath(lockDir));
      } catch {
        // no marker (abandoned-before-marker case) or already gone
      }
      try {
        fs.rmdirSync(lockDir);
      } catch {
        // ENOTEMPTY / ENOENT / ENOTDIR: someone else owns it — keep looping
      }
    } finally {
      if (owned) {
        // we are free to release: only our own marker/dir
        try {
          const mine = (await lockMarkerPid(lockDir)) === process.pid;
          if (mine) fs.unlinkSync(markerPath(lockDir));
        } catch {
          // already gone
        }
        try {
          fs.rmdirSync(lockDir);
        } catch {
          // repopulated: the new owner holds the lock now
        }
      }
    }
  }
}

export function ownRegistryEntry(registryDir: string, pid: number): string {
  return path.join(registryDir, String(pid));
}

export function writeRegistryEntry(registryDir: string, pid: number, host: string, port: number): void {
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(ownRegistryEntry(registryDir, pid), JSON.stringify({ host: probeHostFor(host), port }), "utf8");
}

/**
 * Parses one registry entry file; prunes entries whose pid is dead. The host
 * is normalized to the probeable loopback so wildcard binds never get pruned
 * by an unconnectable probe (review finding).
 */
export function readRegistryEntry(registryDir: string, name: string): RegistryEntry | null {
  const pidFile = path.join(registryDir, name);
  const pid = Number(name);
  if (!Number.isFinite(pid) || !pidIsAlive(pid)) {
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // already gone
    }
    return null;
  }
  let host = "127.0.0.1";
  let port = NaN;
  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    // parse at the I/O boundary, then branch on the domain value
    const parsed = registryEntrySchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      host = parsed.data.host;
      port = parsed.data.port;
    } else if (/^\d+$/.test(raw)) {
      // legacy entries were bare integer ports, written by us
      // SAFETY: the regex already established digits-only
      port = Number(raw);
    } else {
      return null;
    }
  } catch {
    return null;
  }
  if (!Number.isFinite(port) || port <= 0) return null;
  // SAFETY: mtime of our own entry file is safe Date material
  const mtime = (fs.statSync(pidFile).mtimeMs as number) || 0;
  return { host: probeHostFor(host), port, pidFile, mtime };
}

/**
 * Latest-live survivor's {host, port}, or null when nobody is reachable.
 * Entries are probed newest-first on their own (normalized) bound host.
 */
export async function recomputeCanonical(
  registryDir: string,
  reachable: (host: string, port: number) => Promise<boolean> = portIsReachable,
): Promise<{ host: string; port: number } | null> {
  let files: string[] = [];
  try {
    files = fs.readdirSync(registryDir);
  } catch {
    return null; // no registry yet
  }
  const entries = files
    .map((name) => readRegistryEntry(registryDir, name))
    .filter((e): e is RegistryEntry => e !== null)
    .sort((a, b) => b.mtime - a.mtime);

  for (const entry of entries) {
    if (await reachable(entry.host, entry.port)) return { host: entry.host, port: entry.port };
    try {
      fs.unlinkSync(entry.pidFile);
    } catch {
      // already gone
    }
  }
  return null;
}

export type ForgetPortArgs = {
  portFile: string;
  lockDir: string;
  registryDir: string;
  pid: number;
};

/**
 * Remove our registry entry, then point the canonical at the newest
 * surviving instance (or delete it when none is up). Swallows lock-timeout
 * degradation: the canonical is left untouched rather than corrupted.
 */
export async function forgetPort(args: ForgetPortArgs): Promise<void> {
  try {
    await withPortFileLock(args.lockDir, async () => {
      try {
        fs.unlinkSync(ownRegistryEntry(args.registryDir, args.pid));
      } catch {
        // not registered — still reconcile
      }
      const survivor = await recomputeCanonical(args.registryDir);
      if (survivor === null) {
        try {
          fs.unlinkSync(args.portFile);
        } catch {
          // already gone
        }
      } else {
        fs.writeFileSync(args.portFile, String(survivor.port), "utf8");
      }
    });
  } catch {
    // live holder stuck: leave the canonical untouched rather than corrupt it
  }
}