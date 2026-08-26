import { describe, expect, it } from "bun:test";

import {
  StockLedgerError,
  averageCostAfter,
  fifoCostForOutflow,
  fifoOutflowCost,
  historyWithRemaining,
  projectLedger,
  saleMovementTime,
  stockAsOf,
  weightedAverageCost,
} from "./stock-ledger";

/**
 * Pure ledger-math tests (spec: ticket 27 — seam 1). No IO; movements are
 * plain arrays. FIFO projection must be deterministic and never mutate
 * history (acceptance criteria, issue #27).
 */

const m = (
  kind: "PURCHASE" | "SALE" | "MANUAL_ADJUSTMENT",
  delta: number,
  unitCost: number | null = null,
  occurredAt = "2025-01-01T10:00:00",
  seq?: number,
) => ({ kind, delta, unitCost, occurredAt, seq });

describe("projectLedger — FIFO consumption", () => {
  it("consumes the oldest layer first across mixed costs", () => {
    const p = projectLedger([
      m("PURCHASE", 10, 500, "2025-01-01T10:00:00"),
      m("PURCHASE", 10, 700, "2025-01-02T10:00:00"),
      m("SALE", -15, null, "2025-01-03T10:00:00"),
    ]);
    expect(p.stockOnHand).toBe(5);
    expect(p.layers).toEqual([{ quantity: 5, unitCost: 700 }]);
  });

  it("spans multiple layers for one sale and leaves older remainder first", () => {
    const p = projectLedger([
      m("PURCHASE", 5, 100),
      m("PURCHASE", 5, 200),
      m("SALE", -6),
    ]);
    expect(p.stockOnHand).toBe(4);
    // 4 units remain at the newer cost
    expect(p.layers).toEqual([{ quantity: 4, unitCost: 200 }]);
  });

  it("orders same-timestamp movements by seq, not array luck", () => {
    const p = projectLedger([
      m("PURCHASE", 10, 500, "2025-01-01T10:00:00", 2),
      m("PURCHASE", 10, 300, "2025-01-01T10:00:00", 1),
      m("SALE", -10),
    ]);
    // oldest by seq is the 300-cost layer → consumed first
    expect(p.layers).toEqual([{ quantity: 10, unitCost: 500 }]);
  });

  it("falls back to the fallback unit cost when an inflow omits one", () => {
    const p = projectLedger([m("MANUAL_ADJUSTMENT", 4)], { fallbackUnitCost: 250 });
    expect(p.layers).toEqual([{ quantity: 4, unitCost: 250 }]);
  });
});

describe("fifoCostForOutflow", () => {
  it("uses FIFO layers and rounds the consumed weighted unit cost", () => {
    const movements = [m("PURCHASE", 5, 100), m("PURCHASE", 5, 200)];
    expect(fifoCostForOutflow(movements, 6)).toBe(117);
    expect(projectLedger([...movements, m("SALE", -6)]).layers).toEqual([{ quantity: 4, unitCost: 200 }]);
  });

  it("rejects an outflow larger than available stock", () => {
    expect(() => fifoCostForOutflow([m("PURCHASE", 2, 100)], 3)).toThrow(StockLedgerError);
  });
});

describe("fifoOutflowCost", () => {
  it("returns the exact unrounded layer sum alongside the rounded unit snapshot", () => {
    // 5×100 + 5×200, 6-unit sale: exact total 700, rounded unit 117
    const cost = fifoOutflowCost([m("PURCHASE", 5, 100), m("PURCHASE", 5, 200)], 6);
    expect(cost.totalCost).toBe(700);
    expect(cost.unitCost).toBe(117);
  });

  it("keeps the ADR-0005 drift example: product of the rounded unit is not the exact total", () => {
    // layers 2×10 + 1×15, 3-unit sale → exact 35, rounded unit 12 (3×12 = 36)
    const cost = fifoOutflowCost([m("PURCHASE", 2, 10), m("PURCHASE", 1, 15)], 3);
    expect(cost.totalCost).toBe(35);
    expect(cost.unitCost).toBe(12);
    expect(3 * cost.unitCost).not.toBe(cost.totalCost);
  });

  it("spans layers and reports the exact total even when the rounded unit is exact", () => {
    const cost = fifoOutflowCost([m("PURCHASE", 5, 100), m("PURCHASE", 5, 200)], 10);
    expect(cost.totalCost).toBe(1_500);
    expect(cost.unitCost).toBe(150);
  });

  it("rejects invalid quantity and oversell like fifoCostForOutflow", () => {
    expect(() => fifoOutflowCost([m("PURCHASE", 2, 100)], 0)).toThrow(/positive integer/);
    expect(() => fifoOutflowCost([m("PURCHASE", 2, 100)], 3)).toThrow(StockLedgerError);
  });
});

