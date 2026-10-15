import { describe, expect, it } from "bun:test";

import type { Item } from "@dokan/contracts";

import {
  EMPTY_PAYMENT_PAIR,
  addDraftLine,
  discountAmountFor,
  draftReducer,
  draftSubtotal,
  draftTotals,
  firstCommitError,
  firstLineError,
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
  type CommitChecks,
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

  it("accepts Arabic-Indic and Extended Arabic-Indic digits (#198 decision)", () => {
    // the owner's Arabic keyboard may produce these; the amount fields already
    // accept them, so the quantity reader shares the same normalizer
    expect(parseQuantityDraft("٥")).toBe(5);
    expect(parseQuantityDraft("٤٢")).toBe(42);
    expect(parseQuantityDraft(" ٥ ")).toBe(5);
    expect(parseQuantityDraft("۵")).toBe(5);
    expect(parseQuantityDraft("۵۰")).toBe(50);
    expect(quantityDraftInvalid("٥")).toBe(false);
    // still digits-only: a grouping separator or a decimal stays invalid
    expect(parseQuantityDraft("١٬٠٠٠")).toBe(0);
    expect(parseQuantityDraft("٥.٥")).toBe(0);
    // mixed scripts normalize like the amount reader does
    expect(parseQuantityDraft("٥5")).toBe(55);
    // the cap applies after normalization
    expect(parseQuantityDraft("١٠٠٠٠٠٠")).toBe(1_000_000);
    expect(parseQuantityDraft("١٠٠٠٠٠١")).toBe(0);
    // and the widened reader bills the line: 5 × 900
    expect(draftSubtotal([saleLine("a", "٥", 900)], saleUnitPrice)).toBe(4500);
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
      ["٥", 5],
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
    // Number("   ") === 0, so a whitespace-only field is the same explicit zero
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
  });

  it("preserves the pre-#146 readable values so no money input changes what it bills", () => {
    // The page used `Number(event.target.value)` with an integer >= 0 guard.
    // #146 moved that reader behind `nextUnitCost` so the page holds no number
    // parsing. It deliberately does NOT tighten the reader, because the brief
    // requires the money path to be unchanged.
    expect(nextUnitCost("1e3", 1200)).toBe(1000);
    expect(nextUnitCost("0x10", 1200)).toBe(16);
    expect(nextUnitCost(" 42 ", 1200)).toBe(42);
  });

  it("documents the inherited reader's precision quirk rather than endorsing it", () => {
    // `Number` also accepts values that cannot be held exactly. The extraction
    // must not change what this field bills, so the quirk stays for now. A
    // stricter reader is a recorded follow-up, not an intended contract.
    expect(nextUnitCost("9007199254740993", 1200)).toBe(9_007_199_254_740_992);
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
    // a rounding case rounds to whole DZD: 101 x 50% = 50.5
    expect(saleUnitPrice({ ...saleLine("a", "1", 101), overrideType: "PERCENTAGE", overrideValue: "50" })).toBe(51);
    // the preview does not clamp a percentage override; submit refuses it
    expect(saleUnitPrice({ ...saleLine("a", "1", 1000), overrideType: "PERCENTAGE", overrideValue: "150" })).toBe(1500);
    expect(saleOverrideInvalid({ overrideType: "PERCENTAGE", overrideValue: "150" })).toBe(true);
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
    expect(saleOverrideInvalid({ overrideType: "PERCENTAGE", overrideValue: "100" })).toBe(false);
    expect(saleOverrideInvalid({ overrideType: "PERCENTAGE", overrideValue: "0" })).toBe(false);
    expect(saleOverrideInvalid({ overrideType: "PERCENTAGE", overrideValue: "101" })).toBe(true);
    expect(saleOverrideInvalid({ overrideType: "PERCENTAGE", overrideValue: "-1" })).toBe(true);
    expect(saleOverrideInvalid({ overrideType: "PERCENTAGE", overrideValue: "12.5" })).toBe(true);
  });

  it("keeps the override reader ASCII-only while the quantity reader accepts Arabic-Indic (#198 scope)", () => {
    // the #198 decision widened quantities only. `Number("٥")` is NaN, so the
    // price-override reader still refuses it, exactly as before.
    expect(saleOverrideInvalid({ overrideType: "AMOUNT", overrideValue: "٥" })).toBe(true);
    expect(saleOverrideInvalid({ overrideType: "PERCENTAGE", overrideValue: "٥٠" })).toBe(true);
    // the same digit in a quantity now resolves
    expect(parseQuantityDraft("٥")).toBe(5);
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

  it("clamps a repeat add at the cap instead of zeroing a maxed line", () => {
    // a line already at MAX_DRAFT_QUANTITY must stay valid when the same item is
    // scanned again; an unbumped "1000001" would resolve to 0 and block the save
    const sale = addDraftLine([saleLine("a", "1000000")], saleLine("a"));
    expect(lineQuantity(sale[0]!)).toBe(1_000_000);
    const purchase = addDraftLine([purchaseLine("a", "1000000")], purchaseLine("a"));
    expect(lineQuantity(purchase[0]!)).toBe(1_000_000);
  });

  it("repairs an over-cap or unreadable draft to one unit on an explicit add", () => {
    // an out-of-range draft resolves to 0, so the merge bumps it to 1 rather
    // than to a still-unusable 1000001
    expect(addDraftLine([saleLine("a", "1000001")], saleLine("a"))[0]!.quantityDraft).toBe("1");
    expect(addDraftLine([saleLine("a", "abc")], saleLine("a"))[0]!.quantityDraft).toBe("1");
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

  it("reports the first line error in draft order", () => {
    const qty = (line: SaleDraftLine) => (quantityDraftInvalid(line.quantityDraft) ? "qty" : null);
    expect(firstLineError([saleLine("a", "2"), saleLine("b", "3")], qty)).toBeNull();
    expect(firstLineError([saleLine("a", ""), saleLine("b", "3")], qty)).toBe("qty");
    expect(firstLineError([saleLine("a", "2"), saleLine("b", "abc")], qty)).toBe("qty");
    expect(firstLineError([], qty)).toBeNull();
    // the FIRST offender wins when more than one line is unusable
    expect(firstLineError([saleLine("a", ""), saleLine("b", "abc")], qty)).toBe("qty");
  });

  it("checks one line's kind-specific errors before the next line's", () => {
    // sale checks override then quantity for a line before moving on. A pass
    // that checked every override first would surface the later line's override
    // instead of the earlier line's quantity.
    const errorFor = (line: SaleDraftLine) => {
      if (saleOverrideInvalid(line)) return "override";
      if (quantityDraftInvalid(line.quantityDraft)) return "quantity";
      return null;
    };
    const first = { ...saleLine("a", ""), overrideType: "AMOUNT" as const, overrideValue: "900" };
    const second = { ...saleLine("b", "2"), overrideType: "AMOUNT" as const, overrideValue: "" };
    expect(firstLineError([first, second], errorFor)).toBe("quantity");
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

describe("firstCommitError (the one commit order both screens share)", () => {
  const pass = () => ({ invalid: () => false, message: "" });
  const fail = (message: string) => ({ invalid: () => true, message });
  const valid = { invalid: false, message: "" };
  const invalid = (message: string) => ({ invalid: true, message });

  const checks = (over: Partial<CommitChecks<SaleDraftLine>> = {}) => ({
    lines: [saleLine("a", "2")],
    linesEmpty: "empty",
    partyNeedsChoice: false,
    partyNeedsChoiceMessage: "party",
    override: pass(),
    quantity: pass(),
    discount: valid,
    payment: valid,
    ...over,
  });

  it("returns null when every check passes", () => {
    expect(firstCommitError(checks())).toBeNull();
  });

  it("blames the empty cart first, whatever else is wrong", () => {
    expect(
      firstCommitError(
        checks({
          lines: [],
          partyNeedsChoice: true,
          override: fail("override"),
          quantity: fail("quantity"),
          discount: invalid("discount"),
          payment: invalid("payment"),
        }),
      ),
    ).toBe("empty");
  });

  it("blames the unpicked party before the lines", () => {
    expect(firstCommitError(checks({ partyNeedsChoice: true, override: fail("override"), quantity: fail("quantity") }))).toBe("party");
  });

  it("blames a line before the discount and the payment derived from it", () => {
    expect(firstCommitError(checks({ quantity: fail("quantity"), discount: invalid("discount"), payment: invalid("payment") }))).toBe("quantity");
  });

  it("checks a line's override before its quantity, and the first offender first", () => {
    expect(firstCommitError(checks({ override: fail("override"), quantity: fail("quantity") }))).toBe("override");
    // line 1's override beats line 2's quantity (draft order, one line at a time)
    const twoLines = [saleLine("a", "1"), saleLine("b", "")];
    expect(
      firstCommitError(
        checks({
          lines: twoLines,
          override: { invalid: (line) => line.item.id === "a", message: "override" },
          quantity: { invalid: (line) => line.quantityDraft.trim() === "", message: "quantity" },
        }),
      ),
    ).toBe("override");
    // make line 1 valid: the second line's quantity is next
    expect(
      firstCommitError(
        checks({
          lines: twoLines,
          override: { invalid: () => false, message: "override" },
          quantity: { invalid: (line) => line.quantityDraft.trim() === "", message: "quantity" },
        }),
      ),
    ).toBe("quantity");
  });

  it("blames the discount before the payment it can zero", () => {
    expect(firstCommitError(checks({ discount: invalid("discount"), payment: invalid("payment") }))).toBe("discount");
  });

  it("blames the payment last, only when everything it derives from is valid", () => {
    expect(firstCommitError(checks({ payment: invalid("payment") }))).toBe("payment");
  });

  it("shares the order with a purchase-shaped input (no override, no discount)", () => {
    const purchase = {
      lines: [purchaseLine("a", "")],
      linesEmpty: "empty",
      partyNeedsChoice: false,
      partyNeedsChoiceMessage: "party",
      quantity: fail("quantity"),
      payment: invalid("payment"),
    };
    expect(firstCommitError(purchase)).toBe("quantity");
    expect(firstCommitError({ ...purchase, lines: [purchaseLine("a", "2")], quantity: pass() })).toBe("payment");
    expect(firstCommitError({ ...purchase, lines: [purchaseLine("a", "2")], quantity: pass(), payment: valid })).toBeNull();
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
    expect(discountAmountFor(1000, "PERCENTAGE", "0")).toBe(0);
    // a zero subtotal stays zero under either kind
    expect(discountAmountFor(0, "AMOUNT", "500")).toBe(0);
    expect(discountAmountFor(0, "PERCENTAGE", "50")).toBe(0);
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

  it("pins the deferred amount-source case: a zeroed total leaves the amount unsaveable", () => {
    // An amount the owner typed is kept when the reference disappears, because
    // the transition cannot tell an empty cart from a discount-zeroed total.
    // The over-total check then refuses it until the owner clears it. This is
    // pre-existing behaviour, recorded as a follow-up in the design doc.
    const typed = pair({ amount: "500", percentage: "50", source: "amount" });
    const next = nextPaymentPair(0, typed);
    expect(next).toEqual(typed);
    expect(resolveInitialPaid(0, next.amount, next.percentage)).toEqual({ ok: false });
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
  it("treats an empty or zero draft as nothing paid now (the whole total becomes debt)", () => {
    expect(resolveInitialPaid(1000, "", "")).toEqual({ ok: true, paid: undefined });
    expect(resolveInitialPaid(1000, "0", "0")).toEqual({ ok: true, paid: undefined });
  });

  it("carries a partial payment and a full one", () => {
    expect(resolveInitialPaid(1000, "400", "40")).toEqual({ ok: true, paid: 400 });
    expect(resolveInitialPaid(1000, "1000", "100")).toEqual({ ok: true, paid: 1000 });
  });

  it("reads a grouped amount with the shared parser (#180)", () => {
    expect(resolveInitialPaid(2000, "1 000", "50")).toEqual({ ok: true, paid: 1000 });
    expect(resolveInitialPaid(1000, "1,000", "100")).toEqual({ ok: true, paid: 1000 });
  });

  it("treats a whitespace draft as nothing paid now", () => {
    expect(resolveInitialPaid(1000, "   ", "  ")).toEqual({ ok: true, paid: undefined });
    expect(resolveInitialPaid(2000, " 1 000 ", "50")).toEqual({ ok: true, paid: 1000 });
  });

  it("pins the amount and percentage readers' digit asymmetry (pre-existing)", () => {
    // the amount reader accepts Arabic-Indic digits; the percentage reader is
    // ASCII-only. Unchanged by #146, but the pair is shared now.
    expect(resolveInitialPaid(1000, "٤٠٠", "")).toEqual({ ok: true, paid: 400 });
    expect(resolveInitialPaid(1000, "٤٠٠", "٤٠")).toEqual({ ok: false });
  });

  it("refuses an over-total payment instead of letting the api reject it", () => {
    expect(resolveInitialPaid(1000, "1500", "100")).toEqual({ ok: false });
  });

  it("refuses an invalid percentage, an unreadable amount, and a malformed grouping", () => {
    expect(resolveInitialPaid(1000, "500", "12.5")).toEqual({ ok: false });
    expect(resolveInitialPaid(1000, "-5", "")).toEqual({ ok: false });
    expect(resolveInitialPaid(1000, "abc", "")).toEqual({ ok: false });
    expect(resolveInitialPaid(1000, "1 000,00", "")).toEqual({ ok: false });
    expect(resolveInitialPaid(1000, "1,5", "")).toEqual({ ok: false });
  });
});
