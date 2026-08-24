import fs from "node:fs";
import path from "node:path";

import { serve } from "@hono/node-server";

import {
  forgetPort as forgetPortRecord,
  portIsReachable,
  publishPort,
} from "./lib/port-record";

import { createApp, type AppDeps } from "./app";
import { createAuth } from "./auth/auth";
import { createAppConfig } from "./config";
import { openConnection } from "./db/connection";
import { ensureDailyBackup } from "./lib/backups";
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

// daily startup backup (ticket 13): one copy per Algeria-local day. A failed
// backup is logged loudly but must not block boot — a full disk should not
// stop the shop from selling.
try {
  const daily = await ensureDailyBackup({ store, dataDir: config.dataDir });
  if (daily.created) {
    await store.insertActivity({
      type: "BACKUP_CREATED",
      summary: `نسخة احتياطية يومية ${daily.path.split(/[\\/]/).pop()}`,
      ref: daily.path,
    });
  }
} catch (err) {
  logger.error("SERVER_ERROR", "daily startup backup failed", err instanceof Error ? err : new Error(String(err)));
}

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


// An explicitly configured port is authoritative: falling back silently
// would desync the proxy and point traffic at an unrelated process (greptile
// P1). Without an explicit port, probe upward and record the winner; the web
// proxy prefers that record.
const port = config.portExplicit ? config.port : await firstFreePort(config.port, config.probeHost);
const portFile = path.resolve(findWorkspaceRoot(), ".dokan-port");
const portLockDir = path.join(path.dirname(portFile), ".dokan-port.lock");
const registryDir = path.join(path.dirname(portFile), ".dokan-port.registry");

async function firstFreePort(start: number, host: string): Promise<number> {
  for (let candidate = start; candidate < start + 25; candidate++) {
    if (!(await portIsReachable(host, candidate, 200))) return candidate;
  }
  throw new Error("no free port found for the api");
}

/**
 * Shutdown reconcile: remove our registry entry, then point the canonical at
 * the newest surviving instance (or delete it when none is up). Every exit
 * path awaits this before leaving, so discovery never strands the proxy.
 */
async function forgetPort(): Promise<void> {
  await forgetPortRecord({ portFile, lockDir: portLockDir, registryDir, pid: process.pid });
}

/** Cleanup must be observable: exiting successfully after a failed reconcile
 * leaves the proxy with stale discovery data. */
async function reconcileBeforeExit(): Promise<void> {
  try {
    await forgetPort();
  } catch (err) {
    logger.error(
      "SERVER_ERROR",
      "port record cleanup failed before exit",
      err instanceof Error ? err : new Error(String(err)),
    );
    conn.close();
    process.exit(1);
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
      await publishPort({
        portFile,
        lockDir: portLockDir,
        registryDir,
        pid: process.pid,
        host: config.host,
        port: info.port,
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
  await reconcileBeforeExit();
  process.exit(1);
});

// graceful shutdown: reconcile FIRST (registry removed, canonical pointed at
// a survivor), then tear down the db and exit — single listener, so no
// shutdown path can exit before the reconcile finishes
server.on("close", async () => {
  await reconcileBeforeExit();
  conn.close();
  process.exit(0);
});

function beginShutdown(): void {
  server.close();
  // a stuck close (keep-alive connection) must not hang the kiosk forever;
  // the forced path still awaits the full reconcile before exiting
  setTimeout(async () => {
    await reconcileBeforeExit();
    conn.close();
    process.exit(0);
  }, 3000).unref();
}

process.on("SIGINT", beginShutdown);
process.on("SIGTERM", beginShutdown);