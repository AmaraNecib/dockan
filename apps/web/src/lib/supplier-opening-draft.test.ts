import { describe, expect, it } from "bun:test";

import { parseGroupedAmount } from "./amount-parse";
import { MAX_OPENING_BALANCE_ROWS, newOpeningRowStatus, openingRowStatus, isOpeningBatchOverLimit } from "./supplier-opening-draft";

/**
 * Greptile round 1 finding 1: a "1,000" amount was rejected by the strict
 * reader and its row silently dropped, so the batch saved one amount short.
 * These readers make the row state explicit so the page can block instead.
 *
 * #180 — the parser table itself lives in amount-parse.test.ts; this file pins
 * that the bulk row readers WIRE to that shared parser (the same number the
 * single-entry money inputs get).
 */
describe("bulk amount reader (shared parseGroupedAmount)", () => {
  it("fills a bulk row with exactly the number the single-entry reader returns", () => {
    for (const draft of ["1,000", "1 000", "٢٥٬٠٠٠", "1000000"]) {
      const parsed = parseGroupedAmount(draft);
      expect(parsed).not.toBeNull();
      expect(openingRowStatus({ amount: draft })).toEqual({ status: "filled", amount: parsed! });
    }
  });

  it("blocks the same malformed drafts the single-entry reader rejects", () => {
    for (const draft of ["1 000,00", "1,5", "1 00", "abc"]) {
      expect(parseGroupedAmount(draft)).toBeNull();
      expect(openingRowStatus({ amount: draft })).toEqual({ status: "invalid" });
    }
  });
});

describe("openingRowStatus", () => {
  it("treats an empty amount as untouched, never as a zero to save", () => {
    expect(openingRowStatus(undefined)).toEqual({ status: "untouched" });
    expect(openingRowStatus({ amount: "" })).toEqual({ status: "untouched" });
    expect(openingRowStatus({ amount: "   " })).toEqual({ status: "untouched" });
  });

  it("fills a grouped amount (the reported 1,000 bug) instead of dropping it", () => {
    expect(openingRowStatus({ amount: "1,000" })).toEqual({ status: "filled", amount: 1000 });
  });

  it("marks a non-positive or malformed draft invalid so the row is blocked", () => {
    expect(openingRowStatus({ amount: "0" })).toEqual({ status: "invalid" });
    expect(openingRowStatus({ amount: "abc" })).toEqual({ status: "invalid" });
    // a decimal/malformed grouping is invalid, never a silently different number
    expect(openingRowStatus({ amount: "1 000,00" })).toEqual({ status: "invalid" });
    expect(openingRowStatus({ amount: "1,5" })).toEqual({ status: "invalid" });
    // valid grouping still fills
    expect(openingRowStatus({ amount: "1 000" })).toEqual({ status: "filled", amount: 1000 });
  });
});

describe("newOpeningRowStatus", () => {
  const existingNames = ["مورد البطاريات"];

  it("is untouched only when both fields are empty", () => {
    expect(newOpeningRowStatus({ name: "", amount: "", existingNames })).toEqual({ status: "untouched" });
  });

  it("is incomplete when only one field is filled (the dropped inline supplier)", () => {
    expect(newOpeningRowStatus({ name: "مورّد جديد", amount: "", existingNames })).toEqual({ status: "incomplete" });
    expect(newOpeningRowStatus({ name: "", amount: "800", existingNames })).toEqual({ status: "incomplete" });
  });

  it("is invalid for a malformed amount and duplicate for an existing name", () => {
    expect(newOpeningRowStatus({ name: "مورّد جديد", amount: "abc", existingNames })).toEqual({ status: "invalid" });
    expect(newOpeningRowStatus({ name: "مورد البطاريات", amount: "800", existingNames })).toEqual({ status: "duplicate" });
    // normalizeTextKey (ADR-0007) collapses whitespace: a padded variant is
    // still the same supplier and must be caught as a duplicate
    expect(newOpeningRowStatus({ name: "مورد  البطاريات", amount: "800", existingNames })).toEqual({ status: "duplicate" });
  });

  it("is filled with the trimmed name and the parsed amount", () => {
    expect(newOpeningRowStatus({ name: "  مورّد جديد  ", amount: "1,000", existingNames })).toEqual({ status: "filled", name: "مورّد جديد", amount: 1000 });
  });
});

describe("MAX_OPENING_BALANCE_ROWS", () => {
  it("matches the contract's 200-row cap", () => {
    expect(MAX_OPENING_BALANCE_ROWS).toBe(200);
  });

  it("allows exactly the cap and blocks only a larger batch", () => {
    expect(isOpeningBatchOverLimit(199)).toBe(false);
    expect(isOpeningBatchOverLimit(200)).toBe(false);
    expect(isOpeningBatchOverLimit(201)).toBe(true);
  });
});
