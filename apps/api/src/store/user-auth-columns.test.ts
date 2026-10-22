import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { createAuth } from "../auth/auth";
import { openConnection, type Connection } from "../db/connection";
import { readSchemaVersion } from "../lib/schema-version";
import { createDrizzleStore } from "./drizzle-store";

/**
 * #362 — better-auth 1.7.12 requires `user.email` and `user.emailVerified`
 * before it will serve one request (`@better-auth/core/db/schema-check.mjs`
 * reports `Missing columns user.email, user.emailVerified` and every auth call
 * throws `SCHEMA_MISMATCH`). The drizzle adapter wires that check by 1.7.11 and
 * does not in 1.7.1 (verified against both published tarballs), so a vault
 * created by a build on the tolerant side has a `user` table without the columns
 * and would fail its first auth call after an upgrade.
 *
 * This proves the additive step in `setup()` closes that: a version-6 shaped
 * vault keeps its rows, gains both columns, gains the unique index, and setups
 * twice without complaint.
 *
 * Caveat worth knowing: the fixture hand-copies the parent's `CREATE TABLE user`
 * and leaves every other table to the new DDL, which is equivalent only while no
 * other table's shape changed in the same release — it is true for this PR.
 *
 * The row rules are asserted because the column is nullable on purpose: this app
 * has no email identity (ADR-0001), the owner row is provisioned without one, and
 * SQLite treats NULLs as distinct in a unique index — so many email-less rows are
 * legal while a repeated non-null email is not.
 */
const SECRET = "user-auth-columns-secret-0123456789ab";

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

    expect(readSchemaVersion(conn.raw)).toBe(7); // literal: a future bump without a migration must red here

    // Idempotence is proven HERE: a second setup() that re-ran an ALTER would
    // throw "duplicate column name" and never reach the next line.
    await createDrizzleStore(conn).setup();
    // SAFETY: PRAGMA table_info returns one row per column with a string name
    const afterTwice = conn.raw.query("PRAGMA table_info(user)").all() as Array<{ name: string }>;
    expect(afterTwice.filter((column) => column.name === "email")).toHaveLength(1);

    // The claim this step exists for: better-auth SERVES against the migrated
    // shape. A mismatch throws `SchemaMismatchError` in the request hook before
    // the credential is read, so 401 (unknown username) is the proof the check
    // passed — pinned here as well as on a fresh vault, because the ALTERed table
    // is a second shape and only this test builds it.
    const auth = createAuth(conn.db, createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath }), SECRET);
    const response = await auth.handler(
      new Request("http://localhost/api/auth/sign-in/username", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "213700000000", password: "not-a-real-password" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("a fresh vault refuses a repeated non-null email through the DDL constraint", async () => {
    // The other shape of the same invariant: SCHEMA_DDL declares `email TEXT
    // UNIQUE` (SQLite's auto-index), the migration creates a named index. If the
    // DDL constraint were edited out, only this test notices.
    const dir = tempDir();
    const conn = closeLater(openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "shop.db") })));
    await createDrizzleStore(conn).setup();
    const insert = conn.raw.query(
      "INSERT INTO user (id, name, image, email, emailVerified, username, phoneNumber, phoneNumberVerified, created_at, updated_at) VALUES (?, ?, NULL, ?, 0, NULL, NULL, 0, ?, ?)",
    );
    insert.run("fresh-1", "أول", "first@example.test", 1_700_000_000_010, 1_700_000_000_010);
    expect(() => insert.run("fresh-2", "ثانٍ", "first@example.test", 1_700_000_000_011, 1_700_000_000_011)).toThrow(
      /UNIQUE constraint failed: user\.email/,
    );
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
    expect(() => insert.run("mail-dup", "مكرر", "owner@example.test", 1_700_000_000_004, 1_700_000_000_004)).toThrow(
      /UNIQUE constraint failed: user\.email/,
    );
  });
});
