import { describe, expect, it } from "bun:test";

import {
  effectiveUnitCost,
  isRepeatedAdjustment,
  REPEAT_WINDOW_MS,
  stockAdjustmentSignature,
  type StockAdjustment,
} from "./stock-adjustment";

/**
 * #295 — the guard that keeps one stock adjustment from being applied twice.
 *
 * The pure half is pinned here; the wire half (two clients, one refusal) is
 * in `rpc/router.test.ts`.
 */

const adjustment = (over: Partial<StockAdjustment> = {}): StockAdjustment => ({
  itemId: "item-1",
  kind: "MANUAL_ADJUSTMENT",
  delta: 5,
  unitCost: 100,
  reason: "delivery",
  ...over,
});

describe("stock adjustment identity (#295)", () => {
  it("gives the same signature to the same action", () => {
    expect(stockAdjustmentSignature(adjustment())).toBe(stockAdjustmentSignature(adjustment()));
  });

  it("separates the actions that move the stock differently", () => {
    const base = stockAdjustmentSignature(adjustment());
    expect(stockAdjustmentSignature(adjustment({ itemId: "item-2" }))).not.toBe(base);
    expect(stockAdjustmentSignature(adjustment({ kind: "PURCHASE" }))).not.toBe(base);
    expect(stockAdjustmentSignature(adjustment({ delta: -5 }))).not.toBe(base);
    expect(stockAdjustmentSignature(adjustment({ unitCost: 120 }))).not.toBe(base);
    expect(stockAdjustmentSignature(adjustment({ reason: "count" }))).not.toBe(base);
    expect(stockAdjustmentSignature(adjustment({ reason: null }))).not.toBe(base);
  });

  it("records the cost the ledger will hold, not the one the request spelled out", () => {
    // an inflow without a cost takes the item's cached average cost
    expect(effectiveUnitCost(5, undefined, 250)).toBe(250);
    // an explicit cost wins
    expect(effectiveUnitCost(5, 120, 250)).toBe(120);
    // an outflow never carries one
    expect(effectiveUnitCost(-5, 120, 250)).toBeNull();
    expect(effectiveUnitCost(-5, undefined, 250)).toBeNull();
  });
});

describe("repeated adjustment detection (#295)", () => {
  const cutoff = "2026-10-19 10:00:00";

  it("refuses a repeat recorded inside the window", () => {
    const last = { adjustment: adjustment(), recordedAt: "2026-10-19 10:00:20" };
    expect(isRepeatedAdjustment(last, adjustment(), cutoff)).toBe(true);
  });

  it("allows the same action once the window has passed", () => {
    const last = { adjustment: adjustment(), recordedAt: "2026-10-19 09:59:00" };
    expect(isRepeatedAdjustment(last, adjustment(), cutoff)).toBe(false);
  });

  it("allows a different action inside the window", () => {
    const last = { adjustment: adjustment({ delta: -3 }), recordedAt: "2026-10-19 10:00:20" };
    expect(isRepeatedAdjustment(last, adjustment(), cutoff)).toBe(false);
  });

  it("allows anything when nothing was recorded for the item", () => {
    expect(isRepeatedAdjustment(undefined, adjustment(), cutoff)).toBe(false);
  });

  it("keeps the window a bounded, documented number of milliseconds", () => {
    expect(REPEAT_WINDOW_MS).toBe(30_000);
  });
});
