import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { createDrizzleStore } from "../store/drizzle-store";
import {
  assertSchemaVersionSupported,
  CURRENT_SCHEMA_VERSION,
  readSchemaVersion,
  stampSchemaVersion,
  UnsupportedSchemaVersionError,
} from "./schema-version";

/**
 * ADR-0008 §4.5: the data format is versioned with `PRAGMA user_version`.
 * Older databases migrate forward and are stamped; a database written by a
 * newer app is refused with a clear Arabic message instead of corrupted.
 */
let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-schema-version-"));
  cleanups.push(() => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        Bun.sleepSync(50);
      }
    }
  });
  return dir;
}

function closeLater(conn: Connection): Connection {
  cleanups.push(() => conn.close());
  return conn;
}

describe("readSchemaVersion / stampSchemaVersion", () => {
  it("reads 0 from a fresh database (pre-universal format)", () => {
    const dir = tempDir();
    const raw = new Database(path.join(dir, "fresh.db"), { create: true });
    try {
      expect(readSchemaVersion(raw)).toBe(0);
      stampSchemaVersion(raw);
      expect(readSchemaVersion(raw)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      raw.close();
    }
  });

  it("refuses to stamp a nonsense version", () => {
    const dir = tempDir();
    const raw = new Database(path.join(dir, "bad.db"), { create: true });
    try {
      expect(() => stampSchemaVersion(raw, 0)).toThrow(/invalid schema version/);
      expect(() => stampSchemaVersion(raw, 1.5)).toThrow(/invalid schema version/);
    } finally {
      raw.close();
    }
  });
});

describe("the version gate", () => {
  it("accepts an older database and reports its version", () => {
    const dir = tempDir();
    const raw = new Database(path.join(dir, "older.db"), { create: true });
    try {
      expect(assertSchemaVersionSupported(raw)).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("refuses a newer database with a clear Arabic message", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "newer.db");
    const seed = new Database(dbPath, { create: true });
    seed.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    seed.close();

    const handle = new Database(dbPath, { create: true });
    try {
      let error: Error | null = null;
      try {
        assertSchemaVersionSupported(handle);
      } catch (caught) {
        error = caught instanceof Error ? caught : new Error(String(caught));
      }
      expect(error).toBeInstanceOf(UnsupportedSchemaVersionError);
      expect(error?.message).toContain("أقدم من قاعدة البيانات");
      expect(error?.message).toContain(String(CURRENT_SCHEMA_VERSION + 1));
    } finally {
      handle.close();
    }
  });

  it("refuses a newer database before any write, leaves it untouched and closes the handle", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "newer-open.db");
    const seed = new Database(dbPath, { create: true });
    seed.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    seed.exec("CREATE TABLE marker (id TEXT PRIMARY KEY)");
    seed.close();

    expect(() => openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath }))).toThrow(
      UnsupportedSchemaVersionError,
    );

    // the version check ran BEFORE the WAL pragma: a WAL connection would have
    // created the sidecars even though the gate refused
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);

    // the refused file is byte-for-byte usable and the version is unchanged
    const reopened = new Database(dbPath);
    try {
      expect(readSchemaVersion(reopened)).toBe(CURRENT_SCHEMA_VERSION + 1);
      // SAFETY: sqlite_master.name is a TEXT column; the literal query returns
      // one name per table
      const tables = reopened.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).toEqual(["marker"]);
    } finally {
      reopened.close();
    }

    // the refusal closed its handle: on Windows an open database file cannot
    // be deleted (on POSIX this assertion is trivially true but harmless)
    expect(() => fs.rmSync(dbPath)).not.toThrow();
  });
});

describe("forward migration", () => {
  it("migrates a pre-universal database forward and stamps the new version", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "legacy.db");
    // The oldest format: an items table that predates the barcode column,
    // and no user_version stamp at all.
    const seed = new Database(dbPath, { create: true });
    seed.exec("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    seed.close();

    const conn = closeLater(openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath })));
    const store = createDrizzleStore(conn);
    await store.setup();

    expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION);
    // SAFETY: PRAGMA table_info returns one object with a string name per column
    const columns = conn.raw.query("PRAGMA table_info(items)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "barcode")).toBe(true);
    // the rest of the schema landed too
    // SAFETY: COUNT(*) returns one numeric row
    const usersTable = conn.raw.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'user'").get() as { count: number };
    expect(usersTable.count).toBe(1);
  });
});
