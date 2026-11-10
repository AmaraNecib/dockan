import { describe, expect, it } from "bun:test";
import type { Item, StockMovement } from "@dokan/contracts";

import { recordStockMovement, recordStockMovements, StockItemMissingError, type StockMovementSpec, type StockPostingTx } from "./stock-posting";
import { COST_CORRECTION_REASON, StockLedgerError } from "./stock-ledger";

/**
 * Direct unit tests for the movement-posting seam. A tiny in-memory
 * `StockPostingTx` keeps the module's interface under test without sqlite: the
 * fake records rows and cache writes exactly like the store, and the pure math
 * is the real `stock-ledger` code.
 */

type Row = StockMovement & { seq: number };

function fakeTx(opts: { itemId?: string; costPrice?: number; costPriceKnown?: boolean; stockOnHand?: number } = {}) {
  const itemId = opts.itemId ?? "i1";
  // SAFETY: the module under test only reads `id`, `costPrice` and (for the
  // batch's initial cache) `stockOnHand`; this fake is a stand-in for the
  // persisted row, never sent across the store boundary.
  const item = { id: itemId, costPrice: opts.costPrice ?? 100, costPriceKnown: opts.costPriceKnown ?? true, stockOnHand: opts.stockOnHand ?? 0 } as Item;
  const movements: Row[] = [];
  const cache = { stockOnHand: item.stockOnHand, costPrice: item.costPrice };
  const stats = { historyReads: 0, cacheWrites: 0 };
  let seq = 0;
  const tx: StockPostingTx = {
    async getItemsByIds(ids) {
      const found = new Map<string, Item>();
      if (ids.includes(itemId)) found.set(itemId, item);
      return found;
    },
    async listStockMovements(id) {
      stats.historyReads += 1;
      // mirror the store: occurred_at, then insertion order (rowid/seq)
      return movements
        .filter((m) => m.itemId === id)
        .sort((a, b) => (a.occurredAt === b.occurredAt ? a.seq - b.seq : a.occurredAt < b.occurredAt ? -1 : 1));
    },
    async insertStockMovement(input) {
      const row: Row = {
        id: `m${++seq}`,
        itemId: input.itemId,
        kind: input.kind,
        delta: input.delta,
        unitCost: input.unitCost ?? null,
        costPending: input.costPending ?? false,
        reason: input.reason ?? null,
        ref: input.ref ?? null,
        returnMark: input.returnMark ?? null,
        occurredAt: input.occurredAt,
        createdAt: input.occurredAt,
        seq,
      };
      movements.push(row);
      return row;
    },
    async setItemStockAndCost(id, stockOnHand, costPrice, costPriceKnown) {
      stats.cacheWrites += 1;
      cache.stockOnHand = stockOnHand;
      cache.costPrice = costPrice;
      // the real store UPDATEs items.stock_on_hand / cost_price, so a later
      // getItemsByIds in the same unit reads the new values back
      if (id === itemId) {
        item.stockOnHand = stockOnHand;
        item.costPrice = costPrice;
        if (costPriceKnown !== undefined) item.costPriceKnown = costPriceKnown;
      }
    },
  };
  return { tx, itemId, movements, cache, item, stats };
}

