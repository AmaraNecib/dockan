import { describe, expect, it } from "bun:test";

import type { Item } from "@dokan/contracts";

import {
  EMPTY_PAYMENT_PAIR,
  addDraftLine,
  discountAmountFor,
  draftReducer,
  draftSubtotal,
  draftTotals,
  lineQuantity,
  nextPaymentPair,
  nextUnitCost,
  parseQuantityDraft,
  paymentPairUnchanged,
  purchaseUnitPrice,
  quantityDraftInvalid,
  removeDraftLine,
  resolveInitialPaid,
  saleOverrideInvalid,
  saleUnitPrice,
  setDraftQuantity,
  toAmountKind,
  type PaymentPair,
  type PurchaseDraftLine,
  type SaleDraftLine,
} from "./invoice-draft";

function item(id: string, sellingPrice = 1000, costPrice = 400): Item {
  return {
    id,
    name: `منتج ${id}`,
    barcode: null,
    categoryId: "cat-1",
    costPrice,
    sellingPrice,
    lowStockThreshold: 0,
    stockOnHand: 0,
    createdAt: "2026-10-01T10:00:00",
    updatedAt: "2026-10-01T10:00:00",
  };
}

function saleLine(id: string, quantityDraft = "1", sellingPrice = 1000): SaleDraftLine {
  return { item: item(id, sellingPrice), quantityDraft, overrideType: "", overrideValue: "" };
}

function purchaseLine(id: string, quantityDraft = "1", unitCost = 400): PurchaseDraftLine {
  return { item: item(id, 1000, unitCost), quantityDraft, unitCost };
}

describe("parseQuantityDraft (the one quantity parser both screens use)", () => {
  it("parses a cleared or whitespace draft to 0 (invalid, never stuck)", () => {
    expect(parseQuantityDraft("")).toBe(0);
    expect(parseQuantityDraft("   ")).toBe(0);
    expect(quantityDraftInvalid("")).toBe(true);
  });

  it("parses positive integers and rejects zero, negatives, fractions, and garbage", () => {
    expect(parseQuantityDraft("1")).toBe(1);
    expect(parseQuantityDraft("12")).toBe(12);
    expect(parseQuantityDraft(" 7 ")).toBe(7);
    expect(parseQuantityDraft("0")).toBe(0);
    expect(parseQuantityDraft("-3")).toBe(0);
    expect(parseQuantityDraft("2.5")).toBe(0);
    expect(parseQuantityDraft("abc")).toBe(0);
    expect(parseQuantityDraft("12x")).toBe(0);
    expect(quantityDraftInvalid("0")).toBe(true);
    expect(quantityDraftInvalid("2.5")).toBe(true);
  });

  it("accepts a whole multi-digit value and trims surrounding spaces", () => {
    expect(quantityDraftInvalid("42")).toBe(false);
    expect(parseQuantityDraft("0042")).toBe(42);
  });

  it("rejects drafts above the RPC quantity cap instead of surfacing a server error", () => {
    expect(parseQuantityDraft("9999999999")).toBe(0);
    expect(parseQuantityDraft("1000001")).toBe(0);
    expect(parseQuantityDraft("1000000")).toBe(1_000_000);
    expect(quantityDraftInvalid("9999999999")).toBe(true);
  });

  it("is deterministic and pins each input's exact resolution (no self-equality)", () => {
    const cases: Array<[string, number]> = [
      ["", 0],
      ["0", 0],
      ["1", 1],
      ["999", 999],
      ["-1", 0],
      ["1e3", 0],
      ["1.5", 0],
      ["٥", 0],
      ["1_000", 0],
      ["1000000", 1_000_000],
      ["1000001", 0],
    ];
    for (const [input, expected] of cases) {
      expect(parseQuantityDraft(input)).toBe(expected);
    }
  });

  it("resolves a line's effective quantity through the same parser", () => {
    expect(lineQuantity(saleLine("a", "3"))).toBe(3);
    expect(lineQuantity(purchaseLine("a", ""))).toBe(0);
  });
});

