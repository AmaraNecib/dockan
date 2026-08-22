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

const port = await firstFreePort(config.port, config.host);
fs.writeFileSync(path.resolve(findWorkspaceRoot(), ".dokan-port"), String(port), "utf8");

const server = serve(
  { fetch: app.fetch, port, hostname: config.host },
  (info) => {
    logger.info("SERVER_STARTED", "Dokan API booted", {
      url: `http://${info.address}:${info.port}`,
      version: config.version,
    });
    console.log(`Dokan API listening on http://${info.address}:${info.port}`);
  },
);

process.on("SIGINT", () => {
  conn.close();
  server.close();
  process.exit(0);
});