describe("recordStockMovement", () => {
  it("blends the ADR-0002 weighted average on inflow and writes the cache", async () => {
    const { tx, cache } = fakeTx({ costPrice: 500 });
    const first = await recordStockMovement(tx, {
      itemId: "i1",
      kind: "PURCHASE",
      delta: 10,
      unitCost: 500,
      occurredAt: "2020-01-01T10:00:00",
    });
    expect(first.movement.unitCost).toBe(500);
    expect(first.stockOnHand).toBe(10);
    expect(first.costPrice).toBe(500);
    expect(first.outflowCost).toBeNull();

    const second = await recordStockMovement(tx, {
      itemId: "i1",
      kind: "PURCHASE",
      delta: 10,
      unitCost: 700,
      occurredAt: "2020-01-01T11:00:00",
    });
    expect(second.stockOnHand).toBe(20);
    expect(second.costPrice).toBe(600); // (10×500 + 10×700) / 20
    expect(cache).toEqual({ stockOnHand: 20, costPrice: 600 });
  });

  it("defaults an inflow's unit cost to the item's cached cost", async () => {
    const { tx } = fakeTx({ costPrice: 200 });
    const posted = await recordStockMovement(tx, {
      itemId: "i1",
      kind: "MANUAL_ADJUSTMENT",
      delta: 4,
      occurredAt: "2020-01-01T10:00:00",
    });
    expect(posted.movement.unitCost).toBe(200);
    expect(posted.costPrice).toBe(200);
  });

  it("blends a legacy null-cost inflow at the item's cached cost (uniform fallback)", async () => {
    const { tx, movements } = fakeTx({ costPrice: 100, stockOnHand: 10 });
    // a legacy inflow with no stored unit cost: the seam replays it at the
    // item's cached cost. Base stockAddManual omitted the fallback and blended
    // it at 0, so this is the second deliberate unification (the outflow rule
    // is the first).
    movements.push({
      id: "legacy",
      itemId: "i1",
      kind: "PURCHASE",
      delta: 10,
      unitCost: null,
      reason: null,
      ref: null,
      returnMark: null,
      occurredAt: "2020-01-01T00:00:00",
      createdAt: "2020-01-01T00:00:00",
      seq: 0,
    });
    const posted = await recordStockMovement(tx, {
      itemId: "i1",
      kind: "PURCHASE",
      delta: 10,
      unitCost: 300,
      occurredAt: "2020-01-02T00:00:00",
    });
    expect(posted.costPrice).toBe(200); // (10×100 + 10×300) / 20
  });

  it("keeps the average on a pure outflow, stores no unit cost, and snapshots FIFO", async () => {
    const { tx } = fakeTx({ costPrice: 500 });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 500, occurredAt: "2020-01-01T10:00:00" });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 700, occurredAt: "2020-01-01T11:00:00" });

    const posted = await recordStockMovement(tx, {
      itemId: "i1",
      kind: "MANUAL_ADJUSTMENT",
      delta: -6,
      occurredAt: "2020-01-02T10:00:00",
    });
    expect(posted.stockOnHand).toBe(14);
    expect(posted.costPrice).toBe(600); // outflow never moves the average
    expect(posted.movement.unitCost).toBeNull();
    expect(posted.outflowCost).toEqual({ consumedMovements: [{ movementId: "m1", quantity: 6 }], totalCost: 3000, unitCost: 500 }); // 6 oldest @500
  });

  it("stamps the SALE FIFO snapshot and exact cogsExact from the same read", async () => {
    const { tx } = fakeTx({ costPrice: 100 });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 5, unitCost: 100, occurredAt: "2020-01-01T10:00:00" });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 5, unitCost: 200, occurredAt: "2020-01-01T11:00:00" });

    const posted = await recordStockMovement(tx, {
      itemId: "i1",
      kind: "SALE",
      delta: -6,
      occurredAt: "2020-01-02T10:00:00",
    });
    // 5@100 + 1@200 = 700 exact; rounded per-unit 117 (ADR-0005)
    expect(posted.outflowCost).toEqual({ consumedMovements: [{ movementId: "m1", quantity: 5 }, { movementId: "m2", quantity: 1 }], totalCost: 700, unitCost: 117 });
    expect(posted.stockOnHand).toBe(4);
    expect(posted.costPrice).toBe(150); // live average untouched by the sale
    expect(posted.movement.kind).toBe("SALE");
    expect(posted.movement.unitCost).toBeNull();
  });

  it("rejects an oversell before writing anything", async () => {
    const { tx, movements, cache } = fakeTx({ costPrice: 100 });
    await expect(
      recordStockMovement(tx, { itemId: "i1", kind: "SALE", delta: -5, occurredAt: "2020-01-01T10:00:00" }),
    ).rejects.toBeInstanceOf(StockLedgerError);
    expect(movements).toHaveLength(0);
    expect(cache).toEqual({ stockOnHand: 0, costPrice: 100 });
  });

  it("validates a backdated outflow with the same sources returned to the caller", async () => {
    const { tx } = fakeTx({ costPrice: 100 });
    const jan1 = await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 5, unitCost: 100, occurredAt: "2026-01-01T10:00:00" });
    const jan2 = await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 5, unitCost: 200, occurredAt: "2026-01-02T10:00:00" });
    const prior = await recordStockMovement(tx, { itemId: "i1", kind: "SALE", delta: -5, occurredAt: "2026-01-05T10:00:00" });
    expect(prior.outflowCost?.consumedMovements).toEqual([{ movementId: jan1.movement.id, quantity: 5 }]);
    const backdated = await recordStockMovement(tx, { itemId: "i1", kind: "SALE", delta: -1, occurredAt: "2026-01-03T10:00:00" });
    expect(backdated.outflowCost).toMatchObject({ totalCost: 200, consumedMovements: [{ movementId: jan2.movement.id, quantity: 1 }] });
  });

  it("clamps a backdated SALE to the newest inflow and rejects an unclamped date", async () => {
    const { tx } = fakeTx({ costPrice: 100 });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 5, unitCost: 100, occurredAt: "2020-06-01T00:00:00" });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 3, unitCost: 200, occurredAt: "2020-06-05T00:00:00" });

    // the same 6-unit sale dated Jun 3 without a bound would oversell Jun 1
    const other = fakeTx();
    await recordStockMovement(other.tx, { itemId: "i1", kind: "PURCHASE", delta: 5, unitCost: 100, occurredAt: "2020-06-01T00:00:00" });
    await recordStockMovement(other.tx, { itemId: "i1", kind: "PURCHASE", delta: 3, unitCost: 200, occurredAt: "2020-06-05T00:00:00" });
    await expect(
      recordStockMovement(other.tx, { itemId: "i1", kind: "SALE", delta: -6, occurredAt: "2020-06-03T00:00:00" }),
    ).rejects.toBeInstanceOf(StockLedgerError);

    const posted = await recordStockMovement(tx, {
      itemId: "i1",
      kind: "SALE",
      delta: -6,
      backdateTo: "2020-06-03",
    });
    expect(posted.movement.occurredAt).toBe("2020-06-05T00:00:00"); // newest inflow
    expect(posted.stockOnHand).toBe(2);
  });

  it("throws a typed missing-item error and writes nothing", async () => {
    const { tx, movements } = fakeTx();
    await expect(
      recordStockMovement(tx, { itemId: "absent", kind: "PURCHASE", delta: 1, occurredAt: "2020-01-01T10:00:00" }),
    ).rejects.toBeInstanceOf(StockItemMissingError);
    expect(movements).toHaveLength(0);
  });

  it("sets the running average on a zero-delta cost correction", async () => {
    const { tx, cache } = fakeTx({ costPrice: 100 });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 100, occurredAt: "2020-01-01T10:00:00" });

    const posted = await recordStockMovement(tx, {
      itemId: "i1",
      kind: "MANUAL_ADJUSTMENT",
      delta: 0,
      unitCost: 250,
      reason: "COST_CORRECTION",
      occurredAt: "2020-01-02T10:00:00",
    });
    expect(posted.movement.delta).toBe(0);
    expect(posted.movement.unitCost).toBe(250);
    expect(posted.stockOnHand).toBe(10);
    expect(posted.costPrice).toBe(250);
    expect(cache).toEqual({ stockOnHand: 10, costPrice: 250 });
  });

  it("does not scan full history once per remaining FIFO layer during cost recovery", async () => {
    const { tx, movements } = fakeTx({ costPrice: 0, costPriceKnown: false });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 2, costPending: true, occurredAt: "2020-01-01T00:00:00" });
    for (let index = 0; index < 3; index++) {
      await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 1, unitCost: 100, occurredAt: `2020-01-0${index + 2}T00:00:00` });
    }

    const historyLength = movements.length;
    const originalFind = Array.prototype.find;
    let fullHistoryFinds = 0;
    Array.prototype.find = new Proxy(originalFind, {
      apply(target, thisArg, args) {
        if (Array.isArray(thisArg) && thisArg.length === historyLength + 1) fullHistoryFinds += 1;
        return target.call(thisArg, args[0], args[1]);
      },
    });
    try {
      const recovered = await recordStockMovement(tx, { itemId: "i1", kind: "SALE", delta: -2, occurredAt: "2020-01-05T00:00:00" });
      expect(recovered.costPriceKnown).toBe(true);
      expect(recovered.costPrice).toBe(100);
      expect(fullHistoryFinds).toBe(0);
    } finally {
      Array.prototype.find = originalFind;
    }
  });

  it("keeps a backdated pending layer out of the trusted average after it is drained", async () => {
    const { tx, cache } = fakeTx({ costPrice: 100 });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 100, occurredAt: "2020-01-02T00:00:00" });

    const pending = await recordStockMovement(tx, {
      itemId: "i1",
      kind: "PURCHASE",
      delta: 10,
      costPending: true,
      occurredAt: "2020-01-01T00:00:00",
    });
    expect(pending.costPriceKnown).toBe(true);
    expect(pending.costPrice).toBe(100);

    await recordStockMovement(tx, { itemId: "i1", kind: "SALE", delta: -10, occurredAt: "2020-01-03T00:00:00" });
    const later = await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 2, occurredAt: "2020-01-04T00:00:00" });

    expect(later.movement.unitCost).toBe(100);
    expect(later.costPrice).toBe(100);
    expect(later.costPriceKnown).toBe(true);
    expect(cache).toEqual({ stockOnHand: 12, costPrice: 100 });
  });

  it("keeps trusted cost through a valued backdate, pending drain and default receipt", async () => {
    const { tx, cache, movements } = fakeTx({ costPrice: 100 });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 100, occurredAt: "2020-01-02T00:00:00" });
    const pending = await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, costPending: true, occurredAt: "2020-01-01T00:00:00" });
    expect(pending.costPrice).toBe(100);
    const valued = await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 100, occurredAt: "2020-01-01T12:00:00" });
    expect(valued.costPrice).toBe(100);
    expect(valued.costPriceKnown).toBe(true);

    const sale = await recordStockMovement(tx, { itemId: "i1", kind: "SALE", delta: -10, occurredAt: "2020-01-03T00:00:00" });
    expect(sale.outflowCost).toMatchObject({ totalCost: 0, unitCost: 0, costPending: true });
    const later = await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 2, occurredAt: "2020-01-04T00:00:00" });
    expect(later.movement).toMatchObject({ unitCost: 100, costPending: false });
    expect(later.costPriceKnown).toBe(true);
    expect(cache).toEqual({ stockOnHand: 22, costPrice: 100 });
    expect(movements.find((row) => row.id === pending.movement.id)).toMatchObject({ unitCost: null, costPending: true });
    expect(sale.outflowCost).toMatchObject({ totalCost: 0, costPending: true });
  });

  it("replays backdated outflows with pending history without zero-valuing the live basis", async () => {
    const { tx } = fakeTx({ costPrice: 100 });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 100, occurredAt: "2020-01-02T00:00:00" });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, costPending: true, occurredAt: "2020-01-01T00:00:00" });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 300, occurredAt: "2020-01-04T00:00:00" });

    const posted = await recordStockMovement(tx, { itemId: "i1", kind: "MANUAL_ADJUSTMENT", delta: -5, occurredAt: "2020-01-03T00:00:00" });
    // The backdate leaves 15 units at the trusted 100 basis before 10@300.
    // This must replay to 180, not preserve the chronological cache of 167.
    expect(posted).toMatchObject({ costPrice: 180, costPriceKnown: true, stockOnHand: 25 });
    expect(posted.outflowCost).toMatchObject({ totalCost: 0, costPending: true });
  });

  it("keeps pending return facts and correction precedence across later backdates", async () => {
    const { tx, movements } = fakeTx({ costPrice: 100 });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 100, occurredAt: "2020-01-02T00:00:00" });
    const returned = await recordStockMovement(tx, { itemId: "i1", kind: "SALE", delta: 10, costPending: true, reason: "RETURN_RECORDED", returnMark: "PENDING", occurredAt: "2020-01-01T00:00:00" });
    const valued = await recordStockMovement(tx, { itemId: "i1", kind: "SALE", delta: 10, unitCost: 100, reason: "RETURN_RECORDED", returnMark: "PENDING", occurredAt: "2020-01-01T12:00:00" });
    expect(valued).toMatchObject({ costPrice: 100, costPriceKnown: true });
    await recordStockMovement(tx, { itemId: "i1", kind: "MANUAL_ADJUSTMENT", delta: 0, unitCost: 250, reason: COST_CORRECTION_REASON, occurredAt: "2019-12-31T00:00:00" });
    const afterCorrection = await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 50, occurredAt: "2020-01-01T18:00:00" });
    // The correction is recorded after the three inflows, despite its date.
    expect(afterCorrection).toMatchObject({ costPrice: 200, costPriceKnown: true, stockOnHand: 40 });
    expect(movements.find((row) => row.id === returned.movement.id)).toMatchObject({ unitCost: null, costPending: true, returnMark: "PENDING" });
  });

  it("replays a recovered basis through a later backdated receipt and omitted default", async () => {
    const { tx } = fakeTx({ costPrice: 0, costPriceKnown: false });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 2, costPending: true, occurredAt: "2020-01-01T00:00:00" });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 5, unitCost: 100, occurredAt: "2020-01-02T00:00:00" });
    await recordStockMovement(tx, { itemId: "i1", kind: "SALE", delta: -3, occurredAt: "2020-01-03T00:00:00" });
    const blend = await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 1, unitCost: 200, occurredAt: "2020-01-05T00:00:00" });
    expect(blend.costPrice).toBe(120);
    // One more 100-cost receipt before the sale leaves five at 100, then
    // 1@200, so the historical replay is 117, not a blend against today's 120.
    const backdated = await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 1, unitCost: 100, occurredAt: "2020-01-02T12:00:00" });
    expect(backdated).toMatchObject({ costPrice: 117, costPriceKnown: true });
    const later = await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 1, occurredAt: "2020-01-06T00:00:00" });
    expect(later.movement).toMatchObject({ unitCost: 117, costPending: false });
    expect(later.costPrice).toBe(117);
  });

  it("does not revive an exhausted price when replay crosses a new pending opening", async () => {
    const { tx } = fakeTx({ costPrice: 500 });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 500, occurredAt: "2020-01-01T00:00:00" });
    await recordStockMovement(tx, { itemId: "i1", kind: "SALE", delta: -10, occurredAt: "2020-01-02T00:00:00" });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, costPending: true, occurredAt: "2020-01-03T00:00:00" });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 100, occurredAt: "2020-01-04T00:00:00" });
    const recovered = await recordStockMovement(tx, { itemId: "i1", kind: "SALE", delta: -10, occurredAt: "2020-01-05T00:00:00" });
    expect(recovered).toMatchObject({ costPrice: 100, costPriceKnown: true });
    const backdated = await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 100, occurredAt: "2020-01-04T12:00:00" });
    expect(backdated).toMatchObject({ costPrice: 100, costPriceKnown: true });
  });

  it("matches single posting for a mixed-backdate batch with one snapshot read", async () => {
    const specs: StockMovementSpec[] = [
      { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 100, occurredAt: "2020-01-02T00:00:00" },
      { itemId: "i1", kind: "PURCHASE", delta: 10, costPending: true, occurredAt: "2020-01-01T00:00:00" },
      { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 100, occurredAt: "2020-01-01T12:00:00" },
      { itemId: "i1", kind: "SALE", delta: -10, occurredAt: "2020-01-03T00:00:00" },
      { itemId: "i1", kind: "PURCHASE", delta: 2, occurredAt: "2020-01-04T00:00:00" },
    ];
    const singles = fakeTx();
    const expected = [];
    for (const spec of specs) expected.push(await recordStockMovement(singles.tx, spec));
    const batch = fakeTx();
    const posted = await recordStockMovements(batch.tx, specs);
    expect(posted).toEqual(expected);
    expect(posted.map((entry) => entry.costPrice)).toEqual([100, 100, 100, 100, 100]);
    expect(batch.cache).toEqual({ stockOnHand: 22, costPrice: 100 });
    expect(batch.stats).toEqual({ historyReads: 1, cacheWrites: 1 });
  });

  it("replays the full ledger on a BACKDATED outflow (issue 143 outflow rule)", async () => {
    const { tx, cache } = fakeTx({ costPrice: 100 });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 100, occurredAt: "2020-01-02T10:00:00" });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 300, occurredAt: "2020-01-03T10:00:00" });
    expect(cache.costPrice).toBe(200);

    // the old stockAddManual branch preserved the cached 200; replay is the
    // ADR-0005 value: 5@100 (10 − 5 backdated) + 10@300 → 233
    const posted = await recordStockMovement(tx, {
      itemId: "i1",
      kind: "MANUAL_ADJUSTMENT",
      delta: -5,
      occurredAt: "2020-01-02T12:00:00",
    });
    expect(posted.stockOnHand).toBe(15);
    expect(posted.costPrice).toBe(233);
  });

  it("preserves inflow-first ordering when a correction pair is posted as two calls", async () => {
    const { tx } = fakeTx({ costPrice: 100 });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 100, occurredAt: "2020-01-01T10:00:00" });

    const stamp = "2020-01-02T10:00:00";
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 300, occurredAt: stamp, reason: "INVOICE_CORRECTION #l1" });
    const posted = await recordStockMovement(tx, {
      itemId: "i1",
      kind: "MANUAL_ADJUSTMENT",
      delta: -10,
      occurredAt: stamp,
      reason: "INVOICE_CORRECTION #l1",
    });
    // +10@100 → 100; +10@300 → (1000+3000)/20 = 200; −10 → 10 units @200
    expect(posted.stockOnHand).toBe(10);
    expect(posted.costPrice).toBe(200);
  });

  it("defaults the next inflow to the cost the previous post wrote, not the created cost", async () => {
    const { tx, cache, item } = fakeTx({ costPrice: 500 });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 500, occurredAt: "2020-01-01T10:00:00" });
    await recordStockMovement(tx, { itemId: "i1", kind: "PURCHASE", delta: 5, unitCost: 700, occurredAt: "2020-01-01T11:00:00" });
    expect(cache.costPrice).toBe(567); // (10×500 + 5×700) / 15

    // no unitCost: the default must be the item's UPDATED cached cost. The fake
    // used to leave `item` at its created cost, so this posted at 500 and the
    // assertion below (and the real fallback) was never exercised.
    const posted = await recordStockMovement(tx, {
      itemId: "i1",
      kind: "PURCHASE",
      delta: 5,
      occurredAt: "2020-01-01T12:00:00",
    });
    expect(posted.movement.unitCost).toBe(567);
    expect(posted.costPrice).toBe(567); // (567×15 + 567×5) / 20
    expect(cache).toEqual({ stockOnHand: 20, costPrice: 567 });
    expect(item.costPrice).toBe(567);
  });

  it("posts a batch with one history read and one cache write per item, matching the per-line calls", async () => {
    const specs: StockMovementSpec[] = [
      { itemId: "i1", kind: "PURCHASE", delta: 10, unitCost: 100, occurredAt: "2020-01-01T10:00:00" },
      { itemId: "i1", kind: "MANUAL_ADJUSTMENT", delta: -4, occurredAt: "2020-01-02T10:00:00" },
      { itemId: "i1", kind: "PURCHASE", delta: 6, occurredAt: "2020-01-03T10:00:00" }, // default = running cache
      { itemId: "i1", kind: "MANUAL_ADJUSTMENT", delta: 0, unitCost: 250, reason: COST_CORRECTION_REASON, occurredAt: "2020-01-03T12:00:00" },
      { itemId: "i1", kind: "SALE", delta: -5, occurredAt: "2020-01-04T10:00:00" },
      { itemId: "i1", kind: "SALE", delta: -2, backdateTo: "2020-01-01" }, // clamps to the newest inflow
    ];
    // a legacy null-cost inflow makes the replay fallback observable, so a
    // batch that froze the fallback would change the average and fail here
    const legacy: Row = {
      id: "legacy",
      itemId: "i1",
      kind: "PURCHASE",
      delta: 5,
      unitCost: null,
      reason: null,
      ref: null,
      returnMark: null,
      occurredAt: "2019-12-31T10:00:00",
      createdAt: "2019-12-31T10:00:00",
      seq: 0,
    };

    const perLine = fakeTx({ costPrice: 250 });
    perLine.movements.push({ ...legacy });
    const perLineResults = [];
    for (const spec of specs) perLineResults.push(await recordStockMovement(perLine.tx, spec));

    const batch = fakeTx({ costPrice: 250 });
    batch.movements.push({ ...legacy });
    const batchResults = await recordStockMovements(batch.tx, specs);

    // identical rows, per-movement results and final cache…
    expect(batchResults).toEqual(perLineResults);
    expect(batch.movements).toEqual(perLine.movements);
    expect(batch.cache).toEqual(perLine.cache);
    // …but the batch pays the history read and cache write once per item
    expect(batch.stats).toEqual({ historyReads: 1, cacheWrites: 1 });
    expect(perLine.stats.historyReads).toBe(specs.length);
    expect(perLine.stats.cacheWrites).toBe(specs.length);
  });

  it("keeps interleaved batch history and caches isolated by item", async () => {
    const i1 = fakeTx({ itemId: "i1", costPrice: 100 });
    const i2 = fakeTx({ itemId: "i2", costPrice: 700 });
    i1.movements.push({
      id: "i1-seed",
      itemId: "i1",
      kind: "PURCHASE",
      delta: 4,
      unitCost: 100,
      reason: null,
      ref: null,
      returnMark: null,
      occurredAt: "2019-12-31T10:00:00",
      createdAt: "2019-12-31T10:00:00",
      seq: 0,
    });
    i2.movements.push({
      id: "i2-seed",
      itemId: "i2",
      kind: "PURCHASE",
      delta: 3,
      unitCost: 700,
      reason: null,
      ref: null,
      returnMark: null,
      occurredAt: "2019-12-31T10:00:00",
      createdAt: "2019-12-31T10:00:00",
      seq: 0,
    });
    i1.item.stockOnHand = 4;
    i2.item.stockOnHand = 3;
    const tx: StockPostingTx = {
      async getItemsByIds(ids) {
        const items = new Map<string, Item>();
        for (const fake of [i1, i2]) {
          for (const [id, item] of await fake.tx.getItemsByIds(ids)) items.set(id, item);
        }
        return items;
      },
      listStockMovements: (id) => (id === "i1" ? i1.tx : i2.tx).listStockMovements(id),
      insertStockMovement: (movement) => (movement.itemId === "i1" ? i1.tx : i2.tx).insertStockMovement(movement),
      setItemStockAndCost: (id, stockOnHand, costPrice) =>
        (id === "i1" ? i1.tx : i2.tx).setItemStockAndCost(id, stockOnHand, costPrice),
    };
    const specs: StockMovementSpec[] = [
      { itemId: "i1", kind: "SALE", delta: -2, occurredAt: "2020-01-02T10:00:00" },
      { itemId: "i2", kind: "SALE", delta: -1, occurredAt: "2020-01-02T10:01:00" },
      { itemId: "i1", kind: "PURCHASE", delta: 2, unitCost: 200, occurredAt: "2020-01-03T10:00:00" },
      { itemId: "i2", kind: "PURCHASE", delta: 1, unitCost: 900, occurredAt: "2020-01-03T10:01:00" },
    ];

    const results = await recordStockMovements(tx, specs);

    expect(results.map(({ stockOnHand, costPrice, outflowCost }) => ({ stockOnHand, costPrice, outflowCost }))).toEqual([
      { stockOnHand: 2, costPrice: 100, outflowCost: { consumedMovements: [{ movementId: "i1-seed", quantity: 2 }], totalCost: 200, unitCost: 100 } },
      { stockOnHand: 2, costPrice: 700, outflowCost: { consumedMovements: [{ movementId: "i2-seed", quantity: 1 }], totalCost: 700, unitCost: 700 } },
      { stockOnHand: 4, costPrice: 150, outflowCost: null },
      { stockOnHand: 3, costPrice: 767, outflowCost: null },
    ]);
    expect(i1.cache).toEqual({ stockOnHand: 4, costPrice: 150 });
    expect(i2.cache).toEqual({ stockOnHand: 3, costPrice: 767 });
    expect(i1.movements.map(({ itemId, kind, delta, unitCost }) => ({ itemId, kind, delta, unitCost }))).toEqual([
      { itemId: "i1", kind: "PURCHASE", delta: 4, unitCost: 100 },
      { itemId: "i1", kind: "SALE", delta: -2, unitCost: null },
      { itemId: "i1", kind: "PURCHASE", delta: 2, unitCost: 200 },
    ]);
    expect(i2.movements.map(({ itemId, kind, delta, unitCost }) => ({ itemId, kind, delta, unitCost }))).toEqual([
      { itemId: "i2", kind: "PURCHASE", delta: 3, unitCost: 700 },
      { itemId: "i2", kind: "SALE", delta: -1, unitCost: null },
      { itemId: "i2", kind: "PURCHASE", delta: 1, unitCost: 900 },
    ]);
    expect(i1.stats).toEqual({ historyReads: 1, cacheWrites: 1 });
    expect(i2.stats).toEqual({ historyReads: 1, cacheWrites: 1 });
  });

  it("touches the store for nothing on an empty batch", async () => {
    const { tx, stats } = fakeTx();
    expect(await recordStockMovements(tx, [])).toEqual([]);
    expect(stats).toEqual({ historyReads: 0, cacheWrites: 0 });
  });

  it("refuses a batch movement for an item that does not exist, writing nothing", async () => {
    const { tx, movements, stats } = fakeTx();
    await expect(
      recordStockMovements(tx, [{ itemId: "absent", kind: "PURCHASE", delta: 1, occurredAt: "2020-01-01T10:00:00" }]),
    ).rejects.toBeInstanceOf(StockItemMissingError);
    expect(movements).toHaveLength(0);
    expect(stats.cacheWrites).toBe(0);
  });

  it("reports an earlier movement's oversell before a later spec's missing item", async () => {
    // the missing item must not pre-empt an earlier spec's refusal: a per-line
    // loop would hit the first movement's oversell first, so the batch must too
    const { tx } = fakeTx({ costPrice: 100 });
    await expect(
      recordStockMovements(tx, [
        { itemId: "i1", kind: "SALE", delta: -1, occurredAt: "2020-01-01T10:00:00" },
        { itemId: "absent", kind: "PURCHASE", delta: 1, occurredAt: "2020-01-01T10:00:00" },
      ]),
    ).rejects.toBeInstanceOf(StockLedgerError);
  });
});
