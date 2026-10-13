import { describe, expect, it } from "bun:test";

import { parseGroupedAmount, parseWholeAmount, parseWholePercentage } from "./amount-parse";

/**
 * #180 — the single grouped-amount parser. Both the bulk opening-balance rows
 * and the single-entry money fields (تسوية/adjust, settle/pay/refund, invoice
 * paid-now) read amounts through `parseGroupedAmount`, so the same tricky
 * string must mean the same number everywhere.
 */
describe("parseGroupedAmount", () => {
  it("accepts plain digits and valid thousands grouping", () => {
    expect(parseGroupedAmount("1000")).toBe(1000);
    expect(parseGroupedAmount("1,000")).toBe(1000);
    expect(parseGroupedAmount("25 000")).toBe(25000);
    expect(parseGroupedAmount("1 000 000")).toBe(1_000_000);
    expect(parseGroupedAmount("1,000,000")).toBe(1_000_000);
    expect(parseGroupedAmount("٢٥٬٠٠٠")).toBe(25000);
    expect(parseGroupedAmount("۱۲۳")).toBe(123);
  });

  it("rejects a decimal or a malformed separator instead of deleting it", () => {
    expect(parseGroupedAmount("")).toBeNull();
    expect(parseGroupedAmount("   ")).toBeNull();
    expect(parseGroupedAmount("abc")).toBeNull();
    expect(parseGroupedAmount("1.5")).toBeNull();
    // the reported 100x bug: a decimal tail must not be deleted into another number
    expect(parseGroupedAmount("1 000,00")).toBeNull();
    expect(parseGroupedAmount("1,5")).toBeNull();
    // malformed grouping (wrong group width, leading/trailing separator)
    expect(parseGroupedAmount("1 00")).toBeNull();
    expect(parseGroupedAmount("1,0000")).toBeNull();
    expect(parseGroupedAmount("1000,000")).toBeNull();
    expect(parseGroupedAmount(",1000")).toBeNull();
    expect(parseGroupedAmount("1,00,0")).toBeNull();
    expect(parseGroupedAmount("1٬00")).toBeNull();
  });

  it("agrees with the strict whole reader on every plain-draft input", () => {
    // a digits-only draft is the one place the two readers overlap; they must
    // never disagree there, and the grouped reader is a superset of the strict
    // one for valid grouping.
    for (const draft of ["0", "7", "1000", "123456", " 42 "]) {
      expect(parseGroupedAmount(draft)).toBe(parseWholeAmount(draft));
    }
    for (const draft of ["", "   ", "abc", "1.5", "-5", "1e3"]) {
      expect(parseGroupedAmount(draft)).toBeNull();
      expect(parseWholeAmount(draft)).toBeNull();
    }
  });

  it("keeps the percentage reader strict (a percentage is never grouped)", () => {
    expect(parseWholePercentage("100")).toBe(100);
    expect(parseWholePercentage("1 000")).toBeNull();
    expect(parseWholePercentage("1,000")).toBeNull();
  });
});
