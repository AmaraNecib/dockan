import { describe, expect, it } from "bun:test";

import i18n from "./i18n";
import { supplierEntryDirectionKey, supplierEntrySign, supplierEntrySignLabel } from "./supplier-entry-display";

/**
 * Greptile round 1 finding 6: an opposite adjustment looked identical on the
 * debts account table. The shared display rule distinguishes them.
 */
describe("supplierEntrySign", () => {
  it("#260 — a purchase/refund is a debt (−1) and a payment/return a credit (+1)", () => {
    expect(supplierEntrySign("PURCHASE", null)).toBe(-1);
    expect(supplierEntrySign("REFUND", null)).toBe(-1);
    expect(supplierEntrySign("PAYMENT", null)).toBe(1);
    expect(supplierEntrySign("RETURN", null)).toBe(1);
    expect(supplierEntrySign("ADJUSTMENT", "WE_OWE")).toBe(-1);
    expect(supplierEntrySign("ADJUSTMENT", "THEY_OWE")).toBe(1);
  });
});

describe("supplierEntrySignLabel", () => {
  it("distinguishes two equal opposite adjustments (#260)", () => {
    const up = { kind: "ADJUSTMENT" as const, direction: "WE_OWE" as const };
    const down = { kind: "ADJUSTMENT" as const, direction: "THEY_OWE" as const };
    expect(supplierEntrySignLabel(up)).toBe("−");
    expect(supplierEntrySignLabel(down)).toBe("+");
  });
});

describe("supplierEntryDirectionKey", () => {
  it("names the adjustment direction and stays null for other kinds", () => {
    expect(supplierEntryDirectionKey({ kind: "ADJUSTMENT", direction: "WE_OWE" })).toBe("supplierAdjustDirectionWeOwe");
    expect(supplierEntryDirectionKey({ kind: "ADJUSTMENT", direction: "THEY_OWE" })).toBe("supplierAdjustDirectionTheyOwe");
    expect(supplierEntryDirectionKey({ kind: "PURCHASE", direction: null })).toBeNull();
  });
});

/**
 * #260 + #252 — the ATOMIC pair. The sign and the Darija label live on the same
 * value; flipping either one alone leaves a visibly wrong pair, which is exactly
 * what this test catches. (Before #260 this assertion is red: the sign returns
 * +1 for WE_OWE / −1 for THEY_OWE.)
 */
describe("the sign/label pair is atomic (#260)", () => {
  it("puts each direction's sign and its Darija on the same value", () => {
    // يسالنا = he asks us = we owe him = the balance goes negative
    expect(supplierEntrySign("ADJUSTMENT", "WE_OWE")).toBe(-1);
    expect(i18n.t("supplierAdjustDirectionWeOwe")).toBe("يسالنا");
    // نسالوه = we ask him = he owes us = the balance goes positive (a credit)
    expect(supplierEntrySign("ADJUSTMENT", "THEY_OWE")).toBe(1);
    expect(i18n.t("supplierAdjustDirectionTheyOwe")).toBe("نسالوه");
  });
});