describe("nextUnitCost (the purchase line's controlled money field)", () => {
  it("treats a cleared field as an explicit zero, matching the previous contract", () => {
    expect(nextUnitCost("", 1200)).toBe(0);
    expect(nextUnitCost("   ", 1200)).toBe(0);
  });

  it("reads whole non-negative values, including an explicit zero", () => {
    expect(nextUnitCost("900", 1200)).toBe(900);
    expect(nextUnitCost("0", 1200)).toBe(0);
    expect(nextUnitCost(" 42 ", 1200)).toBe(42);
  });

  it("keeps the previous value for an unreadable draft instead of billing zero", () => {
    expect(nextUnitCost("abc", 1200)).toBe(1200);
    expect(nextUnitCost("-5", 1200)).toBe(1200);
    expect(nextUnitCost("1.5", 1200)).toBe(1200);
    expect(nextUnitCost("1e3", 1200)).toBe(1200);
  });
});

describe("sale line pricing", () => {
  it("bills the item's selling price when no override is chosen", () => {
    expect(saleUnitPrice(saleLine("a", "1", 1000))).toBe(1000);
    // a stale override value is ignored while no type is chosen
    expect(saleUnitPrice({ ...saleLine("a"), overrideValue: "900" })).toBe(1000);
  });

  it("bills a whole amount override and a percentage of the default price", () => {
    expect(saleUnitPrice({ ...saleLine("a", "1", 1000), overrideType: "AMOUNT", overrideValue: "900" })).toBe(900);
    expect(saleUnitPrice({ ...saleLine("a", "1", 500), overrideType: "PERCENTAGE", overrideValue: "80" })).toBe(400);
    // 500 × 33% = 165 exactly; a rounding case rounds to whole DZD
    expect(saleUnitPrice({ ...saleLine("a", "1", 101), overrideType: "PERCENTAGE", overrideValue: "50" })).toBe(51);
  });

  it("rejects an empty override value once a type is chosen (Number('') === 0 would bill the line free)", () => {
    expect(saleOverrideInvalid({ overrideType: "", overrideValue: "" })).toBe(false);
    expect(saleOverrideInvalid({ overrideType: "", overrideValue: "900" })).toBe(false);
    expect(saleOverrideInvalid({ overrideType: "AMOUNT", overrideValue: "" })).toBe(true);
    expect(saleOverrideInvalid({ overrideType: "AMOUNT", overrideValue: "   " })).toBe(true);
    expect(saleOverrideInvalid({ overrideType: "PERCENTAGE", overrideValue: "" })).toBe(true);
  });

  it("accepts whole nonnegative amounts and binds percentages to 0-100", () => {
    expect(saleOverrideInvalid({ overrideType: "AMOUNT", overrideValue: "900" })).toBe(false);
    expect(saleOverrideInvalid({ overrideType: "AMOUNT", overrideValue: "0" })).toBe(false);
    expect(saleOverrideInvalid({ overrideType: "AMOUNT", overrideValue: "12.5" })).toBe(true);
    expect(saleOverrideInvalid({ overrideType: "AMOUNT", overrideValue: "-5" })).toBe(true);
    expect(saleOverrideInvalid({ overrideType: "AMOUNT", overrideValue: "abc" })).toBe(true);
    expect(saleOverrideInvalid({ overrideType: "PERCENTAGE", overrideValue: "80" })).toBe(false);
    expect(saleOverrideInvalid({ overrideType: "PERCENTAGE", overrideValue: "0" })).toBe(false);
    expect(saleOverrideInvalid({ overrideType: "PERCENTAGE", overrideValue: "101" })).toBe(true);
    expect(saleOverrideInvalid({ overrideType: "PERCENTAGE", overrideValue: "-1" })).toBe(true);
    expect(saleOverrideInvalid({ overrideType: "PERCENTAGE", overrideValue: "12.5" })).toBe(true);
  });
});

