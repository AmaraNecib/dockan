import { describe, expect, it } from "bun:test";

import { supplierEntryDirectionKey, supplierEntrySign, supplierEntrySignLabel } from "./supplier-entry-display";

/**
 * Greptile round 1 finding 6: an opposite adjustment looked identical on the
 * debts account table. The shared display rule distinguishes them.
 */
describe("supplierEntrySign", () => {
  it("charges purchases/refunds and a WE_OWE adjustment, credits the rest", () => {
    expect(supplierEntrySign("PURCHASE", null)).toBe(1);
    expect(supplierEntrySign("REFUND", null)).toBe(1);
    expect(supplierEntrySign("PAYMENT", null)).toBe(-1);
    expect(supplierEntrySign("RETURN", null)).toBe(-1);
    expect(supplierEntrySign("ADJUSTMENT", "WE_OWE")).toBe(1);
    expect(supplierEntrySign("ADJUSTMENT", "THEY_OWE")).toBe(-1);
  });
});

describe("supplierEntrySignLabel", () => {
  it("distinguishes two equal opposite adjustments", () => {
    const up = { kind: "ADJUSTMENT" as const, direction: "WE_OWE" as const };
    const down = { kind: "ADJUSTMENT" as const, direction: "THEY_OWE" as const };
    expect(supplierEntrySignLabel(up)).toBe("+");
    expect(supplierEntrySignLabel(down)).toBe("−");
  });
});

describe("supplierEntryDirectionKey", () => {
  it("names the adjustment direction and stays null for other kinds", () => {
    expect(supplierEntryDirectionKey({ kind: "ADJUSTMENT", direction: "WE_OWE" })).toBe("supplierAdjustDirectionWeOwe");
    expect(supplierEntryDirectionKey({ kind: "ADJUSTMENT", direction: "THEY_OWE" })).toBe("supplierAdjustDirectionTheyOwe");
    expect(supplierEntryDirectionKey({ kind: "PURCHASE", direction: null })).toBeNull();
  });
});
