import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { serve } from "@hono/node-server";

import { createApp, type AppDeps } from "./app";
import { createAuth } from "./auth/auth";
import { createAppConfig } from "./config";
import { openConnection } from "./db/connection";
import { AppLogger } from "./lib/logger";
import { createRpcRouter } from "./rpc/router";
import { createDrizzleStore } from "./store/drizzle-store";

/**
 * Boot: config, logger, the one StorePort seam, auth, rpc, the app, then the
 * server. main.ts knows seams, not SQL (ADR-0003).
 */
const config = createAppConfig();
const logger = new AppLogger(config.dataDir);
const conn = openConnection(config);
const store = createDrizzleStore(conn);

await store.setup();
const auth = createAuth(conn.db, config);
const rpcRouter = createRpcRouter({ db: conn.db, config, logger, store, auth });
const deps: AppDeps = { config, logger, auth, rpcRouter };
const app = createApp(deps);
logger.info("SERVER_BOOT_DONE", "database and auth ready", { driver: config.db.driver });

/**
 * Workspace root = the directory containing .git (repo anchor).
 */
function findWorkspaceRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/**
 * The user is not technical; a busy default port must not crash the app.
 * Probe upward from the configured port until one is free, then serve there.
 * The chosen port is recorded for the web proxy (vite reads .dokan-port). */
async function firstFreePort(start: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = (port: number): void => {
      const socket = net.createConnection({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        if (port - start < 25) probe(port + 1);
        else reject(new Error("no free port found for the api"));
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(port);
      });
    };
    probe(start);
  });
}

// An explicitly configured port is authoritative: falling back silently
// would desync the proxy and point traffic at an unrelated process (greptile
// P1). Without an explicit port, probe upward and record the winner; the web
// proxy prefers that record.
const port = config.portExplicit ? config.port : await firstFreePort(config.port, config.host);
const portFile = path.resolve(findWorkspaceRoot(), ".dokan-port");
const portLockFile = path.join(path.dirname(portFile), ".dokan-port.lock");
const registryDir = path.join(path.dirname(portFile), ".dokan-port.registry");

/**
 * Exclusive lock so read-compare-delete and write are atomic against each
 * other: a concurrent boot can never overwrite the record between our
 * comparison and our unlink (greptile 4/5 follow-up). On a crashed holder the
 * deadline force-unlinks the lock so the workspace never stalls.
 */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // SAFETY: process.kill throws only ErrnoException-shaped errors
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM"; // EPERM = exists but not ours; ESRCH = gone
  }
}

/** holder's pid, or null when the lockfile is not yet/fully written */
function lockHolderPid(): number | null {
  try {
    // SAFETY: the lock file is written by us as a bare pid integer
    const pid = Number(fs.readFileSync(portLockFile, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * pidfile lock: exclusivity is only ever broken when the HOLDER IS DEAD
 * (crash recovery). A live holder that is slow (long reconcile) is waited on,
 * never preempted — breaking a live holder's section is what corrupted the
 * canonical before (greptile follow-up).
 */
async function withPortFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fd = fs.openSync(portLockFile, "wx");
      // SAFETY: the fd from openSync("wx") is a valid writable handle for ints
      fs.writeFileSync(fd, String(process.pid), { encoding: "utf8" });
      try {
        // hold the lock while fn (which may await liveness probes) settles:
        // no other instance can write/delete the canonical mid-reconcile
        return await fn();
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(portLockFile);
        } catch {
          // already gone
        }
      }
    } catch (err) {
      // SAFETY: errno access is only meaningful for Error values, which the
      // fs API is guaranteed to throw; the narrowing keeps the guard type-clean
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") {
        // not a contention error: report it rather than spin forever
        // SAFETY: Error is what the fs API throws; the assertion only narrows it
        console.error(`[dokan] port record lock failed: ${(err as Error).message}`);
        throw err;
      }
      const holder = lockHolderPid();
      if (holder === null || !pidIsAlive(holder)) {
        // crashed holder (or write race on a fresh lock): take it over
        try {
          fs.unlinkSync(portLockFile);
        } catch {
          // already gone
        }
        continue;
      }
      if (Date.now() > deadline) {
        // live holder but stuck: refuse to corrupt the record; degrade loudly
        console.error(`[dokan] port record lock held by live pid ${holder} for >5s; skipping reconciliation`);
        throw new Error("port record lock timeout");
      }
      Bun.sleepSync(25);
    }
  }
}

