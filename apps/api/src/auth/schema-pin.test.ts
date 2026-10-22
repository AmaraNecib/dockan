import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getAuthTables } from "better-auth/db";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as schemaModule from "../db/schema";
import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { createDrizzleStore } from "../store/drizzle-store";
import { createAuth, type BetterAuthInstance } from "./auth";
import { HEAVY_TEST_TIMEOUT_MS } from "../test-support/heavy";

/**
 * The better-auth ↔ schema pin.
 *
 * better-auth validates the drizzle shape before it serves a request
 * (`@better-auth/core/db/schema-check.mjs` + `schema-diff.mjs`): a table or
 * column it WRITES must exist, and a column it never writes must be nullable or
 * carry a default (otherwise its inserts fail with a constraint error that says
 * nothing about the drift). The check runs against the drizzle objects, so the
 * two shapes can disagree in both directions:
 *
 * - a field the installed version DECLARES and this schema lacks
 *   (`user.email` and `user.emailVerified`, declared by better-auth since before
 *   1.7.1) fails HERE, naming the column, instead of at the shop owner's next
 *   sign-in;
 * - a column the installed version no longer writes, added as NOT NULL without
 *   a default, fails here too — that is the case that breaks an INSERT, not a
 *   read.
 *
 * Expectations come from `getAuthTables(auth.options)` — the options object
 * `createAuth` actually handed better-auth — and the drizzle side is
 * `db/schema.ts`'s sqlite tables indexed by their SQL name, which is what the
 * adapter addresses with `usePlural: false`. Nothing is restated here, so this
 * file cannot pin a copy that stays green while production drifts. Each arm
 * checks the physical SQLite column as well: a drizzle-only field satisfies the
 * adapter and then fails with `no such column` the first time a user row is
 * read.
 *
 * What the parent says: better-auth 1.7.1 declares the same two fields — only
 * its drizzle adapter never wires the check in, so nothing enforced them. That is
 * why the first arm is red on the parent today (it is the honest column list this
 * bump owes) while the two arms that need 1.7.12's runtime check are green there
 * and carry a waiver: their discrimination is the mutation proof, not a parent
 * run, because a tolerant version cannot see the defect at all.
 */

let dir: string;
let conn: Connection;
let auth: BetterAuthInstance;

const SECRET = "schema-pin-secret-0123456789abcdef";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-auth-schema-pin-"));
  conn = openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") }));
  // a FRESH database: SCHEMA_DDL is the only shape there is — this change adds
  // no migration (pre-release, no legacy vault to keep), so everything below
  // pins what a new install gets
  await createDrizzleStore(conn).setup();
  auth = createAuth(conn.db, createAppConfig({ DOKAN_DATA_DIR: dir }), SECRET);
}, HEAVY_TEST_TIMEOUT_MS);

afterAll(() => {
  conn.close();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
});

/** `db/schema.ts`'s sqlite tables, keyed by the SQL name the adapter addresses. */
function tablesByName(): Map<string, SQLiteTable> {
  const byName = new Map<string, SQLiteTable>();
  for (const value of Object.values(schemaModule)) {
    if (!is(value, SQLiteTable)) continue;
    byName.set(getTableName(value), value);
  }
  return byName;
}

type ExpectedTable = {
  /** the SQL table better-auth addresses (`usePlural: false`, so no plural form) */
  name: string;
  /** whether db/schema.ts declares a sqlite table under that name */
  declared: boolean;
  /** better-auth field key → the drizzle property the adapter resolves it by, and the SQLite column it maps to */
  fields: Map<string, { property: string; column: string | undefined }>;
};

