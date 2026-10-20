import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { HEAVY_TEST_TIMEOUT_MS, itHeavy } from "../test-support/heavy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { createDrizzleStore } from "./drizzle-store";
import type { StorePort } from "./port";
import { COST_CORRECTION_REASON, weightedAverageCost } from "../lib/stock-ledger";
import { repeatCutoff } from "../lib/stock-adjustment";

/**
 * Ticket 27 store-seam tests: stock_movements persistence, deterministic
 * ordering, opening-balance backfill idempotency, transaction atomicity.
 */

let dir: string;
let conn: Connection;
let store: StorePort;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-ledger-"));
  conn = openConnection(
    createAppConfig({
      DOKAN_DATA_DIR: dir,
      DOKAN_DB_PATH: path.join(dir, "test.db"),
    }),
  );
  store = createDrizzleStore(conn);
  await store.setup();
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

async function makeItem(name: string) {
  const [category] = await store.listCategories();
  if (category === undefined) throw new Error("seed category missing");
  return store.createItem({ name, categoryId: category.id, costPrice: 100, sellingPrice: 200 });
}

describe("stock movements — persistence + ordering", () => {
  it("lists movements ordered by occurred_at, then insertion order for ties", async () => {
    const item = await makeItem("ledger-item-1");
    await store.insertStockMovement({
      itemId: item.id,
      kind: "PURCHASE",
      delta: 10,
      unitCost: 500,
      reason: null,
      ref: null,
      occurredAt: "2025-05-02T10:00:00",
    });
    // same timestamp, inserted later → must sort second
    await store.insertStockMovement({
      itemId: item.id,
      kind: "MANUAL_ADJUSTMENT",
      delta: -2,
      unitCost: null,
      reason: "كسر",
      ref: null,
      occurredAt: "2025-05-02T10:00:00",
    });
    await store.insertStockMovement({
      itemId: item.id,
      kind: "SALE",
      delta: -1,
      unitCost: null,
      reason: null,
      ref: null,
      occurredAt: "2025-05-01T09:00:00",
    });

    const rows = await store.listStockMovements(item.id);
    // earliest day first; same-timestamp pair keeps insertion order
    expect(rows.map((r) => r.delta)).toEqual([-1, 10, -2]);
    // Arabic reason strings round-trip through sqlite unchanged
    expect(rows.find((r) => r.delta === -2)?.reason).toBe("كسر");
    const pair = rows.filter((r) => r.occurredAt === "2025-05-02T10:00:00");
    expect(pair.length).toBe(2);
    expect(pair[0]!.delta).toBe(10);
    expect(pair[0]!.seq).toBeLessThan(pair[1]!.seq);
  });

  it("reads only the movements recorded after a cutoff, in insertion order", async () => {
    // the #295 repeat window: the guard needs the movements RECORDED after a
    // stamp, in the order they were written — a backdated movement is
    // recorded now, and the business date does not order the window
    const item = await makeItem("ledger-window");
    await store.insertStockMovement({
      itemId: item.id,
      kind: "PURCHASE",
      delta: 10,
      unitCost: 500,
      reason: null,
      ref: null,
      occurredAt: "2025-05-01T10:00:00",
    });
    await store.insertStockMovement({
      itemId: item.id,
      kind: "MANUAL_ADJUSTMENT",
      delta: -2,
      unitCost: null,
      reason: "كسّر",
      ref: null,
      occurredAt: "2025-05-02T10:00:00",
    });

    const inside = await store.listStockMovementsSince(item.id, "2020-01-01T00:00:00");
    expect(inside.map((r) => r.delta)).toEqual([10, -2]);
    const outside = await store.listStockMovementsSince(item.id, "2099-01-01T00:00:00");
    expect(outside).toHaveLength(0);
  });

  it("reads the window by its real edge, and only the item's own rows", async () => {
    // the window is a number, not a shape: a movement recorded now is inside
    // it, and the same movement falls out of it one window later. Without
    // this, widening REPEAT_WINDOW_MS to half an hour would leave every
    // test in the branch green while the owner who means it twice is refused
    // forever
    const item = await makeItem("ledger-edge");
    const other = await makeItem("ledger-edge-other");
    const now = new Date();
    await store.insertStockMovement({
      itemId: item.id,
      kind: "MANUAL_ADJUSTMENT",
      delta: 5,
      unitCost: 100,
      reason: null,
      ref: null,
      occurredAt: "2026-10-19T10:00:00",
    });
    // another item's movement, in the same second
    await store.insertStockMovement({
      itemId: other.id,
      kind: "MANUAL_ADJUSTMENT",
      delta: 7,
      unitCost: 100,
      reason: null,
      ref: null,
      occurredAt: "2026-10-19T10:00:00",
    });

    const inside = await store.listStockMovementsSince(item.id, repeatCutoff(now));
    expect(inside.map((r) => r.delta)).toEqual([5]);
    // one window later the same row has fallen out
    const later = await store.listStockMovementsSince(item.id, repeatCutoff(new Date(now.getTime() + 11_000)));
    expect(later).toHaveLength(0);
  });

  it("reads the window through the (item_id, created_at) index, not a ledger scan", () => {
    // #295 — the repeat window runs while the adjustment holds the write lock,
    // so a full scan of the ledger is paid by every manual adjustment on a
    // growing shop. The SQL below mirrors the store's own window read
    // (drizzle-store.ts `listStockMovementsSince`): the same columns, the same
    // predicate, the same `ORDER BY rowid`.
    //
    // Measured on a throwaway bun:sqlite database at this shape (200 items,
    // 1000 executions of the query): with the repeat window empty (the rows
    // inside the window are the fresh ones) 1k rows 50.6 -> 1.0 ms, 10k rows
    // 497.2 -> 1.1 ms, 100k rows 5833.0 -> 1.4 ms; with the whole item ledger
    // inside the window (the worst case) 1k rows 90.2 -> 16.5 ms, 10k rows
    // 706.5 -> 90.5 ms, 100k rows 7146.0 -> 662.3 ms. Delete the index line
    // from SCHEMA_DDL and this test fails on the plan.
    //
    // SAFETY: EXPLAIN QUERY PLAN answers one `detail` string per plan row
    const plan = conn.raw
      .query(
        `EXPLAIN QUERY PLAN SELECT id, item_id, kind, delta, unit_cost, reason, ref, return_mark, occurred_at, created_at, rowid
           FROM stock_movements WHERE item_id = ? AND created_at > ? ORDER BY rowid`,
      )
      .all("plan-item", "2020-01-01T00:00:00") as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join(" | ");
    expect(details).toContain("SEARCH stock_movements USING INDEX idx_stock_movements_item (item_id=? AND created_at>?)");
    expect(details).not.toContain("SCAN stock_movements");
    // the window's rows are then sorted by rowid; that sort is the price of the
    // index and it covers only the window, not the ledger
    expect(details).toContain("USE TEMP B-TREE FOR ORDER BY");

    // SAFETY: PRAGMA index_list answers one row per index on the table
    const indexes = conn.raw.query("PRAGMA index_list(stock_movements)").all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain("idx_stock_movements_item");

    // SAFETY: PRAGMA index_info answers one row per indexed column
    const columns = conn.raw.query("PRAGMA index_info(idx_stock_movements_item)").all() as Array<{ seqno: number; name: string }>;
    expect(columns.sort((a, b) => a.seqno - b.seqno).map((column) => column.name)).toEqual(["item_id", "created_at"]);
  });

  it("counts movements per item only", async () => {
    const a = await makeItem("ledger-item-2");
    const b = await makeItem("ledger-item-3");
    await store.insertStockMovement({
      itemId: a.id,
      kind: "PURCHASE",
      delta: 1,
      unitCost: 10,
      reason: null,
      ref: null,
      occurredAt: "2025-05-03T10:00:00",
    });
    expect(await store.countStockMovements(a.id)).toBe(1);
    expect(await store.countStockMovements(b.id)).toBe(0);
  });
});