describe("saleMovementTime (issue 43 bound)", () => {
  const purchase = (delta: number, unitCost: number, occurredAt: string) => m("PURCHASE", delta, unitCost, occurredAt);

  it("uses invoice-day midnight when no inflow exists", () => {
    expect(saleMovementTime("2026-06-03", [])).toBe("2026-06-03T00:00:00");
    expect(saleMovementTime("2026-06-03", [m("SALE", -2, null, "2026-06-01T12:00:00")])).toBe("2026-06-03T00:00:00");
  });

  it("clamps to the newest inflow when it postdates the invoice", () => {
    const movements = [
      purchase(5, 100, "2026-06-01T08:00:00"),
      purchase(3, 200, "2026-06-05T09:00:00"),
    ];
    expect(saleMovementTime("2026-06-03", movements)).toBe("2026-06-05T09:00:00");
  });

  it("keeps invoice-day midnight when every inflow predates it", () => {
    const movements = [purchase(5, 100, "2026-06-01T08:00:00")];
    expect(saleMovementTime("2026-06-03", movements)).toBe("2026-06-03T00:00:00");
  });

  it("generalizes the bound to any inflow, including manual adjustments", () => {
    const movements = [purchase(5, 100, "2026-06-01T08:00:00"), m("MANUAL_ADJUSTMENT", 4, 300, "2026-06-07T10:30:00")];
    expect(saleMovementTime("2026-06-03", movements)).toBe("2026-06-07T10:30:00");
  });

  it("never extends the bound for outflows recorded after the last inflow", () => {
    const movements = [
      purchase(8, 100, "2026-06-01T08:00:00"),
      m("SALE", -2, null, "2026-06-06T15:00:00"),
    ];
    // invoice dated after the sale: outflows must not count as a bound
    expect(saleMovementTime("2026-06-07", movements)).toBe("2026-06-07T00:00:00");
  });

  it("keeps FIFO replay valid where the un-clamped date would throw STOCK_NEGATIVE", () => {
    // 5@100 on Jun 1 + 3@200 on Jun 5; a 6-unit sale dated Jun 3 would consume
    // layers that don't exist yet at Jun 3 (stock there is 5). The bound moves
    // the row after the Jun 5 inflow and the full ledger replays cleanly.
    const movements = [purchase(5, 100, "2026-06-01T08:00:00"), purchase(3, 200, "2026-06-05T09:00:00")];
    const clamped = saleMovementTime("2026-06-03", movements);
    expect(() => projectLedger([...movements, m("SALE", -6, null, "2026-06-03T00:00:00")])).toThrow(StockLedgerError);
    expect(projectLedger([...movements, m("SALE", -6, null, clamped)]).stockOnHand).toBe(2);
  });

  it("replays identically whether the dated row lands on the inflow instant or after it", () => {
    const movements = [purchase(5, 100, "2026-06-01T08:00:00")];
    const time = saleMovementTime("2026-06-03", movements);
    const projected = projectLedger([...movements, m("SALE", -2, null, time)]);
    expect(projected.stockOnHand).toBe(3);
    expect(projected.layers).toEqual([{ quantity: 3, unitCost: 100 }]);
  });
});

