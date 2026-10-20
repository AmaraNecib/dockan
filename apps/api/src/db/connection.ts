import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

import type { AppConfig } from "../config";
import { assertSchemaVersionSupported } from "../lib/schema-version";
import * as schema from "./schema";

export type Schema = typeof schema;
export type DrizzleDb = BunSQLiteDatabase<Schema>;

export type Connection = {
  db: DrizzleDb;
  /** live database file path — used by the backup store method */
  dbPath: string;
  /**
   * The raw bun:sqlite handle. WithTransaction on the store drives explicit
   * BEGIN/COMMIT/ROLLBACK on this single connection, which stays atomic
   * across awaited work (drizzle's bun-sqlite transaction was committing
   * before async callbacks finished).
   */
  raw: Database;
  /** WAL checkpoint, so a straight file copy of the db is consistent */
  checkpoint(): void;
  /** Flush anything in flight, then release the handle. Await for a clean exit. */
  close(): Promise<void>;
  /** true while an explicit multi-statement unit is open (vault persistence waits) */
  inTransaction: boolean;
  /**
   * Vault seam: mark the in-memory image dirty. The legacy file-backed
   * connection is already on disk, so its implementation is a no-op.
   */
  markDirty(): void;
  /**
   * Vault seam: write the encrypted snapshot when dirty; legacy no-op. Every
   * failure throws with its reason — a resolved promise means the committed
   * image is on disk, and a connection that closed first is a throw, never a
   * quiet success.
   */
  persistIfDirty(): Promise<void>;
  /** Vault seam: force-write the current image; legacy = WAL checkpoint. */
  flush(): Promise<void>;
  /**
   * Vault seam: write a self-contained backup bundle (key wraps + snapshot).
   * Absent on the legacy file-backed connection, whose plain SQLite file is
   * already self-contained.
   */
  writeBackupTo?: (destPath: string) => Promise<void>;
  /**
   * Vault seam: verify one encrypted snapshot OR self-contained backup bundle.
   * Absent on the legacy file-backed connection.
   */
  validateSnapshotFile?: (filePath: string) => boolean;
  /**
   * Vault seam: fail-stop hook invoked when a committed unit cannot be written
   * to its durable snapshot. main.ts exits the process here (never report a
   * committed write as failed); tests leave it unset.
   */
  onFatalError?: (error: Error) => void;
};

export function openConnection(config: AppConfig): Connection {
  const driver = config.db.driver;

  if (driver === "sqlite") {
    const sqlite = new Database(config.db.path, { create: true });
    // Wait for a concurrent writer BEFORE the version read below: the read
    // runs on a fresh database that may still be in rollback mode, and a
    // busy writer there would otherwise surface as SQLITE_BUSY instead of the
    // real answer. busy_timeout is connection state, not a disk write, so it
    // is safe to set ahead of the gate.
    sqlite.exec("PRAGMA busy_timeout = 5000;");
    // Import/restore safety FIRST (ADR-0008 §4.5): the check only reads the
    // header, so it must run before any pragma that writes. On read-only
    // media `journal_mode = WAL` would throw SQLITE_READONLY before the gate
    // could report the real problem (a newer database). Older formats pass
    // and are migrated by store.setup(), which stamps the current version.
    try {
      assertSchemaVersionSupported(sqlite);
    } catch (error) {
      // do not leak the file handle on the refusal path
      sqlite.close();
      throw error;
    }
    sqlite.exec("PRAGMA journal_mode = WAL;");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    const db = drizzle(sqlite, { schema });
    return {
      db,
      dbPath: config.db.path,
      raw: sqlite,
      inTransaction: false,
      checkpoint() {
        sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      },
      async close() {
        sqlite.close();
      },
      markDirty() {
        // the legacy file-backed database is the persistence; nothing to mark
      },
      async persistIfDirty() {
        // no in-memory image exists in legacy mode: the file IS the persistence
      },
      async flush() {
        sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      },
    };
  }

  // Postgres adapter lands here later — same StorePort, same callers (ADR-0003).
  throw new Error(
    `Unknown database driver "${driver}". Supported today: "sqlite". ` +
      "Swap via DOKAN_DB_DRIVER; procedures and use cases do not change.",
  );
}