describe("draft line list", () => {
  it("appends a fresh item and merges a repeat pick into its existing line", () => {
    const one = addDraftLine([], saleLine("a"));
    expect(one).toHaveLength(1);

    const merged = addDraftLine(one, saleLine("a"));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.quantityDraft).toBe("2");

    const both = addDraftLine(merged, saleLine("b"));
    expect(both.map((line) => line.item.id)).toEqual(["a", "b"]);
  });

  it("repairs a cleared draft to a single unit on an explicit add (scan/picker)", () => {
    const cleared = setDraftQuantity([saleLine("a", "3")], "a", "");
    expect(cleared[0]!.quantityDraft).toBe("");

    const repaired = addDraftLine(cleared, saleLine("a"));
    expect(repaired[0]!.quantityDraft).toBe("1");
  });

  it("merges a repeat purchase pick the same way", () => {
    const merged = addDraftLine([purchaseLine("a", "2")], purchaseLine("a"));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.quantityDraft).toBe("3");
  });

  it("sets a line's raw draft without rewriting it", () => {
    const lines = setDraftQuantity([saleLine("a"), saleLine("b")], "b", "abc");
    expect(lines[0]!.quantityDraft).toBe("1");
    expect(lines[1]!.quantityDraft).toBe("abc");
    // an unknown id is a no-op, not a crash
    expect(setDraftQuantity(lines, "missing", "9")).toEqual(lines);
  });

  it("removes a line by id", () => {
    const lines = removeDraftLine([saleLine("a"), saleLine("b")], "a");
    expect(lines.map((line) => line.item.id)).toEqual(["b"]);
    expect(removeDraftLine(lines, "missing")).toEqual(lines);
  });

  it("applies every reducer action in order (the React surface)", () => {
    let lines: SaleDraftLine[] = [];
    lines = draftReducer(lines, { type: "add", line: saleLine("a") });
    lines = draftReducer(lines, { type: "add", line: saleLine("a") });
    expect(lines[0]!.quantityDraft).toBe("2");

    lines = draftReducer(lines, { type: "quantity", itemId: "a", draft: "5" });
    expect(lines[0]!.quantityDraft).toBe("5");

    lines = draftReducer(lines, { type: "patch", itemId: "a", patch: { overrideType: "AMOUNT", overrideValue: "900" } });
    expect(lines[0]!.overrideType).toBe("AMOUNT");
    expect(lines[0]!.overrideValue).toBe("900");

    lines = draftReducer(lines, { type: "add", line: saleLine("b") });
    lines = draftReducer(lines, { type: "remove", itemId: "a" });
    expect(lines.map((line) => line.item.id)).toEqual(["b"]);

    expect(draftReducer(lines, { type: "reset" })).toEqual([]);
  });
});

