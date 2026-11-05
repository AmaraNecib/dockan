import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { assertSchemaVersionSupported, CURRENT_SCHEMA_VERSION, readSchemaVersion, UnsupportedSchemaVersionError } from "../lib/schema-version";
import { createDrizzleStore } from "./drizzle-store";
import type { StorePort } from "./port";

let dir: string;
let dbPath: string;
let conn: Connection;
let store: StorePort;
let expenseId: string;
let categoryId: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-expense-correction-migration-"));
  dbPath = path.join(dir, "test.db");
  const config = createAppConfig({
    DOKAN_DATA_DIR: dir,
    DOKAN_DB_PATH: dbPath,
  });
  conn = openConnection(config);
  categoryId = randomUUID();
  expenseId = randomUUID();
  conn.raw.exec(`
    CREATE TABLE expense_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      is_owner_withdrawal INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO expense_categories (id, name, created_at, updated_at)
    VALUES ('${categoryId}', 'Legacy category', '2019-12-01T00:00:00', '2019-12-01T00:00:00');
    CREATE TABLE expenses (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES expense_categories(id),
      amount INTEGER NOT NULL CHECK (amount > 0),
      note TEXT,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO expenses (id, category_id, amount, note, occurred_at, created_at)
    VALUES ('${expenseId}', '${categoryId}', 1000, 'legacy row', '2019-12-15T10:00:00', '2019-12-16T11:00:00');
    PRAGMA user_version = 7;
  `);
  store = createDrizzleStore(conn);
  await store.setup();
}, 30_000);

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

