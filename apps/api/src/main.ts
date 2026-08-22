import { Database } from "bun:sqlite";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { createAppConfig } from "./config";
import { AppLogger, localDateTime } from "./lib/logger";

/** Tiny skeleton boot — proves the stack works end-to-end before real code lands. */
const config = createAppConfig();
const logger = new AppLogger(config.dataDir);

// SQLite proof: a table is created, written, and read back.
const sqlite = new Database(`${config.dataDir}/dokan.db`, { create: true });
sqlite.exec("CREATE TABLE IF NOT EXISTS smoke (id INTEGER PRIMARY KEY, note TEXT)");
sqlite.query("INSERT INTO smoke (note) VALUES (?)").run("hello from bun:sqlite");
// SAFETY: the smoke table's note column is TEXT; the insert above guarantees a row
const row = sqlite.query("SELECT note FROM smoke ORDER BY id DESC LIMIT 1").get() as { note: string };

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    ok: true,
    version: config.version,
    db: row.note,
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
  sqlite.close();
  server.close();
  process.exit(0);
});