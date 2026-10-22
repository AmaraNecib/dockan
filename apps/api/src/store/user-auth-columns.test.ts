import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { CURRENT_SCHEMA_VERSION, readSchemaVersion } from "../lib/schema-version";
import { createDrizzleStore } from "./drizzle-store";

/**
 * #362 — better-auth 1.7.12 requires `user.email` and `user.emailVerified`
 * before it will serve one request (`@better-auth/core/db/schema-check.mjs`
 * reports `Missing columns user.email, user.emailVerified` and every auth call
 * throws `SCHEMA_MISMATCH`). Its drizzle adapter only started *enforcing* that
 * check in 1.7.12, so a vault created by an earlier build has a `user` table
 * without the columns and would fail its first auth call after the upgrade.
 *
 * This proves the additive step in `setup()` closes that: a version-6 shaped
 * vault keeps its rows, gains both columns, gains the unique index, and setups
 * twice without complaint.
 *
 * The row rules are asserted because the column is nullable on purpose: this app
 * has no email identity (ADR-0001), the owner row is provisioned without one, and
 * SQLite treats NULLs as distinct in a unique index — so many email-less rows are
 * legal while a repeated non-null email is not.
 */
let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-user-auth-"));
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

/**
 * The exact shape a version-6 build wrote for `user`: no `email`, no
 * `emailVerified`, `PRAGMA user_version = 6`. The rest of the database is left
 * to the new build's DDL, which is what a real upgrade looks like.
 */
function seedVersion6UserTable(dbPath: string): void {
  const db = new Database(dbPath, { create: true });
  db.exec(
    "CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, image TEXT, username TEXT UNIQUE, phoneNumber TEXT UNIQUE, phoneNumberVerified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  );
  db.query(
    "INSERT INTO user (id, name, image, username, phoneNumber, phoneNumberVerified, created_at, updated_at) VALUES (?, ?, NULL, ?, NULL, 0, ?, ?)",
  ).run("owner-1", "المالك", "213700000000", 1_700_000_000_000, 1_700_000_000_000);
  db.exec("PRAGMA user_version = 6");
  db.close();
}

describe("#362 the user table gains better-auth's email columns", () => {
  it("adds both columns to a version-6 vault, keeps the owner row, and is idempotent", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "shop.db");
    seedVersion6UserTable(dbPath);
    const conn = closeLater(openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath })));

    // Before: the shape the old build left behind.
    // SAFETY: PRAGMA table_info returns one row per column with a string name
    const before = conn.raw.query("PRAGMA table_info(user)").all() as Array<{ name: string }>;
    expect(before.map((column) => column.name)).not.toContain("email");

    await createDrizzleStore(conn).setup();

    // SAFETY: PRAGMA table_info returns rows shaped { name, notnull, dflt_value }
    const after = conn.raw.query("PRAGMA table_info(user)").all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    const names = after.map((column) => column.name);
    expect(names).toContain("email");
    expect(names).toContain("emailVerified");

    // the owner row survived, unextended rather than rewritten
    // SAFETY: the SELECT names these three columns, so each row has them
    const rows = conn.raw.query("SELECT id, name, username FROM user").all() as Array<{ id: string; name: string; username: string }>;
    expect(rows).toEqual([{ id: "owner-1", name: "المالك", username: "213700000000" }]);

    // the columns are usable in the shape better-auth writes
    const emailColumn = after.find((column) => column.name === "email");
    expect(emailColumn?.notnull).toBe(0);
    const verifiedColumn = after.find((column) => column.name === "emailVerified");
    expect(verifiedColumn?.notnull).toBe(1);
    expect(verifiedColumn?.dflt_value).toBe("0");

    expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION);

    // second setup is a no-op, not an error
    await createDrizzleStore(conn).setup();
    // SAFETY: PRAGMA table_info returns one row per column with a string name
    const afterTwice = conn.raw.query("PRAGMA table_info(user)").all() as Array<{ name: string }>;
    expect(afterTwice.filter((column) => column.name === "email")).toHaveLength(1);
  });

  it("refuses a repeated non-null email and allows many email-less rows", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "shop.db");
    seedVersion6UserTable(dbPath);
    const conn = closeLater(openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath })));
    await createDrizzleStore(conn).setup();

    const insert = conn.raw.query(
      "INSERT INTO user (id, name, image, email, emailVerified, username, phoneNumber, phoneNumberVerified, created_at, updated_at) VALUES (?, ?, NULL, ?, 0, NULL, NULL, 0, ?, ?)",
    );
    // two rows with no email: legal, because SQLite treats NULLs as distinct
    insert.run("second-owner", "ثانٍ", null, 1_700_000_000_001, 1_700_000_000_001);
    insert.run("third-owner", "ثالث", null, 1_700_000_000_002, 1_700_000_000_002);

    insert.run("mail-owner", "بريد", "owner@example.test", 1_700_000_000_003, 1_700_000_000_003);
    expect(() => insert.run("mail-dup", "مكرر", "owner@example.test", 1_700_000_000_004, 1_700_000_000_004)).toThrow();
  });
});