describe("draft totals (money math pinned)", () => {
  it("sums each line's effective quantity times its unit price", () => {
    const sale = [saleLine("a", "3", 900), saleLine("b", "1", 500)];
    expect(draftSubtotal(sale, saleUnitPrice)).toBe(3200);

    const purchase = [purchaseLine("battery", "2", 1200), purchaseLine("filter", "3", 900)];
    expect(draftSubtotal(purchase, purchaseUnitPrice)).toBe(5100);
  });

  it("treats an unusable draft as a zero line without dropping it", () => {
    const lines = [purchaseLine("a", "2", 1200), purchaseLine("b", "", 900)];
    expect(draftSubtotal(lines, purchaseUnitPrice)).toBe(2400);
    expect(lines).toHaveLength(2);
  });

  it("caps an amount discount at the subtotal and rounds a percentage one", () => {
    expect(discountAmountFor(2700, "AMOUNT", "100")).toBe(100);
    expect(discountAmountFor(2700, "AMOUNT", "9999")).toBe(2700);
    expect(discountAmountFor(400, "PERCENTAGE", "10")).toBe(40);
    expect(discountAmountFor(333, "PERCENTAGE", "10")).toBe(33);
    expect(discountAmountFor(333, "PERCENTAGE", "150")).toBe(333);
    expect(discountAmountFor(1000, "", "50")).toBe(0);
  });

  it("pins the sale cases from the brief and the e2e spec", () => {
    // 3 × 900 (amount override) − amount discount 100
    const first = draftTotals(
      [{ ...saleLine("a", "3", 1000), overrideType: "AMOUNT", overrideValue: "900" }],
      saleUnitPrice,
      "AMOUNT",
      "100",
    );
    expect(first).toEqual({ subtotal: 2700, discountAmount: 100, total: 2600 });

    // 1 × 500 @ 80% override, − 10% invoice discount
    const second = draftTotals(
      [{ ...saleLine("a", "1", 500), overrideType: "PERCENTAGE", overrideValue: "80" }],
      saleUnitPrice,
      "PERCENTAGE",
      "10",
    );
    expect(second).toEqual({ subtotal: 400, discountAmount: 40, total: 360 });

    // a percentage discount that rounds still keeps total = subtotal − discount
    const third = draftTotals([saleLine("a", "1", 333)], saleUnitPrice, "PERCENTAGE", "10");
    expect(third).toEqual({ subtotal: 333, discountAmount: 33, total: 300 });
  });

  it("pins the purchase total: 2 × 1200 + 3 × 900 with no discount", () => {
    const totals = draftTotals(
      [purchaseLine("battery", "2", 1200), purchaseLine("filter", "3", 900)],
      purchaseUnitPrice,
      "",
      "",
    );
    expect(totals).toEqual({ subtotal: 5100, discountAmount: 0, total: 5100 });
  });

  it("zeroes a sale total on a 100% discount without going negative", () => {
    const totals = draftTotals([saleLine("a", "1", 1000)], saleUnitPrice, "PERCENTAGE", "100");
    expect(totals).toEqual({ subtotal: 1000, discountAmount: 1000, total: 0 });
  });
});

describe("toAmountKind", () => {
  it("accepts only the two real kinds and spells 'none' as an empty string", () => {
    expect(toAmountKind("AMOUNT")).toBe("AMOUNT");
    expect(toAmountKind("PERCENTAGE")).toBe("PERCENTAGE");
    expect(toAmountKind("")).toBe("");
    expect(toAmountKind("amount")).toBe("");
    expect(toAmountKind("junk")).toBe("");
  });
});