describe("projectLedger — invariants", () => {
  it("rejects a sale that would drive stock negative (fail loud)", () => {
    expect(() =>
      projectLedger([m("PURCHASE", 3, 100), m("SALE", -5)]),
    ).toThrow(StockLedgerError);
    try {
      projectLedger([m("PURCHASE", 3, 100), m("SALE", -5)]);
    } catch (err) {
      // SAFETY: the assertion above just proved this is the StockLedgerError type
      expect((err as StockLedgerError).code).toBe("STOCK_NEGATIVE");
    }
  });

  it("rejects a sale with no layers at all", () => {
    expect(() => projectLedger([m("SALE", -1)])).toThrow(StockLedgerError);
  });

  it("does not mutate the input array (projection reads history only)", () => {
    const movements = [m("PURCHASE", 5, 100), m("SALE", -2)];
    const snapshot = structuredClone(movements);
    projectLedger(movements);
    expect(movements).toEqual(snapshot);
  });

  it("handles an empty ledger", () => {
    expect(projectLedger([])).toEqual({ stockOnHand: 0, layers: [] });
  });
});

describe("stockAsOf", () => {
  const movements = [
    m("PURCHASE", 10, 100, "2025-03-01T09:00:00"),
    m("SALE", -4, null, "2025-03-05T12:00:00"),
    m("PURCHASE", 6, 200, "2025-03-10T08:00:00"),
  ];

  it("replays only movements up to the given Algeria-local date", () => {
    expect(stockAsOf(movements, "2025-03-01")).toBe(10);
    expect(stockAsOf(movements, "2025-03-05")).toBe(6);
    expect(stockAsOf(movements, "2025-03-31")).toBe(12);
  });

  it("returns 0 before any movement", () => {
    expect(stockAsOf(movements, "2025-02-28")).toBe(0);
  });
});

describe("historyWithRemaining", () => {
  it("attaches derived stock after each movement, oldest first", () => {
    const rows = historyWithRemaining([
      m("PURCHASE", 10, 500, "2025-01-01T10:00:00"),
      m("SALE", -4, null, "2025-01-03T10:00:00"),
      m("MANUAL_ADJUSTMENT", -1, null, "2025-01-02T10:00:00"),
    ]);
    // out-of-order input: sorted by occurredAt
    expect(rows.map((r) => r.delta)).toEqual([10, -1, -4]);
    expect(rows.map((r) => r.stockAfter)).toEqual([10, 9, 5]);
  });

  it("throws on a corrupt (negative) history", () => {
    expect(() => historyWithRemaining([m("PURCHASE", 1, 100), m("SALE", -2)])).toThrow(
      StockLedgerError,
    );
  });
});

describe("averageCostAfter (ADR-0002 weighted average)", () => {
  it("blends inbound cost into the running average", () => {
    expect(averageCostAfter(500, 10, 10, 700)).toBe(600);
  });
  it("keeps the average when nothing is held", () => {
    expect(averageCostAfter(0, 0, 8, 125)).toBe(125);
  });
});

describe("weightedAverageCost (ADR-0002 replay)", () => {
  const m = (delta: number, unitCost: number | null, occurredAt: string) => ({
    kind: delta > 0 ? "PURCHASE" : "SALE",
    delta,
    unitCost,
    occurredAt,
  } as const);

  it("matches incremental blending for chronological inflows", () => {
    expect(
      weightedAverageCost([m(10, 500, "2025-01-01T00:00:00"), m(10, 700, "2025-01-02T00:00:00")]),
    ).toBe(600);
  });

  it("is position-independent: a backdated inflow yields the historical replay average, not FIFO layer value", () => {
    // chronological: 5@50, 10@100 → avg 83; then 10@200 → (83*15 + 2000)/25 = 130
    const movements = [
      m(10, 100, "2025-01-02T00:00:00"),
      m(10, 200, "2025-01-03T00:00:00"),
      m(5, 50, "2025-01-01T00:00:00"), // backdated
    ];
    expect(weightedAverageCost(movements)).toBe(130);
  });

  it("outflows never change the average — unlike FIFO layer valuation", () => {
    // 10@100 + 10@300 → avg 200; sale of the ENTIRE cheap layer
    const movements = [m(10, 100, "2025-01-01T00:00:00"), m(10, 300, "2025-01-02T00:00:00"), m(-10, null, "2025-01-03T00:00:00")];
    // FIFO remaining-layer avg would say 300; ADR-0002 says the average is untouched
    expect(weightedAverageCost(movements)).toBe(200);
  });
});
