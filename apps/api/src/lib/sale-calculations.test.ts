import { describe, expect, it } from "bun:test";

import { allocateInvoiceDiscount, calculateSaleTotals, resolveActualUnitPrice } from "./sale-calculations";

describe("sale calculations", () => {
  it("keeps each calculation paired with its source input", () => {
    const first = { quantity: 2, price: { defaultUnitPrice: 100 }, source: { lineId: "first" } };
    const second = { quantity: 1, price: { defaultUnitPrice: 50 }, source: { lineId: "second" } };

    const result = calculateSaleTotals([first, second]);

    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]?.input).toBe(first);
    expect(result.lines[1]?.input).toBe(second);
  });

  it("keeps allocated discounts and net totals attached to distinct source IDs", () => {
    const lines = [
      { quantity: 2, price: { defaultUnitPrice: 137 }, source: { lineId: "source-a" } },
      { quantity: 3, price: { defaultUnitPrice: 83 }, source: { lineId: "source-b" } },
      { quantity: 1, price: { defaultUnitPrice: 47 }, source: { lineId: "source-c" } },
    ];

    const result = calculateSaleTotals(lines, { type: "PERCENTAGE", value: 11 });

    expect(result.lines.map(({ input, discountAllocated, netTotal }) => ({
      lineId: input.source.lineId,
      discountAllocated,
      netTotal,
    }))).toEqual([
      { lineId: "source-a", discountAllocated: 30, netTotal: 244 },
      { lineId: "source-b", discountAllocated: 28, netTotal: 221 },
      { lineId: "source-c", discountAllocated: 5, netTotal: 42 },
    ]);
  });

  it("keeps the default price and applies an amount override", () => {
    expect(resolveActualUnitPrice({ defaultUnitPrice: 1_000, priceOverride: { type: "AMOUNT", value: 850 } })).toBe(850);
    expect(resolveActualUnitPrice({ defaultUnitPrice: 1_000 })).toBe(1_000);
  });

  it("resolves a percentage override as a percentage of the default", () => {
    expect(resolveActualUnitPrice({ defaultUnitPrice: 1_000, priceOverride: { type: "PERCENTAGE", value: 85 } })).toBe(850);
  });

  it("rounds percentage invoice discounts to whole DZD", () => {
    const result = calculateSaleTotals(
      [{ quantity: 3, price: { defaultUnitPrice: 101, unitPrice: 101 } }],
      { type: "PERCENTAGE", value: 10 },
    );
    expect(result.subtotalAmount).toBe(303);
    expect(result.discountAmount).toBe(30);
    expect(result.totalAmount).toBe(273);
    expect(result.lines[0]).toMatchObject({ grossTotal: 303, discountAllocated: 30, netTotal: 273 });
  });

  it("caps an amount discount at the subtotal and never makes total negative", () => {
    const result = calculateSaleTotals(
      [
        { quantity: 2, price: { defaultUnitPrice: 100, unitPrice: 100 } },
        { quantity: 1, price: { defaultUnitPrice: 50, unitPrice: 50 } },
      ],
      { type: "AMOUNT", value: 999 },
    );
    expect(result.discountAmount).toBe(250);
    expect(result.totalAmount).toBe(0);
    expect(result.lines.map((line) => line.netTotal)).toEqual([0, 0]);
  });

  it("allocates invoice discount exactly, with stable largest-remainder ties", () => {
    expect(allocateInvoiceDiscount([100, 50, 50], 10)).toEqual([5, 3, 2]);
    expect(allocateInvoiceDiscount([1, 1], 1)).toEqual([1, 0]);
    expect(allocateInvoiceDiscount([100, 50], 999)).toEqual([100, 50]);
  });

  it("preserves reconciliation across overrides, discount, and line reporting", () => {
    const result = calculateSaleTotals(
      [
        { quantity: 2, price: { defaultUnitPrice: 1_000, priceOverride: { type: "AMOUNT", value: 900 } } },
        { quantity: 1, price: { defaultUnitPrice: 500, unitPrice: 500 } },
      ],
      { type: "PERCENTAGE", value: 10 },
    );
    expect(result.subtotalAmount).toBe(2_300);
    expect(result.discountAmount).toBe(230);
    expect(result.lines.reduce((sum, line) => sum + line.discountAllocated, 0)).toBe(result.discountAmount);
    expect(result.lines.reduce((sum, line) => sum + line.netTotal, 0)).toBe(result.totalAmount);
  });
});