describe("nextPaymentPair (the shared #162 amount ⇄ percentage link)", () => {
  const pair = (over: Partial<PaymentPair>): PaymentPair => ({ ...EMPTY_PAYMENT_PAIR, ...over });

  it("follows the full total while untouched", () => {
    expect(nextPaymentPair(1000, EMPTY_PAYMENT_PAIR)).toEqual({ amount: "1000", percentage: "100", source: null });
    expect(nextPaymentPair(0, EMPTY_PAYMENT_PAIR)).toEqual(EMPTY_PAYMENT_PAIR);
  });

  it("rescales an edited percentage when the total changes", () => {
    const current = pair({ amount: "500", percentage: "50", source: "percentage" });
    expect(nextPaymentPair(2000, current)).toEqual({ amount: "1000", percentage: "50", source: "percentage" });
  });

  it("keeps an edited amount and re-derives the percentage", () => {
    const current = pair({ amount: "400", percentage: "40", source: "amount" });
    expect(nextPaymentPair(2000, current)).toEqual({ amount: "400", percentage: "20", source: "amount" });
  });

  it("keeps a typed amount that survives an invalid percentage draft", () => {
    const current = pair({ amount: "", percentage: "12.5", source: "percentage" });
    expect(nextPaymentPair(1000, current)).toEqual(current);
  });

  it("clears an unreadable amount's percentage", () => {
    const current = pair({ amount: "abc", percentage: "40", source: "amount" });
    expect(nextPaymentPair(1000, current)).toEqual({ amount: "abc", percentage: "", source: "amount" });
  });

  it("drops a percentage-based payment to zero when a discount zeroes the total", () => {
    const current = pair({ amount: "500", percentage: "50", source: "percentage" });
    expect(nextPaymentPair(0, current)).toEqual({ amount: "0", percentage: "50", source: "percentage" });
  });

  it("keeps an amount typed while the cart was still empty", () => {
    const current = pair({ amount: "500", percentage: "", source: "amount" });
    expect(nextPaymentPair(0, current)).toEqual(current);
    expect(nextPaymentPair(1000, current)).toEqual({ amount: "500", percentage: "50", source: "amount" });
  });

  it("is convergent: re-deriving from its own output changes nothing", () => {
    for (const total of [0, 250, 1000]) {
      for (const current of [
        EMPTY_PAYMENT_PAIR,
        pair({ amount: "500", percentage: "50", source: "percentage" }),
        pair({ amount: "400", percentage: "40", source: "amount" }),
        pair({ amount: "0", percentage: "0", source: "percentage" }),
      ]) {
        const next = nextPaymentPair(total, current);
        expect(nextPaymentPair(total, next)).toEqual(next);
        expect(paymentPairUnchanged(next, next)).toBe(true);
      }
    }
  });
});

describe("resolveInitialPaid (what the invoice carries)", () => {
  const pair = (over: Partial<PaymentPair>): PaymentPair => ({ ...EMPTY_PAYMENT_PAIR, ...over });

  it("treats an empty or zero draft as nothing paid now (the whole total becomes debt)", () => {
    expect(resolveInitialPaid(1000, EMPTY_PAYMENT_PAIR)).toEqual({ ok: true, paid: undefined });
    expect(resolveInitialPaid(1000, pair({ amount: "0", percentage: "0", source: "amount" }))).toEqual({ ok: true, paid: undefined });
  });

  it("carries a partial payment and a full one", () => {
    expect(resolveInitialPaid(1000, pair({ amount: "400", percentage: "40", source: "amount" }))).toEqual({ ok: true, paid: 400 });
    expect(resolveInitialPaid(1000, pair({ amount: "1000", percentage: "100", source: "amount" }))).toEqual({ ok: true, paid: 1000 });
  });

  it("reads a grouped amount with the shared parser (#180)", () => {
    expect(resolveInitialPaid(2000, pair({ amount: "1 000", percentage: "50", source: "amount" }))).toEqual({ ok: true, paid: 1000 });
    expect(resolveInitialPaid(1000, pair({ amount: "1,000", percentage: "100", source: "amount" }))).toEqual({ ok: true, paid: 1000 });
  });

  it("refuses an over-total payment instead of letting the api reject it", () => {
    expect(resolveInitialPaid(1000, pair({ amount: "1500", percentage: "100", source: "amount" }))).toEqual({ ok: false });
  });

  it("refuses an invalid percentage, an unreadable amount, and a malformed grouping", () => {
    expect(resolveInitialPaid(1000, pair({ amount: "500", percentage: "12.5", source: "percentage" }))).toEqual({ ok: false });
    expect(resolveInitialPaid(1000, pair({ amount: "-5", percentage: "", source: "amount" }))).toEqual({ ok: false });
    expect(resolveInitialPaid(1000, pair({ amount: "abc", percentage: "", source: "amount" }))).toEqual({ ok: false });
    expect(resolveInitialPaid(1000, pair({ amount: "1 000,00", percentage: "", source: "amount" }))).toEqual({ ok: false });
    expect(resolveInitialPaid(1000, pair({ amount: "1,5", percentage: "", source: "amount" }))).toEqual({ ok: false });
  });
});
