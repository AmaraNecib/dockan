import net from "node:net";
import { serve } from "@hono/node-server";

import { createAuth } from "./auth/auth";
import { createApp } from "./app";
import { createAppConfig } from "./config";
import { openConnection } from "./db/connection";
import { AppLogger } from "./lib/logger";
import { createRpcRouter } from "./rpc/router";
import { createDrizzleStore } from "./store/drizzle-store";

/**
 * Boot: config, logger, the store seam, auth, rpc, then the server.
 * main.ts knows seams, not SQL (ADR-0003).
 */
const config = createAppConfig();
const logger = new AppLogger(config.dataDir);
const conn = openConnection(config);
const store = createDrizzleStore(conn);

await store.setup();
const auth = createAuth(conn.db, config);
const rpcRouter = createRpcRouter({ db: conn.db, config, logger, store, auth });
const app = createApp({ config, logger, auth, rpcRouter });
logger.info("SERVER_BOOT_DONE", "database and auth ready", { driver: config.db.driver });

/**
 * The user is not technical; a busy default port must not crash the app.
 * Probe upward from the configured port until one is free, then serve there.
 */
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