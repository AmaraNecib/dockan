import { describe, expect, it } from "bun:test";

import {
  computeReturnRefund,
  lineRefundAmount,
  refundUnitPriceFor,
  remainingReturnable,
  returnCapViolation,
} from "./return-calculations";

describe("refundUnitPriceFor (whole-DZD effective per-unit refund)", () => {
  it("refunds the exact unit price when no discount was allocated", () => {
    expect(refundUnitPriceFor(1_000, 1)).toBe(1_000);
    expect(refundUnitPriceFor(2_600, 2)).toBe(1_300);
  });

  it("bases the refund on the effective net price after an allocated discount", () => {
    // 2 × 900 gross, 100 allocated discount → the customer effectively paid 850/unit
    expect(refundUnitPriceFor(1_700, 2)).toBe(850);
  });

  it("rounds half values to the nearest whole DZD like every other money figure", () => {
    expect(refundUnitPriceFor(1_000, 3)).toBe(333);
    expect(refundUnitPriceFor(1_001, 3)).toBe(334);
    expect(refundUnitPriceFor(10, 3)).toBe(3);
  });

  it("refunds zero for a free (fully discounted) line", () => {
    expect(refundUnitPriceFor(0, 5)).toBe(0);
    expect(lineRefundAmount(5, 0, 5)).toBe(0);
  });

  it("rejects a non-positive or fractional quantity", () => {
    expect(() => refundUnitPriceFor(100, 0)).toThrow(/positive integer/);
    expect(() => refundUnitPriceFor(100, -1)).toThrow(/positive integer/);
    expect(() => refundUnitPriceFor(100, 2.5)).toThrow(/positive integer/);
  });
});

describe("computeReturnRefund (line refunds + record total)", () => {
  it("sums per-line whole-DZD refunds", () => {
    const result = computeReturnRefund([
      { invoiceLineId: "l1", quantity: 2, lineQuantity: 2, netTotal: 1_700 },
      { invoiceLineId: "l2", quantity: 1, lineQuantity: 1, netTotal: 500 },
    ]);
    expect(result.lines).toEqual([
      { invoiceLineId: "l1", quantity: 2, refundUnitPrice: 850, refundAmount: 1_700 },
      { invoiceLineId: "l2", quantity: 1, refundUnitPrice: 500, refundAmount: 500 },
    ]);
    expect(result.refundTotal).toBe(2_200);
  });

  it("keeps a FULL return exact: quantity === lineQuantity refunds netTotal precisely", () => {
    const result = computeReturnRefund([{ invoiceLineId: "l1", quantity: 3, lineQuantity: 3, netTotal: 1_000 }]);
    // the displayed unit is the rounded effective price, but the amount is the
    // exact net total (333 × 3 would under-refund the customer by 1 DZD)
    expect(result.lines[0]).toMatchObject({ refundUnitPrice: 333, refundAmount: 1_000 });
    expect(result.refundTotal).toBe(1_000);
    // uneven split: round-half-up per-unit would refund 3 × 34 = 102 — one DZD
    // the customer never paid; the full return stays exactly 101
    const uneven = computeReturnRefund([{ invoiceLineId: "l1", quantity: 3, lineQuantity: 3, netTotal: 101 }]);
    expect(uneven.lines[0]).toMatchObject({ refundUnitPrice: 34, refundAmount: 101 });
  });

  it("rounds PARTIAL returns at the effective unit price (whole-DZD remainder is documented)", () => {
    const result = computeReturnRefund([{ invoiceLineId: "l1", quantity: 2, lineQuantity: 3, netTotal: 101 }]);
    expect(result.lines[0]).toMatchObject({ refundUnitPrice: 34, refundAmount: 68 });
    expect(result.refundTotal).toBe(68);
  });

  it("rejects a negative net total defensively", () => {
    expect(() => refundUnitPriceFor(-5, 3)).toThrow(/non-negative/);
    expect(() => refundUnitPriceFor(Number.NaN, 3)).toThrow(/non-negative/);
  });

  it("prices partial returns at the effective per-unit price of the WHOLE line", () => {
    // 5 units sold at 300 with no discount: 1500 net; returning 2 units
    // refunds 2 × round(1500/5) = 600, never 2 × round(1500/2)
    const result = computeReturnRefund([{ invoiceLineId: "l1", quantity: 2, lineQuantity: 5, netTotal: 1_500 }]);
    expect(result.lines[0]).toMatchObject({ refundUnitPrice: 300, refundAmount: 600 });
    expect(result.refundTotal).toBe(600);
  });

  it("handles an empty request", () => {
    expect(computeReturnRefund([])).toEqual({ lines: [], refundTotal: 0 });
  });
});

describe("remainingReturnable (sold − already returned)", () => {
  it("returns the untouched sold quantity when nothing was returned", () => {
    expect(remainingReturnable(5, 0)).toBe(5);
  });

  it("subtracts already-returned quantities", () => {
    expect(remainingReturnable(5, 2)).toBe(3);
  });

  it("floors at zero and never goes negative", () => {
    expect(remainingReturnable(5, 5)).toBe(0);
    expect(remainingReturnable(5, 9)).toBe(0);
  });
});

describe("returnCapViolation (per-line refund cap)", () => {
  const lines = [
    { id: "l1", quantity: 5 },
    { id: "l2", quantity: 2 },
  ];

  it("accepts a request fully inside every line's cap", () => {
    const violation = returnCapViolation(
      [
        { invoiceLineId: "l1", quantity: 3 },
        { invoiceLineId: "l2", quantity: 2 },
      ],
      lines,
      new Map(),
    );
    expect(violation).toBeNull();
  });

  it("rejects an over-return with the exact remaining amount", () => {
    const violation = returnCapViolation([{ invoiceLineId: "l1", quantity: 4 }], lines, new Map([["l1", 2]]));
    expect(violation).toEqual({ invoiceLineId: "l1", requested: 4, remaining: 3 });
  });

  it("accepts returning exactly what remains (boundary)", () => {
    const violation = returnCapViolation([{ invoiceLineId: "l2", quantity: 1 }], lines, new Map([["l2", 1]]));
    expect(violation).toBeNull();
  });

  it("accumulates duplicate entries for one line within the request", () => {
    // l1 sold 5; [l1:3, l1:3] sums to 6 — refused even though each fits alone
    const violation = returnCapViolation(
      [
        { invoiceLineId: "l1", quantity: 3 },
        { invoiceLineId: "l1", quantity: 3 },
      ],
      lines,
      new Map(),
    );
    expect(violation).toEqual({ invoiceLineId: "l1", requested: 6, remaining: 5 });
  });

  it("accepts duplicate entries whose sum stays inside the cap", () => {
    const violation = returnCapViolation(
      [
        { invoiceLineId: "l1", quantity: 2 },
        { invoiceLineId: "l1", quantity: 2 },
      ],
      lines,
      new Map(),
    );
    expect(violation).toBeNull();
  });

  it("ignores unknown lines (the router owns that validation)", () => {
    const violation = returnCapViolation([{ invoiceLineId: "nope", quantity: 99 }], lines, new Map());
    expect(violation).toBeNull();
  });
});