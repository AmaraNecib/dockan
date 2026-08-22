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

const server = serve(
  { fetch: app.fetch, port: config.port, hostname: config.host },
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