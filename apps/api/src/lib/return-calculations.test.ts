import { describe, expect, it } from "bun:test";

import {
  bookSaleLineForReturns,
  computeReturnRefund,
  derivedRefundSplit,
  explicitRefundSplit,
  lineRefundAmount,
  refundUnitPriceFor,
  remainingReturnable,
  returnCapViolation,
  returnSettlementDefault,
  sortInvoicesOldestFirst,
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

  it("consolidates split entries of one line before pricing (dedupe-first)", () => {
    // a 101-DZD line over 3 units split as [qty 2, qty 1]: pricing each entry
    // independently would round twice (34 + 34 = 102); the consolidated sum
    // is a FULL return and refunds the exact 101
    const result = computeReturnRefund([
      { invoiceLineId: "l1", quantity: 2, lineQuantity: 3, netTotal: 101 },
      { invoiceLineId: "l1", quantity: 1, lineQuantity: 3, netTotal: 101 },
    ]);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ invoiceLineId: "l1", quantity: 3, refundUnitPrice: 34, refundAmount: 101 });
    expect(result.refundTotal).toBe(101);
  });

  it("consolidates split entries of a PARTIAL return too", () => {
    // [qty 1, qty 1] of a 3-unit line: the untouched unit stays, the partial
    // prices once at the rounded unit
    const result = computeReturnRefund([
      { invoiceLineId: "l1", quantity: 1, lineQuantity: 3, netTotal: 101 },
      { invoiceLineId: "l1", quantity: 1, lineQuantity: 3, netTotal: 101 },
    ]);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ quantity: 2, refundUnitPrice: 34, refundAmount: 68 });
    expect(result.refundTotal).toBe(68);
  });

  it("is SEQUENCE-AWARE: qty 1 then qty 2 on a non-even line settles 101 exactly (rounding only at the last partial)", () => {
    const first = computeReturnRefund([{ invoiceLineId: "l1", quantity: 1, lineQuantity: 3, netTotal: 101 }], new Map());
    expect(first.lines[0]).toMatchObject({ quantity: 1, refundAmount: 34 });
    const second = computeReturnRefund(
      [{ invoiceLineId: "l1", quantity: 2, lineQuantity: 3, netTotal: 101 }],
      new Map([["l1", { quantity: 1, refundAmount: 34 }]]),
    );
    expect(second.lines[0]).toMatchObject({ quantity: 2, refundAmount: 67 });
    expect(first.refundTotal + second.refundTotal).toBe(101);
  });

  it("settles the EXACT remainder when the last partial completes the line", () => {
    // 5 units, net 101, unit 20: partials 1 + 1 (20 + 20), then the completing 3
    const partial = computeReturnRefund([{ invoiceLineId: "l1", quantity: 1, lineQuantity: 5, netTotal: 101 }], new Map());
    expect(partial.refundTotal).toBe(20);
    const again = computeReturnRefund(
      [{ invoiceLineId: "l1", quantity: 1, lineQuantity: 5, netTotal: 101 }],
      new Map([["l1", { quantity: 1, refundAmount: 20 }]]),
    );
    expect(again.refundTotal).toBe(20);
    const last = computeReturnRefund(
      [{ invoiceLineId: "l1", quantity: 3, lineQuantity: 5, netTotal: 101 }],
      new Map([["l1", { quantity: 2, refundAmount: 40 }]]),
    );
    // the remainder, not 3 × 20 = 60
    expect(last.lines[0]).toMatchObject({ quantity: 3, refundAmount: 61 });
    expect(partial.refundTotal + again.refundTotal + last.refundTotal).toBe(101);
  });

  it("many partials of 1 on a non-even line never over-refund cumulatively before completion", () => {
    let prior = new Map<string, { quantity: number; refundAmount: number }>();
    let cumulative = 0;
    for (const returned of [1, 1, 1, 1, 1, 1]) {
      const step = computeReturnRefund([{ invoiceLineId: "l1", quantity: returned, lineQuantity: 6, netTotal: 101 }], prior);
      const amount = step.refundTotal;
      cumulative += amount;
      expect(cumulative).toBeLessThanOrEqual(101);
      prior = new Map([["l1", { quantity: (prior.get("l1")?.quantity ?? 0) + returned, refundAmount: cumulative }]]);
    }
    const last = computeReturnRefund([{ invoiceLineId: "l1", quantity: 1, lineQuantity: 6, netTotal: 101 }], prior);
    expect(cumulative + last.refundTotal).toBe(101);
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
describe("bookSaleLineForReturns (profit report per-line booking)", () => {
  const line = { quantity: 3, netTotal: 900, cogsExact: 300 };

  it("passes a no-return line through exactly", () => {
    const booked = bookSaleLineForReturns(line, { heldQty: 0, rejectedQty: 0, rejectedScrapQty: 0 });
    expect(booked).toEqual({ bookedQty: 3, netTotal: 900, cogsExact: 300 });
  });

  it("excludes a fully-held (pending/accepted) return entirely", () => {
    const booked = bookSaleLineForReturns(line, { heldQty: 3, rejectedQty: 0, rejectedScrapQty: 0 });
    expect(booked).toEqual({ bookedQty: 0, netTotal: 0, cogsExact: 0 });
  });

  it("keeps a fully-rejected (no resale) return fully booked — scrapped = real cost", () => {
    // freebie-reject convention: the whole line was returned and the reject
    // scraped everything still on hand
    const booked = bookSaleLineForReturns({ quantity: 1, netTotal: 0, cogsExact: 200 }, { heldQty: 0, rejectedQty: 1, rejectedScrapQty: 1 });
    expect(booked).toEqual({ bookedQty: 1, netTotal: 0, cogsExact: 200 });
  });

  it("un-books only the RESOLD units of a rejected return; the scrapped-now portion stays", () => {
    // return 3, resell 2, reject scraps the 1 still on hand: the original line
    // books 1 unit, the resale books the 2 — nothing double-booked
    const booked = bookSaleLineForReturns(line, { heldQty: 0, rejectedQty: 3, rejectedScrapQty: 1 });
    expect(booked.bookedQty).toBe(1);
    expect(booked).toEqual({ bookedQty: 1, netTotal: 300, cogsExact: 100 });
  });

  it("scales with one whole-DZD rounding when the booked share is partial", () => {
    // 5 units, netTotal 1000, cogsExact 700; reject scraps 3 of 5 → 2 resold,
    // so 3 units stay booked in the original line
    const booked = bookSaleLineForReturns({ quantity: 5, netTotal: 1_000, cogsExact: 700 }, { heldQty: 0, rejectedQty: 5, rejectedScrapQty: 3 });
    expect(booked.bookedQty).toBe(3);
    expect(booked.netTotal).toBe(600);
    expect(booked.cogsExact).toBe(420);
  });
});

/**
 * #256 round 2 — the APPROVED refund-method default. The owner answered both
 * open questions (`.scratch/notes/decisions-money-ar.html`):
 *
 * 1. a return LARGER than the debt is a SPLIT — the whole tab goes to zero and
 *    the remainder comes back as cash ("we take it from the debt and we will
 *    give him back 1,000 as cash");
 * 2. debt on ANOTHER invoice is no longer a refusal — the return is taken off
 *    the party's tab, allocated across the open invoices oldest-first.
 *
 * Cash is the default only when the party owes nothing at all.
 */
describe("returnSettlementDefault (#256 round 2)", () => {
  it("defaults to cash when the party has no debt anywhere", () => {
    expect(returnSettlementDefault({ returnValue: 500, invoiceDebt: 0, partyDebt: 0 })).toEqual({ method: "CASH" });
  });

  it("defaults to debt when the debt covers the whole return", () => {
    expect(returnSettlementDefault({ returnValue: 500, invoiceDebt: 500, partyDebt: 500 })).toEqual({ method: "DEBT" });
    expect(returnSettlementDefault({ returnValue: 500, invoiceDebt: 2_000, partyDebt: 5_000 })).toEqual({ method: "DEBT" });
  });

  it("defaults to debt when the party's tab covers a return this invoice cannot", () => {
    // answer 2: the debt lives on another invoice — still all debt, no cash
    expect(returnSettlementDefault({ returnValue: 500, invoiceDebt: 0, partyDebt: 1_000 })).toEqual({ method: "DEBT" });
    expect(returnSettlementDefault({ returnValue: 1_000, invoiceDebt: 0, partyDebt: 1_000 })).toEqual({ method: "DEBT" });
  });

  it("splits when the return exceeds the whole tab — debt to zero, remainder cash", () => {
    // answer 1, the owner's own numbers: debt 4 000, return 5 000 →
    // debt 4 000 relieved + 1 000 cash
    expect(returnSettlementDefault({ returnValue: 5_000, invoiceDebt: 4_000, partyDebt: 4_000 })).toEqual({
      method: "SPLIT",
      debtOffset: 4_000,
      cashPaidOut: 1_000,
    });
    // the same split when the tab is spread over several invoices
    expect(returnSettlementDefault({ returnValue: 5_000, invoiceDebt: 1_000, partyDebt: 4_000 })).toEqual({
      method: "SPLIT",
      debtOffset: 4_000,
      cashPaidOut: 1_000,
    });
  });

  it("stays unresolved while the party debt read has not landed", () => {
    expect(returnSettlementDefault({ returnValue: 500, invoiceDebt: 0, partyDebt: null })).toEqual({ method: "UNRESOLVED" });
    // …unless this invoice's own debt already answers it
    expect(returnSettlementDefault({ returnValue: 500, invoiceDebt: 500, partyDebt: null })).toEqual({ method: "DEBT" });
  });

  it("never blocks a free (zero-value) return — there is no split to guess", () => {
    // a fully-discounted line refunds 0: the method is moot, so the default
    // must not block the record (the api writes 0/0 either way)
    expect(returnSettlementDefault({ returnValue: 0, invoiceDebt: 0, partyDebt: 0 })).toEqual({ method: "DEBT" });
    expect(returnSettlementDefault({ returnValue: 0, invoiceDebt: 0, partyDebt: 400 })).toEqual({ method: "DEBT" });
  });
});

/**
 * The two money numbers every caller writes: the derived default's split and
 * the owner's explicit choice. ONE implementation each, so the api's write and
 * the web's preview cannot drift (the round-1 preview restated the explicit
 * formula by hand).
 */
describe("refund split arithmetic (#256)", () => {
  it("turns each derived method into the numbers the record stores", () => {
    expect(derivedRefundSplit({ method: "DEBT" }, 500)).toEqual({ debtOffset: 500, cashPaidOut: 0 });
    expect(derivedRefundSplit({ method: "CASH" }, 500)).toEqual({ debtOffset: 0, cashPaidOut: 500 });
    expect(derivedRefundSplit({ method: "SPLIT", debtOffset: 4_000, cashPaidOut: 1_000 }, 5_000)).toEqual({
      debtOffset: 4_000,
      cashPaidOut: 1_000,
    });
    // the party read has not landed: the web previews nothing, the api never
    // reaches this state (its debt read is synchronous)
    expect(derivedRefundSplit({ method: "UNRESOLVED" }, 500)).toBeNull();
  });

  it("caps an explicit all-debt request at this invoice's debt (#162)", () => {
    // 500 return, 200 cash asked, 900 debt → 300 to the debt, 200 cash
    expect(explicitRefundSplit({ returnValue: 500, cashPaidOut: 200, invoiceDebt: 900 })).toEqual({ debtOffset: 300, cashPaidOut: 200 });
    // all debt beyond the remaining swings back to cash, visibly (the cap note)
    expect(explicitRefundSplit({ returnValue: 500, cashPaidOut: 0, invoiceDebt: 300 })).toEqual({ debtOffset: 300, cashPaidOut: 200 });
    // no debt here at all → the whole explicit "all debt" is cash
    expect(explicitRefundSplit({ returnValue: 500, cashPaidOut: 0, invoiceDebt: 0 })).toEqual({ debtOffset: 0, cashPaidOut: 500 });
    // a full cash request never touches the debt
    expect(explicitRefundSplit({ returnValue: 500, cashPaidOut: 500, invoiceDebt: 900 })).toEqual({ debtOffset: 0, cashPaidOut: 500 });
  });
});

/**
 * The allocation order the payment panel already uses (#164): oldest first,
 * with the invoice number's numeric sequence as the tie-break — createdAt has
 * second precision, so two invoices in the same second would otherwise sort by
 * a random UUID and spread the money differently on different runs.
 */
describe("sortInvoicesOldestFirst (#164/#256)", () => {
  const invoice = (over: Partial<{ id: string; invoiceDate: string; createdAt: string; invoiceNumber: string; remainingAmount: number }>) => ({
    id: "id",
    invoiceDate: "2026-10-01",
    createdAt: "2026-10-01T10:00:00",
    invoiceNumber: "INV-0001",
    remainingAmount: 100,
    ...over,
  });

  it("orders by date, then creation, then the number's numeric sequence", () => {
    const older = invoice({ id: "a", invoiceDate: "2026-09-30", invoiceNumber: "INV-0009" });
    const sameSecondNine = invoice({ id: "b", invoiceNumber: "INV-0009" });
    const sameSecondTen = invoice({ id: "c", invoiceNumber: "INV-0010" });
    const expected = [older, sameSecondNine, sameSecondTen].map((row) => row.id);
    expect(sortInvoicesOldestFirst([sameSecondTen, sameSecondNine, older]).map((row) => row.id)).toEqual(expected);
    // a lexical compare would put INV-0010 before INV-0009
    expect(sortInvoicesOldestFirst([sameSecondTen, sameSecondNine]).map((row) => row.id)).toEqual(["b", "c"]);
  });

  it("does not mutate the array it was handed", () => {
    const newest = invoice({ id: "new", invoiceDate: "2026-10-02" });
    const oldest = invoice({ id: "old", invoiceDate: "2026-09-01" });
    const input = [newest, oldest];
    expect(sortInvoicesOldestFirst(input).map((row) => row.id)).toEqual(["old", "new"]);
    expect(input.map((row) => row.id)).toEqual(["new", "old"]);
  });
});
