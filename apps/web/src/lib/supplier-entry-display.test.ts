import { describe, expect, it } from "bun:test";

import i18n from "./i18n";
import { supplierBalanceDirectionKey, supplierEntryDirectionKey, supplierEntrySign, supplierEntrySignLabel } from "./supplier-entry-display";

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
 * #260 (PR #271 finding) — the ONE balance → word mapping. A negative balance is
 * the debt we owe; a positive one is the supplier's credit; zero reads as owed,
 * matching `SupplierBalanceHeader`. The preview used to invert this comparison,
 * so the word contradicted what saving recorded.
 */
describe("supplierBalanceDirectionKey", () => {
  it("maps a negative balance to the debt word and a positive one to the credit word (#260)", () => {
    expect(supplierBalanceDirectionKey(-500)).toBe("supplierAdjustDirectionWeOwe");
    expect(supplierBalanceDirectionKey(500)).toBe("supplierAdjustDirectionTheyOwe");
  });

  it("reads zero as owed, matching the balance header (#260)", () => {
    expect(supplierBalanceDirectionKey(0)).toBe("supplierAdjustDirectionWeOwe");
  });

  it("flips at the sign boundary, not at zero-width values (#260)", () => {
    expect(supplierBalanceDirectionKey(1)).toBe("supplierAdjustDirectionTheyOwe");
    expect(supplierBalanceDirectionKey(-1)).toBe("supplierAdjustDirectionWeOwe");
  });

  it("round-trips the ledger's entry sign: the sign's direction is the word's direction (#260)", () => {
    // supplierEntrySign("ADJUSTMENT", "WE_OWE") = −1, and a −1 balance is «يسالنا»
    expect(supplierBalanceDirectionKey(supplierEntrySign("ADJUSTMENT", "WE_OWE"))).toBe("supplierAdjustDirectionWeOwe");
    expect(supplierBalanceDirectionKey(supplierEntrySign("ADJUSTMENT", "THEY_OWE"))).toBe("supplierAdjustDirectionTheyOwe");
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
