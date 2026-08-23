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
/** the port this process actually bound (set in the serve callback) */
let boundPort: number | null = null;
const portLockFile = path.join(path.dirname(portFile), ".dokan-port.lock");

/**
 * Exclusive lock so read-compare-delete and write are atomic against each
 * other: a concurrent boot can never overwrite the record between our
 * comparison and our unlink (greptile 4/5 follow-up). On a crashed holder the
 * deadline force-unlinks the lock so the workspace never stalls.
 */
function withPortFileLock(fn: () => void): void {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      const fd = fs.openSync(portLockFile, "wx");
      try {
        fn();
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(portLockFile);
        } catch {
          // already gone
        }
      }
      return;
    } catch (err) {
      // SAFETY: errno access is only meaningful for Error values, which the
      // fs API is guaranteed to throw; the narrowing keeps the guard type-clean
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") {
        // not a contention error: report it rather than spin forever
        // SAFETY: Error is what the fs API throws; the assertion only narrows it
        console.error(`[dokan] port record lock failed: ${(err as Error).message}`);
        return;
      }
      if (Date.now() > deadline) {
        try {
          fs.unlinkSync(portLockFile);
        } catch {
          // give up quietly; the record logic still works degraded
        }
        continue;
      }
      Bun.sleepSync(25);
    }
  }
}

/**
 * The record is written only after the bind succeeds and removed on
 * close/error — but only when the file still holds OUR port and we hold the
 * lock, so a newer overlapping server's record can never be deleted.
 */
function forgetPort(): void {
  if (boundPort === null) return;
  withPortFileLock(() => {
    try {
      if (Number(fs.readFileSync(portFile, "utf8").trim()) === boundPort) {
        fs.unlinkSync(portFile);
      }
    } catch {
      // already gone
    }
  });
}

const server = serve(
  { fetch: app.fetch, port, hostname: config.host },
  (info) => {
    // record the port that actually bound: for fallback/ephemeral binds this
    // differs from the configured value and must be what the proxy trusts
    boundPort = info.port;
    withPortFileLock(() => {
      fs.writeFileSync(portFile, String(info.port), "utf8");
    });
    logger.info("SERVER_STARTED", "Dokan API booted", {
      url: `http://${info.address}:${info.port}`,
      version: config.version,
    });
    console.log(`Dokan API listening on http://${info.address}:${info.port}`);
  },
);

// an explicit port that still collides is a hard failure, never a silent
// rebind that would desync the proxy (greptile P1)
server.on("error", (err: NodeJS.ErrnoException) => {
  logger.error("SERVER_ERROR", `could not bind ${config.host}:${port}`, err);
  forgetPort();
  process.exit(1);
});

// graceful shutdown of any kind removes the record too; the close listener
// below (registered after) then tears down and exits, so forgetPort always runs
server.on("close", forgetPort);
server.on("close", () => {
  conn.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  server.close();
  // a stuck close (keep-alive connection) must not hang the kiosk forever;
  // and the forced path still removes the port record before exiting
  setTimeout(() => {
    forgetPort();
    process.exit(0);
  }, 3000).unref();
});