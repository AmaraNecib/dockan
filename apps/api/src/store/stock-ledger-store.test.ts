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
