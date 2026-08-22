import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { createAppConfig } from "./config";
import { openConnection } from "./db/connection";
import { AppLogger, localDateTime } from "./lib/logger";
import { createDrizzleStore } from "./store/drizzle-store";

/**
 * Boot: config, logger, the one StorePort seam, then the server.
 * main.ts knows seams, not SQL; every read and write goes through the store.
 */
const config = createAppConfig();
const logger = new AppLogger(config.dataDir);
const conn = openConnection(config);
const store = createDrizzleStore(conn);

await store.setup();
logger.info("SERVER_BOOT_DONE", "database ready", { driver: config.db.driver });

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    ok: true,
    version: config.version,
    time: localDateTime(),
  }),
);

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