import { describe, expect, it } from "bun:test";

import { normalizeArabicIndicDigits, parseGroupedAmount, parseWholeAmount, parseWholePercentage } from "./amount-parse";

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

  it("rejects overflow and mixed-script malformed grouping", () => {
    // beyond Number.MAX_SAFE_INTEGER: parseWholeAmount's guard rejects it
    expect(parseGroupedAmount("99999999999999999999")).toBeNull();
    // mixed Latin + Arabic thousands separator with a bad group width
    expect(parseGroupedAmount("1٬00")).toBeNull();
    expect(parseGroupedAmount("١٬٠٠")).toBeNull();
    // a valid mixed-script grouped amount still parses
    expect(parseGroupedAmount("1٬000")).toBe(1000);
  });
});

/**
 * #198 — the one digit normalizer, shared by the amount reader and the quantity
 * reader so a digit one accepts the other cannot reject.
 */
describe("normalizeArabicIndicDigits", () => {
  it("maps both Arabic digit ranges to ASCII and leaves everything else alone", () => {
    expect(normalizeArabicIndicDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(normalizeArabicIndicDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
    expect(normalizeArabicIndicDigits("٤٢")).toBe("42");
    expect(normalizeArabicIndicDigits("1٬000")).toBe("1٬000");
    expect(normalizeArabicIndicDigits("abc 5")).toBe("abc 5");
    expect(normalizeArabicIndicDigits("")).toBe("");
  });
});
