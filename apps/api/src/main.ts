import fs from "node:fs";
import path from "node:path";

import { serve } from "@hono/node-server";
import { serveStatic } from "hono/bun";
import { Hono } from "hono";

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

// A fresh install's app-data folder does not exist yet. Nothing else creates
// it (backup copy targets <dataDir>/backups, the logger makes <dataDir>/logs),
// so the process would die on first openConnection; make the whole tree now.
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, "backups"), { recursive: true });

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
 * Packaged builds: the desktop webview loads the api's origin, so the api
 * also serves the built UI (static files plus an SPA fallback to index.html
 * for client-routed paths). Dev/e2e never set DOKAN_WEB_DIST — the vite dev
 * server owns the frontend there. The api app itself (createApp) is untouched.
 *
 * Composition order matters: the api app is NOT mounted (its router would
 * swallow unmatched paths with a 404 and block the fallback); instead only
 * the api-owned prefixes are forwarded to it, then static files, then the
 * SPA fallback. serveStatic calls next() on a miss.
 */
let requestHandler: (request: Request) => Response | Promise<Response> = (req) => app.fetch(req);

if (config.webDataDir !== undefined) {
  const webRoot = config.webDataDir;
  // A missing ui folder means a broken install — the api must still boot (the
  // desktop window falls back to the bundled frontendDist UI whose in-app
  // error states surface the problem) instead of dying before first request.
  let index: string | undefined;
  try {
    index = await fs.promises.readFile(path.join(webRoot, "index.html"), "utf8");
  } catch (err) {
    logger.error("WEB_UI_SERVE_FAILED", "packaged ui missing; serving api only", err instanceof Error ? err : new Error(String(err)));
  }
  if (index !== undefined) {
    const ui = new Hono();
    ui.use("*", async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      if (pathname === "/health" || pathname === "/api" || pathname.startsWith("/api/")) {
        return app.fetch(c.req.raw);
      }
      return next();
    });
    ui.use("*", serveStatic({ root: webRoot }));
    ui.use("*", async (c) => c.html(index));
    requestHandler = (req) => ui.fetch(req);
    logger.info("WEB_UI_SERVED", "serving packaged ui from " + webRoot);
  }
}

/**
 * Workspace root = the directory containing .git (repo anchor), used only in
 * dev/e2e. Packaged builds redirect the record via DOKAN_PORT_ROOT, so the
 * port record never lands in an install folder or a user's home tree.
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
const portRecordDir = config.portRecordDir ?? findWorkspaceRoot();
// Packaged builds point the record at a fresh app-data/run folder; create it
// so the lock mkdir below never fails. Dev's workspace root always exists.
if (config.portRecordDir !== undefined) fs.mkdirSync(portRecordDir, { recursive: true });
const portFile = path.resolve(portRecordDir, ".dokan-port");
const portLockDir = path.join(portRecordDir, ".dokan-port.lock");
const registryDir = path.join(portRecordDir, ".dokan-port.registry");

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
  { fetch: requestHandler, port, hostname: config.host },
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