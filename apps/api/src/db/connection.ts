import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

import type { AppConfig } from "../config";
import * as schema from "./schema";

export type Schema = typeof schema;
export type DrizzleDb = BunSQLiteDatabase<Schema>;

export type Connection = {
  db: DrizzleDb;
  /** live database file path — used by the backup store method */
  dbPath: string;
  /** WAL checkpoint, so a straight file copy of the db is consistent */
  checkpoint(): void;
  close(): void;
};

export function openConnection(config: AppConfig): Connection {
  const driver = config.db.driver;

  if (driver === "sqlite") {
    const sqlite = new Database(config.db.path, { create: true });
    sqlite.exec("PRAGMA journal_mode = WAL;");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    const db = drizzle(sqlite, { schema });
    return {
      db,
      dbPath: config.db.path,
      checkpoint() {
        sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      },
      close() {
        sqlite.close();
      },
    };
  }

  // Postgres adapter lands here later — same StorePort, same callers (ADR-0003).
  throw new Error(
    `Unknown database driver "${driver}". Supported today: "sqlite". ` +
      "Swap via DOKAN_DB_DRIVER; procedures and use cases do not change.",
  );
}