describe("expense correction storage (#408)", () => {
  it("upgrades v7 without inventing legacy actor facts or rewriting expense dates", async () => {
    expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION);
    const original = (await store.listExpenseRecords({})).find((row) => row.id === expenseId);
    expect(original).toMatchObject({
      amount: 1_000,
      occurredAt: "2019-12-15T10:00:00",
      createdAt: "2019-12-16T11:00:00",
      actorId: null,
      actorName: null,
    });
    // SAFETY: SQLite PRAGMA table_info returns a row with `name` for each column; this test reads those names to pin the migration.
    const columns = conn.raw.query("PRAGMA table_info(expenses)").all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toContain("actor_id");
    expect(columns.map(({ name }) => name)).toContain("actor_name");
    expect(() => assertSchemaVersionSupported(conn.raw, 7)).toThrow(UnsupportedSchemaVersionError);
    await store.setup();
    expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION);
    expect((await store.getExpenseCorrectionHistory(expenseId))?.corrections).toEqual([]);
    await expect(store.insertExpense({
      categoryId, amount: 100, occurredAt: "2020-01-01T10:00:00", actorId: "missing-name", actorName: null,
    })).rejects.toThrow("expense actor fields must be paired");
    await expect(store.insertExpense({
      categoryId, amount: 100, occurredAt: "2020-01-01T10:00:00", actorId: null, actorName: "missing-id",
    })).rejects.toThrow("expense actor fields must be paired");
    expect(await store.listExpenseRecords({})).toHaveLength(1);
  });

  it("appends a linked signed row inside an immediate transaction and refuses stale or unlocked writes", async () => {
    expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION);
    const first = await store.withTransactionImmediate((tx) =>
      tx.insertExpenseCorrection({
        expenseId,
        effectiveAt: "2019-12-15T10:00:00",
        recordedAt: "2026-10-28T13:34:56",
        beforeAmount: 1_000,
        afterAmount: 800,
        difference: -200,
        actorId: null,
        actorName: null,
        reason: "legacy amount corrected",
        reversesCorrectionId: null,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(first).toMatchObject({ beforeAmount: 1_000, afterAmount: 800, difference: -200, actorId: null, actorName: null });
    const history = await store.getExpenseCorrectionHistory(expenseId);
    expect(history).toMatchObject({ original: { amount: 1_000 }, effectiveAmount: 800 });
    expect(history?.corrections).toHaveLength(1);

    await expect(
      store.insertExpenseCorrection({
        expenseId,
        effectiveAt: "2019-12-15T10:00:00",
        recordedAt: "2026-10-28T13:35:00",
        beforeAmount: 800,
        afterAmount: 700,
        difference: -100,
        actorId: null,
        actorName: null,
        reason: null,
        reversesCorrectionId: null,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("immediate transaction");
    await expect(
      store.withTransaction((tx) =>
        tx.insertExpenseCorrection({
          expenseId,
          effectiveAt: "2019-12-15T10:00:00",
          recordedAt: "2026-10-28T13:35:00",
          beforeAmount: 800,
          afterAmount: 700,
          difference: -100,
          actorId: null,
          actorName: null,
          reason: null,
          reversesCorrectionId: null,
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow("immediate transaction");
    await expect(
      store.withTransactionImmediate((tx) =>
        tx.insertExpenseCorrection({
          expenseId,
          effectiveAt: "2019-12-15T10:00:00",
          recordedAt: "2026-10-28T13:35:00",
          beforeAmount: 700,
          afterAmount: 600,
          difference: -100,
          actorId: null,
          actorName: null,
          reason: null,
          reversesCorrectionId: null,
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow("current expense state");
    expect((await store.getExpenseCorrectionHistory(expenseId))?.effectiveAmount).toBe(800);
  });

  // red-on-parent-waive: "refuses a correction with the wrong business date and preserves its history" — parent schema has no expense_corrections table, and its store has no insertExpenseCorrection/getExpenseCorrectionHistory methods, so this constraint case cannot run there.
  it("refuses a correction with the wrong business date and preserves its history", async () => {
    const original = await store.insertExpense({ categoryId, amount: 1_000, occurredAt: "2020-01-10T10:00:00" });
    await store.withTransactionImmediate((tx) => tx.insertExpenseCorrection({
      expenseId: original.id,
      effectiveAt: original.occurredAt,
      recordedAt: "2026-10-28T13:34:56",
      beforeAmount: 1_000,
      afterAmount: 800,
      difference: -200,
      actorId: null,
      actorName: null,
      reason: null,
      reversesCorrectionId: null,
      idempotencyKey: randomUUID(),
    }));
    const before = await store.getExpenseCorrectionHistory(original.id);

    await expect(store.withTransactionImmediate((tx) => tx.insertExpenseCorrection({
      expenseId: original.id,
      effectiveAt: "2020-01-10T10:00:01",
      recordedAt: "2026-10-28T13:35:00",
      beforeAmount: 800,
      afterAmount: 700,
      difference: -100,
      actorId: null,
      actorName: null,
      reason: null,
      reversesCorrectionId: null,
      idempotencyKey: randomUUID(),
    }))).rejects.toThrow();
    expect(await store.getExpenseCorrectionHistory(original.id)).toEqual(before);
  });

  // red-on-parent-waive: "refuses a reversal linked to another expense and preserves both histories" — parent schema has no expense_corrections table, and its store has no insertExpenseCorrection/getExpenseCorrectionHistory methods, so this constraint case cannot run there.
  it("refuses a reversal linked to another expense and preserves both histories", async () => {
    const firstExpense = await store.insertExpense({ categoryId, amount: 1_000, occurredAt: "2020-01-11T10:00:00" });
    const otherExpense = await store.insertExpense({ categoryId, amount: 1_000, occurredAt: "2020-01-15T10:00:00" });
    const first = await store.withTransactionImmediate((tx) => tx.insertExpenseCorrection({
      expenseId: firstExpense.id,
      effectiveAt: firstExpense.occurredAt,
      recordedAt: "2026-10-28T13:34:56",
      beforeAmount: 1_000,
      afterAmount: 800,
      difference: -200,
      actorId: null,
      actorName: null,
      reason: null,
      reversesCorrectionId: null,
      idempotencyKey: randomUUID(),
    }));
    const other = await store.withTransactionImmediate((tx) => tx.insertExpenseCorrection({
      expenseId: otherExpense.id,
      effectiveAt: otherExpense.occurredAt,
      recordedAt: "2026-10-28T13:34:57",
      beforeAmount: 1_000,
      afterAmount: 800,
      difference: -200,
      actorId: null,
      actorName: null,
      reason: null,
      reversesCorrectionId: null,
      idempotencyKey: randomUUID(),
    }));
    const before = [await store.getExpenseCorrectionHistory(firstExpense.id), await store.getExpenseCorrectionHistory(otherExpense.id)];

    await expect(store.withTransactionImmediate((tx) => tx.insertExpenseCorrection({
      expenseId: firstExpense.id,
      effectiveAt: firstExpense.occurredAt,
      recordedAt: "2026-10-28T13:35:00",
      beforeAmount: 800,
      afterAmount: 1_000,
      difference: 200,
      actorId: null,
      actorName: null,
      reason: null,
      reversesCorrectionId: other.id,
      idempotencyKey: randomUUID(),
    }))).rejects.toThrow();

    expect([await store.getExpenseCorrectionHistory(firstExpense.id), await store.getExpenseCorrectionHistory(otherExpense.id)]).toEqual(before);
    expect((await store.getExpenseCorrectionHistory(firstExpense.id))?.corrections[0]?.id).toBe(first.id);
  });

  // red-on-parent-waive: "refuses an unpaired correction actor snapshot without appending a row" — parent schema has no expense_corrections table or correction actor columns, and its store has no correction insert/history methods.
  it("refuses an unpaired correction actor snapshot without appending a row", async () => {
    const original = await store.insertExpense({ categoryId, amount: 1_000, occurredAt: "2020-01-12T10:00:00" });
    await store.withTransactionImmediate((tx) => tx.insertExpenseCorrection({
      expenseId: original.id,
      effectiveAt: original.occurredAt,
      recordedAt: "2026-10-28T13:34:56",
      beforeAmount: 1_000,
      afterAmount: 800,
      difference: -200,
      actorId: null,
      actorName: null,
      reason: null,
      reversesCorrectionId: null,
      idempotencyKey: randomUUID(),
    }));
    const before = await store.getExpenseCorrectionHistory(original.id);

    await expect(store.withTransactionImmediate((tx) => tx.insertExpenseCorrection({
      expenseId: original.id,
      effectiveAt: original.occurredAt,
      recordedAt: "2026-10-28T13:35:00",
      beforeAmount: 800,
      afterAmount: 700,
      difference: -100,
      actorId: randomUUID(),
      actorName: null,
      reason: null,
      reversesCorrectionId: null,
      idempotencyKey: randomUUID(),
    }))).rejects.toThrow();
    expect(await store.getExpenseCorrectionHistory(original.id)).toEqual(before);
  });

  // red-on-parent-waive: "refuses a correction with a delta inconsistent with its amounts" — parent schema has no expense_corrections table, and its store has no insertExpenseCorrection/getExpenseCorrectionHistory methods, so this constraint case cannot run there.
  it("refuses a correction with a delta inconsistent with its amounts", async () => {
    const original = await store.insertExpense({ categoryId, amount: 1_000, occurredAt: "2020-01-13T10:00:00" });
    await store.withTransactionImmediate((tx) => tx.insertExpenseCorrection({
      expenseId: original.id,
      effectiveAt: original.occurredAt,
      recordedAt: "2026-10-28T13:34:56",
      beforeAmount: 1_000,
      afterAmount: 800,
      difference: -200,
      actorId: null,
      actorName: null,
      reason: null,
      reversesCorrectionId: null,
      idempotencyKey: randomUUID(),
    }));
    const before = await store.getExpenseCorrectionHistory(original.id);

    await expect(store.withTransactionImmediate((tx) => tx.insertExpenseCorrection({
      expenseId: original.id,
      effectiveAt: original.occurredAt,
      recordedAt: "2026-10-28T13:35:00",
      beforeAmount: 800,
      afterAmount: 700,
      difference: -99,
      actorId: null,
      actorName: null,
      reason: null,
      reversesCorrectionId: null,
      idempotencyKey: randomUUID(),
    }))).rejects.toThrow();
    expect(await store.getExpenseCorrectionHistory(original.id)).toEqual(before);
  });

  // red-on-parent-waive: "preserves attributed history and retry identities after reopening the upgraded database" — parent schema has no expense_corrections table or actor snapshot columns, and its store has no correction insert/history/idempotency methods.
  it("preserves attributed history and retry identities after reopening the upgraded database", async () => {
    const legacyBefore = await store.getExpenseCorrectionHistory(expenseId);
    expect(legacyBefore?.original).toMatchObject({ actorId: null, actorName: null });
    const actorId = randomUUID();
    const attributed = await store.insertExpense({
      categoryId,
      amount: 300,
      occurredAt: "2020-02-15T10:00:00",
      actorId,
      actorName: "Current owner",
    });
    const correctionKey = randomUUID();
    const correction = await store.withTransactionImmediate((tx) => tx.insertExpenseCorrection({
      expenseId: attributed.id,
      effectiveAt: attributed.occurredAt,
      recordedAt: "2026-10-28T14:00:00",
      beforeAmount: 300,
      afterAmount: 250,
      difference: -50,
      actorId,
      actorName: "Current owner",
      reason: "restart proof",
      reversesCorrectionId: null,
      idempotencyKey: correctionKey,
    }));
    const undoKey = randomUUID();
    const reversal = await store.withTransactionImmediate((tx) => tx.insertExpenseCorrection({
      expenseId: attributed.id,
      effectiveAt: attributed.occurredAt,
      recordedAt: "2026-10-28T14:01:00",
      beforeAmount: 250,
      afterAmount: 300,
      difference: 50,
      actorId,
      actorName: "Current owner",
      reason: null,
      reversesCorrectionId: correction.id,
      idempotencyKey: undoKey,
    }));
    const historyBeforeRestart = await store.getExpenseCorrectionHistory(attributed.id);
    expect(historyBeforeRestart?.corrections[0]?.reversedByCorrectionId).toBe(reversal.id);
    expect(await store.findExpenseCorrectionByIdempotencyKey(attributed.id, correctionKey)).toEqual(correction);
    expect(await store.findExpenseCorrectionByIdempotencyKey(attributed.id, undoKey)).toEqual(reversal);

    await conn.close();
    conn = openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: dbPath }));
    store = createDrizzleStore(conn);
    await store.setup();

    expect(await store.getExpenseCorrectionHistory(attributed.id)).toEqual(historyBeforeRestart);
    expect(await store.findExpenseCorrectionByIdempotencyKey(attributed.id, correctionKey)).toEqual(correction);
    expect(await store.findExpenseCorrectionByIdempotencyKey(attributed.id, undoKey)).toEqual(reversal);
    expect(await store.getExpenseCorrectionHistory(expenseId)).toEqual(legacyBefore);
    expect(readSchemaVersion(conn.raw)).toBe(CURRENT_SCHEMA_VERSION);
  });
});