/**
 * One registry entry per live API process (pid -> port), and a canonical
 * .dokan-port for the proxy. The canonical always reflects the newest LIVE
 * instance: when any instance closes it recomputes from the surviving
 * entries, so closing one can never leave Vite pointing past a still-running
 * API (greptile 4/5 follow-up). Dead entries self-heal via liveness probe.
 */
function ownRegistryEntry(): string {
  return path.join(registryDir, String(process.pid));
}

function portIsReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(150);
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

/** newest-first live survivor's port, or null when nobody is reachable */
async function recomputeCanonical(): Promise<number | null> {
  let files: string[] = [];
  try {
    files = fs.readdirSync(registryDir);
  } catch {
    return null; // no registry yet
  }
  const entries = files
    .map((name) => {
      const pidFile = path.join(registryDir, name);
      const pid = Number(name);
      if (!Number.isFinite(pid) || !pidIsAlive(pid)) {
        // dead pid: a leftover entry cannot own a live API; prune it
        try {
          fs.unlinkSync(pidFile);
        } catch {
          // already gone
        }
        return null;
      }
      let port = NaN;
      try {
        // SAFETY: the file is written by us as a bare integer
        port = Number(fs.readFileSync(pidFile, "utf8").trim());
      } catch {
        return null;
      }
      // SAFETY: mtime of our own integer file is safe Date material
      const mtime = (fs.statSync(pidFile).mtimeMs as number) || 0;
      return { pidFile, port, mtime };
    })
    .filter((e): e is { pidFile: string; port: number; mtime: number } => e !== null && Number.isFinite(e.port))
    .sort((a, b) => b.mtime - a.mtime);

  for (const entry of entries) {
    if (await portIsReachable(entry.port)) return entry.port;
    // unreachable -> stale entry; drop it so the canonical can't re-pick it
    try {
      fs.unlinkSync(entry.pidFile);
    } catch {
      // already gone
    }
  }
  return null;
}

/**
 * Remove our registry entry, then point the canonical at the newest
 * surviving instance (or delete it when none is up).
 */
async function forgetPort(): Promise<void> {
  try {
    await withPortFileLock(async () => {
      try {
        fs.unlinkSync(ownRegistryEntry());
      } catch {
        // not registered (bind failed before callback) — still reconcile
      }
      const survivor = await recomputeCanonical();
      if (survivor === null) {
        try {
          fs.unlinkSync(portFile);
        } catch {
          // already gone
        }
      } else {
        fs.writeFileSync(portFile, String(survivor), "utf8");
      }
    });
  } catch {
    // live holder stuck: leave the canonical untouched rather than corrupt it
  }
}

const server = serve(
  { fetch: app.fetch, port, hostname: config.host },
  async (info) => {
    // record the port that actually bound: for fallback/ephemeral binds this
    // differs from the configured value and must be what the proxy trusts.
    // A publication failure is a boot failure: running while Vite still walks
    // the previous record would strand /api traffic, so fail loudly (before
    // logging the server as started) instead of discarding the rejection.
    try {
      await withPortFileLock(async () => {
        fs.mkdirSync(registryDir, { recursive: true });
        fs.writeFileSync(ownRegistryEntry(), String(info.port), "utf8");
        fs.writeFileSync(portFile, String(info.port), "utf8");
      });
    } catch (err) {
      // SAFETY: every rejection path throws an Error (lock timeout / fs error)
      logger.error("SERVER_ERROR", `port record publication failed after binding ${info.port}`, err as Error);
      process.exit(1);
    }
    logger.info("SERVER_STARTED", "Dokan API booted", {
      url: `http://${info.address}:${info.port}`,
      version: config.version,
    });
    console.log(`Dokan API listening on http://${info.address}:${info.port}`);
  },
);

// an explicit port that still collides is a hard failure, never a silent
// rebind that would desync the proxy (greptile P1)
server.on("error", async (err: NodeJS.ErrnoException) => {
  logger.error("SERVER_ERROR", `could not bind ${config.host}:${port}`, err);
  await forgetPort();
  process.exit(1);
});

// graceful shutdown: reconcile FIRST (registry removed, canonical pointed at
// a survivor), then tear down the db and exit — single listener, so no
// shutdown path can exit before the reconcile finishes
server.on("close", async () => {
  await forgetPort();
  conn.close();
  process.exit(0);
});

function beginShutdown(): void {
  server.close();
  // a stuck close (keep-alive connection) must not hang the kiosk forever;
  // the forced path still awaits the full reconcile before exiting
  setTimeout(async () => {
    await forgetPort();
    process.exit(0);
  }, 3000).unref();
}

process.on("SIGINT", beginShutdown);
process.on("SIGTERM", beginShutdown);