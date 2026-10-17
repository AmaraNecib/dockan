import { describe, expect, it } from "bun:test";

import { supplierAdjustInputSchema } from "@dokan/contracts";

import i18n from "./i18n";

import { supplierBalanceDirectionKey, supplierDirectionHintKey, supplierDirectionKey, supplierEntryDirectionKey, supplierEntrySign, supplierEntrySignLabel } from "./supplier-entry-display";

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

/**
 * #252 — label-to-VALUE, not label text.
 *
 * The Darija is the shopkeeper's "who asks whom" idiom, and the asker is the
 * creditor: «يسالنا» = he asks us → THE shop owes him (WE_OWE); «نسالوه» = we ask
 * him → HE owes the shop (THEY_OWE). #176 attached each string to the other
 * value, so every label contradicted the hint rendered beside it and a user
 * picking by the visible label stored the opposite direction.
 *
 * The assertions below name the string whose gloss is "we owe him" and require it
 * on WE_OWE, and the string whose gloss is "he owes us" on THEY_OWE. Swapping the
 * two resource values — the original bug — reddens both. The hint assertions are
 * the second half: swapping the HINTS instead of the labels reddens them, so a
 * wrong "fix" cannot pass by moving both.
 */
const DARIJA_WE_OWE = "يسالنا"; // he asks us → we owe him
const DARIJA_THEY_OWE = "نسالوه"; // we ask him → he owes us

describe("supplier-direction labels (issue 252)", () => {
  it("puts the 'we owe him' string on WE_OWE and the 'he owes us' string on THEY_OWE", () => {
    expect(i18n.t("supplierAdjustDirectionWeOwe")).toBe(DARIJA_WE_OWE);
    expect(i18n.t("supplierAdjustDirectionTheyOwe")).toBe(DARIJA_THEY_OWE);
  });

  it("keeps each label on the value its own hint describes", () => {
    // the hints are the ground truth for the direction: "we owe him — it raises
    // what we owe" on WE_OWE, "he owes us — it lowers what we owe" on THEY_OWE
    expect(i18n.t("supplierAdjustDirectionWeOweHint")).toContain("نحن ندين له");
    expect(i18n.t("supplierAdjustDirectionTheyOweHint")).toContain("هو يدين لنا");
    // and the sign the api stores for each value must agree with its hint
    expect(supplierEntrySign("ADJUSTMENT", "WE_OWE")).toBe(1);
    expect(supplierEntrySign("ADJUSTMENT", "THEY_OWE")).toBe(-1);
  });

  it("reads the labels through the shared direction map, so a picker cannot drift from the movement rows", () => {
    // #252: this one function is how the picker's items map, the trigger and the
    // debts/party-detail movement rows all resolve a direction to its label
    expect(i18n.t(supplierDirectionKey("WE_OWE"))).toBe(DARIJA_WE_OWE);
    expect(i18n.t(supplierDirectionKey("THEY_OWE"))).toBe(DARIJA_THEY_OWE);
    expect(supplierEntryDirectionKey({ kind: "ADJUSTMENT", direction: "WE_OWE" })).toBe(supplierDirectionKey("WE_OWE"));
    expect(supplierEntryDirectionKey({ kind: "ADJUSTMENT", direction: "THEY_OWE" })).toBe(supplierDirectionKey("THEY_OWE"));
  });

  it("pairs each direction's label with the hint that describes it", () => {
    // the two strings for one direction are resolved in one module, so a label
    // cannot be left sitting on the other value while its hint stays correct
    expect(supplierDirectionHintKey("WE_OWE")).toBe("supplierAdjustDirectionWeOweHint");
    expect(supplierDirectionHintKey("THEY_OWE")).toBe("supplierAdjustDirectionTheyOweHint");
    // and the resolved pair says the same thing: "we owe him" beside WE_OWE
    expect(i18n.t(supplierDirectionKey("WE_OWE"))).toBe(DARIJA_WE_OWE);
    expect(i18n.t(supplierDirectionHintKey("WE_OWE"))).toContain("نحن ندين له");
    expect(i18n.t(supplierDirectionKey("THEY_OWE"))).toBe(DARIJA_THEY_OWE);
    expect(i18n.t(supplierDirectionHintKey("THEY_OWE"))).toContain("هو يدين لنا");
  });

  it("reads a signed supplier balance as the direction that sign means", () => {
    expect(supplierBalanceDirectionKey(500)).toBe("supplierAdjustDirectionWeOwe");
    expect(supplierBalanceDirectionKey(-300)).toBe("supplierAdjustDirectionTheyOwe");
    // zero reads as WE_OWE: the convention the saved-balance column already used
    expect(supplierBalanceDirectionKey(0)).toBe("supplierAdjustDirectionWeOwe");
  });

  /**
   * Greptile round 3, finding 1: the shared contract's refusal text still said a
   * linked reduction must be «يسالنا» (the WE_OWE word) while its own check
   * REQUIRES `THEY_OWE`. The picker had already been corrected, so a developer
   * reading the contract got the opposite advice. Resolve the expected word from
   * the same i18n pair the picker renders, so the two readings can never drift
   * apart again.
   */
  it("names the direction it actually requires in the linked-reduction refusal", () => {
    const result = supplierAdjustInputSchema.safeParse({
      supplierId: "00000000-0000-4000-8000-000000000000",
      direction: "WE_OWE",
      amount: 100,
      invoiceId: "00000000-0000-4000-8000-000000000001",
    });
    expect(result.success).toBe(false);
    const message = result.success ? "" : result.error.issues.map((issue) => issue.message).join(" ");
    // the required direction is THEY_OWE, so the message must name its word …
    expect(message).toContain(i18n.t("supplierAdjustDirectionTheyOwe"));
    // … and must not name the word for the value it refuses
    expect(message).not.toContain(i18n.t("supplierAdjustDirectionWeOwe"));
  });
});