describe("opening-balance backfill", () => {
  itHeavy("backfills exactly one opening movement per stockless-ledger item, idempotently", async () => {
    const item = await makeItem("backfill-item");
    // give it stock directly (pre-ledger state simulation)
    await store.setItemStockAndCost(item.id, 7, 300);

    await store.setup();
    let rows = await store.listStockMovements(item.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.delta).toBe(7);
    expect(rows[0]!.unitCost).toBe(300);
    expect(rows[0]!.reason).toBe("opening");
    expect(rows[0]!.occurredAt).toBe(item.createdAt);

    // running setup twice must NOT duplicate the opening row
    await store.setup();
    await store.setup();
    rows = await store.listStockMovements(item.id);
    expect(rows.length).toBe(1);
  });

  itHeavy("never touches items that already have movements", async () => {
    const item = await makeItem("backfill-skip");
    await store.insertStockMovement({
      itemId: item.id,
      kind: "PURCHASE",
      delta: 3,
      unitCost: 50,
      reason: null,
      ref: null,
      occurredAt: "2025-05-04T10:00:00",
    });
    await store.setup();
    expect(await store.countStockMovements(item.id)).toBe(1);
  });
});

describe("transaction atomicity — movement + stock update", () => {
  it("rolls both back when the unit throws", async () => {
    const item = await makeItem("tx-item");
    const before = (await store.listItems()).items.find((i) => i.id === item.id)!;
    const movementsBefore = await store.countStockMovements(item.id);

    await expect(
      store.withTransaction(async (tx) => {
        await tx.insertStockMovement({
          itemId: item.id,
          kind: "MANUAL_ADJUSTMENT",
          delta: 5,
          unitCost: 100,
          reason: null,
          ref: null,
          occurredAt: "2025-05-05T10:00:00",
        });
        await tx.setItemStockAndCost(item.id, before.stockOnHand + 5, before.costPrice);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await store.countStockMovements(item.id)).toBe(movementsBefore);
    const after = (await store.listItems()).items.find((i) => i.id === item.id)!;
    expect(after.stockOnHand).toBe(before.stockOnHand);
  });
});

describe("cost correction persistence (issue 144)", () => {
  itHeavy("keeps the corrected cost and its movement across a close/reopen", async () => {
    const persistenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-cost-persist-"));
    const config = createAppConfig({ DOKAN_DATA_DIR: persistenceDir, DOKAN_DB_PATH: path.join(persistenceDir, "test.db") });

    const firstConn = openConnection(config);
    const firstStore = createDrizzleStore(firstConn);
    await firstStore.setup();
    const [category] = await firstStore.listCategories();
    if (category === undefined) throw new Error("seed category missing");
    const item = await firstStore.createItem({ name: "cost-persist", categoryId: category.id, costPrice: 100, sellingPrice: 200 });
    await firstStore.insertStockMovement({
      itemId: item.id,
      kind: "PURCHASE",
      delta: 10,
      unitCost: 100,
      reason: null,
      ref: null,
      occurredAt: "2026-01-01T00:00:00",
    });
    await firstStore.insertStockMovement({
      itemId: item.id,
      kind: "MANUAL_ADJUSTMENT",
      delta: 0,
      unitCost: 300,
      reason: COST_CORRECTION_REASON,
      ref: null,
      occurredAt: "2026-01-02T00:00:00",
    });
    const corrected = weightedAverageCost(await firstStore.listStockMovements(item.id), { fallbackUnitCost: item.costPrice });
    expect(corrected).toBe(300);
    await firstStore.setItemStockAndCost(item.id, 10, corrected);
    firstConn.close();

    const secondConn = openConnection(config);
    const secondStore = createDrizzleStore(secondConn);
    await secondStore.setup();
    const reopened = (await secondStore.getItemsByIds([item.id])).get(item.id);
    expect(reopened?.costPrice).toBe(300);
    expect(reopened?.stockOnHand).toBe(10);
    const reopenedMovements = await secondStore.listStockMovements(item.id);
    expect(
      reopenedMovements.some((row) => row.delta === 0 && row.unitCost === 300 && row.reason === COST_CORRECTION_REASON),
    ).toBe(true);
    expect(weightedAverageCost(reopenedMovements, { fallbackUnitCost: item.costPrice })).toBe(300);
    secondConn.close();

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(persistenceDir, { recursive: true, force: true });
        break;
      } catch {
        Bun.sleepSync(50);
      }
    }
  });
});
