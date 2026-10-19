import { describe, expect, it } from "bun:test";

import type { StockMovement } from "@dokan/contracts";

import {
  expressUnitCost,
  matchesAdjustment,
  repeatCutoff,
  REPEAT_WINDOW_MS,
  type StockAdjustment,
} from "./stock-adjustment";

/**
 * #295 — the guard that keeps one stock adjustment from being applied twice.
 *
 * The pure half is pinned here; the wire half (two clients, one refusal) is
 * in `rpc/router.test.ts`, and the window the store applies is in
 * `store/stock-ledger-store.test.ts`.
 */

const adjustment = (over: Partial<StockAdjustment> = {}): StockAdjustment => ({
  itemId: "item-1",
  kind: "MANUAL_ADJUSTMENT",
  delta: 5,
  unitCost: 100,
  reason: "delivery",
  occurredAt: null,
  ...over,
});

/** A movement as the store hands it back. */
const recorded = (over: Partial<StockMovement> = {}): StockMovement => ({
  id: "movement-1",
  itemId: "item-1",
  kind: "MANUAL_ADJUSTMENT",
  delta: 5,
  unitCost: 100,
  reason: "delivery",
  ref: null,
  returnMark: null,
  occurredAt: "2026-10-19T10:00:20",
  createdAt: "2026-10-19T10:00:20",
  ...over,
});

describe("stock adjustment identity (#295)", () => {
  it("matches the movement it would have written", () => {
    expect(matchesAdjustment(adjustment(), recorded())).toBe(true);
  });

  it("separates the actions that move the stock differently", () => {
    const row = recorded();
    expect(matchesAdjustment(adjustment({ itemId: "item-2" }), row)).toBe(false);
    expect(matchesAdjustment(adjustment({ kind: "PURCHASE" }), row)).toBe(false);
    expect(matchesAdjustment(adjustment({ delta: -5 }), row)).toBe(false);
    expect(matchesAdjustment(adjustment({ unitCost: 120 }), row)).toBe(false);
    expect(matchesAdjustment(adjustment({ reason: "count" }), row)).toBe(false);
    expect(matchesAdjustment(adjustment({ reason: null }), row)).toBe(false);
  });

  it("leaves out a cost the request did not express", () => {
    // an inflow with no cost means "at the item's cost", and the server
    // derives that at posting time — the first posting moves the average, so
    // a derived cost in the identity would let the retry past the guard
    expect(matchesAdjustment(adjustment({ unitCost: undefined }), recorded({ unitCost: 137 }))).toBe(true);
    // an explicit cost still has to match
    expect(matchesAdjustment(adjustment({ unitCost: 137 }), recorded({ unitCost: 100 }))).toBe(false);
  });

  it("treats an outflow as costless, whatever the request sent", () => {
    expect(expressUnitCost(-5, 120, 100)).toBeUndefined();
    expect(expressUnitCost(-5, undefined, 100)).toBeUndefined();
    expect(matchesAdjustment(adjustment({ delta: -5, unitCost: undefined }), recorded({ delta: -5, unitCost: null }))).toBe(true);
  });

  it("leaves out a cost the server would have derived anyway", () => {
    // the web pre-fills the cost field with the item's current cost, so a
    // retry after the average moved carries a different number that means
    // the same thing
    expect(expressUnitCost(5, 100, 100)).toBeUndefined();
    expect(expressUnitCost(5, undefined, 100)).toBeUndefined();
    expect(expressUnitCost(-5, 100, 100)).toBeUndefined();
    // a cost of the owner's own is part of the identity
    expect(expressUnitCost(5, 300, 100)).toBe(300);
  });

  it("keeps a caller-supplied business date and drops a server-stamped one", () => {
    // the server stamps the date, so two identical requests differ on it
    expect(matchesAdjustment(adjustment({ occurredAt: null }), recorded({ occurredAt: "2026-10-19T10:00:20" }))).toBe(true);
    // a dated request is dated, and only that date is the same action
    expect(matchesAdjustment(adjustment({ occurredAt: "2026-10-18T09:00:00" }), recorded())).toBe(false);
    expect(
      matchesAdjustment(adjustment({ occurredAt: "2026-10-19T10:00:20" }), recorded({ occurredAt: "2026-10-19T10:00:20" })),
    ).toBe(true);
  });
});

describe("the repeat window (#295)", () => {
  it("keeps the window a bounded, documented number of milliseconds", () => {
    expect(REPEAT_WINDOW_MS).toBe(30_000);
  });

  it("puts the cutoff at the window's edge, in the format the store records", () => {
    // the server's local stamp: "YYYY-MM-DDTHH:mm:ss", one zone, fixed width
    expect(repeatCutoff(new Date("2026-10-19T10:00:30.000Z"))).toBe("2026-10-19T11:00:00");
  });
});