function expectedTables(): ExpectedTable[] {
  const declared = tablesByName();
  // SAFETY: auth.options is the exact object createAuth passed to betterAuth
  // (the instance exposes the resolved options), so the plugin schemas that
  // shape the expectation are the ones production loads
  return Object.values(getAuthTables(auth.options))
    // the adapter's diffSchema skips a table whose migrations it must not run
    .filter((table) => !table.disableMigrations)
    .map((table) => {
      const drizzleTable = declared.get(table.modelName);
      // SAFETY: getTableColumns returns the table's property → column map; every
      // value here is one of the concrete sqliteTable definitions just indexed
      const columns = (drizzleTable === undefined ? {} : getTableColumns(drizzleTable)) as Record<
        string,
        { name: string }
      >;
      const fields = new Map<string, { property: string; column: string | undefined }>();
      for (const [key, field] of Object.entries(table.fields)) {
        // schema-diff compares the drizzle PROPERTY against fieldName
        const property = field.fieldName || key;
        fields.set(key, { property, column: columns[property]?.name });
      }
      return { name: table.modelName, declared: drizzleTable !== undefined, fields };
    });
}

describe("better-auth schema pin", () => {
  it("the schema store.setup() creates holds every column better-auth writes", () => {
    const missing: string[] = [];
    for (const table of expectedTables()) {
      // SAFETY: PRAGMA table_info returns rows shaped { name, type, notnull, dflt_value, pk }
      const sqliteColumns = conn.raw.query(`PRAGMA table_info(${table.name})`).all() as Array<{ name: string }>;
      if (!table.declared) {
        missing.push(`${table.name} (whole table, not in db/schema.ts)`);
        continue;
      }
      if (sqliteColumns.length === 0) {
        missing.push(`${table.name} (whole table)`);
        continue;
      }
      const present = new Set(sqliteColumns.map((column) => column.name));
      for (const { property, column } of table.fields.values()) {
        // 1. the adapter resolves the field by property name on the drizzle table
        if (column === undefined) {
          missing.push(`${table.name}.${property} (not in db/schema.ts)`);
          continue;
        }
        // 2. and the store must physically hold the column it maps to
        if (!present.has(column)) missing.push(`${table.name}.${property} → column ${column}`);
      }
    }
    // named one per line, so the next bump's failure IS the schema TODO list
    expect(missing).toEqual([]);
  });

  // red-on-parent-waive: "every column better-auth does not write can be omitted on insert" — the parent's user table lacks the very columns this bump adds, so this arm has nothing to judge there; discrimination is the mutation proof (add a NOT NULL column with no default), not a parent run
  it("every column better-auth does not write can be omitted on insert", () => {
    // The other arm of diffSchema. Read from SQLite, not drizzle: the
    // constraint that breaks the INSERT lives in the database.
    const offenders: string[] = [];
    for (const table of expectedTables()) {
      const written = new Set(
        [...table.fields.values()].map((field) => field.column).filter((column): column is string => column !== undefined),
      );
      // SAFETY: PRAGMA table_info returns rows shaped { name, type, notnull, dflt_value, pk }
      const sqliteColumns = conn.raw.query(`PRAGMA table_info(${table.name})`).all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;
      for (const column of sqliteColumns) {
        if (written.has(column.name)) continue;
        // the id column is always supplied by better-auth
        if (column.pk > 0) continue;
        const nullable = column.notnull === 0;
        const hasDefault = column.dflt_value !== null;
        if (!nullable && !hasDefault) offenders.push(`${table.name}.${column.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // red-on-parent-waive: "better-auth serves a request against this schema \(no SCHEMA_MISMATCH\)" — the parent's adapter (1.7.1) does not run the check at all, so the same request answers 401 there; discrimination is the mutation proof (the request throws SCHEMA_MISMATCH naming the removed columns), not a parent run
  it("better-auth serves a request against this schema (no SCHEMA_MISMATCH)", async () => {
    // The adapter's own runtime check, reached through the real handler. A
    // mismatch THROWS `SchemaMismatchError` before the credential is looked at,
    // so 401 (unknown username) is the proof that the check passed — and that
    // throw is what a bump without the schema change produces here instead.
    const response = await auth.handler(
      new Request("http://localhost/api/auth/sign-in/username", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "213700000000", password: "not-a-real-password" }),
      }),
    );
    expect(response.status).toBe(401);
  });
});
