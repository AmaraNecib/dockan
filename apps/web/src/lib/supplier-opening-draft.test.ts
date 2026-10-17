import { describe, expect, it } from "bun:test";

import { parseGroupedAmount } from "./amount-parse";
import { MAX_OPENING_BALANCE_ROWS, droppedFilledDrafts, duplicateTypedRowIds, newOpeningRowStatus, openingRowStatus, isOpeningBatchOverLimit } from "./supplier-opening-draft";

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

  it("treats a mark-only pasted amount as untouched, not as an invalid row (#244)", () => {
    // a bidi mark is Unicode Cf, not whitespace: the raw-`.trim()` gate read it
    // as a filled row and the grouped reader then refused it
    expect(openingRowStatus({ amount: "\u200f" })).toEqual({ status: "untouched" });
    expect(openingRowStatus({ amount: " \u200f " })).toEqual({ status: "untouched" });
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
    // #255 — a duplicate still carries the parsed fields: such a row is a usable
    // outgoing row (the server resolves the name onto that account), so the page
    // can send it instead of dropping the owner's amount
    expect(newOpeningRowStatus({ name: "مورد البطاريات", amount: "800", existingNames })).toEqual({ status: "duplicate", name: "مورد البطاريات", amount: 800 });
    // normalizeTextKey (ADR-0007) collapses whitespace: a padded variant is
    // still the same supplier and must be caught as a duplicate
    expect(newOpeningRowStatus({ name: "مورد  البطاريات", amount: "800", existingNames })).toEqual({ status: "duplicate", name: "مورد  البطاريات", amount: 800 });
  });

  it("reads a mark-only amount as empty: a named row is incomplete, an unnamed one untouched (#244)", () => {
    expect(newOpeningRowStatus({ name: "مورّد جديد", amount: "\u200f", existingNames })).toEqual({ status: "incomplete" });
    expect(newOpeningRowStatus({ name: "", amount: "\u200f", existingNames })).toEqual({ status: "untouched" });
  });

  it("is filled with the trimmed name and the parsed amount", () => {
    expect(newOpeningRowStatus({ name: "  مورّد جديد  ", amount: "1,000", existingNames })).toEqual({ status: "filled", name: "مورّد جديد", amount: 1000 });
  });
});

/**
 * #204 — a background refresh can remove a supplier whose draft the owner
 * already filled. The draft is reconciled against the fresh id set at this seam
 * so the page can name the loss; an untouched row may still drop silently.
 */
describe("droppedFilledDrafts (issue 204)", () => {
  it("returns a filled draft whose supplier is no longer present, with its remembered name and amount", () => {
    expect(
      droppedFilledDrafts({
        drafts: { "s-2": { name: "مورد بلا حركات", amount: "1,000" } },
        presentSupplierIds: ["s-1", "s-3"],
      }),
    ).toEqual([{ supplierId: "s-2", name: "مورد بلا حركات", amount: 1000 }]);
  });

  it("leaves an untouched draft to drop silently (the negative the fix must not warn on)", () => {
    expect(
      droppedFilledDrafts({
        drafts: { "s-2": { name: "مورد بلا حركات", amount: "" } },
        presentSupplierIds: ["s-1"],
      }),
    ).toEqual([]);
  });

  it("does not flag a supplier that is still present", () => {
    expect(
      droppedFilledDrafts({
        drafts: { "s-2": { name: "مورد بلا حركات", amount: "300" } },
        presentSupplierIds: ["s-2"],
      }),
    ).toEqual([]);
  });

  it("does not flag an invalid draft: only a parsed, positive amount is a filled row", () => {
    expect(
      droppedFilledDrafts({
        drafts: { "s-2": { name: "مورد بلا حركات", amount: "abc" } },
        presentSupplierIds: [],
      }),
    ).toEqual([]);
  });

  it("reports an empty name when a draft was recorded without one, never crashing", () => {
    // `setRow` always seeds the name from a rendered row, so this is the
    // unreachable-today fallback; pinned so a future seed path cannot blank the
    // notice silently
    expect(
      droppedFilledDrafts({
        drafts: { "s-2": { amount: "10" } },
        presentSupplierIds: [],
      }),
    ).toEqual([{ supplierId: "s-2", name: "", amount: 10 }]);
  });

  it("keeps the draft order across several removed suppliers", () => {
    const drafts = {
      "s-1": { name: "أ", amount: "100" },
      "s-2": { name: "ب", amount: "200" },
      "s-3": { name: "ج", amount: "300" },
    };
    expect(droppedFilledDrafts({ drafts, presentSupplierIds: ["s-3"] })).toEqual([
      { supplierId: "s-1", name: "أ", amount: 100 },
      { supplierId: "s-2", name: "ب", amount: 200 },
    ]);
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

/**
 * #255 — two typed rows that fold to one supplier would double-post the same
 * account, and the api refuses the WHOLE batch for it
 * (`DUPLICATE_OPENING_BALANCE_ROW`), losing every amount in it. The page blocks
 * the same shape on the client, off this one predicate.
 */
describe("duplicateTypedRowIds (issue 255)", () => {
  const row = (id: string, name: string) => ({ id, name });

  it("flags both rows whose names fold to one key", () => {
    expect(duplicateTypedRowIds([row("a", "مورد  مكرر"), row("b", "مورد مكرر")])).toEqual(["a", "b"]);
  });

  it("folds mark-only pastes and invisible bidi text the same way the api does", () => {
    expect(duplicateTypedRowIds([row("a", "مورد مكرر"), row("b", "مورد\u200f مكرر")])).toEqual(["a", "b"]);
  });

  it("never treats distinct names as duplicates", () => {
    expect(duplicateTypedRowIds([row("a", "مورد أ"), row("b", "مورد ب")])).toEqual([]);
  });

  it("gives a blank or mark-only name no identity, so blank rows are not duplicates of each other", () => {
    expect(duplicateTypedRowIds([row("a", ""), row("b", ""), row("c", "   "), row("d", "\u200f")])).toEqual([]);
  });

  it("reports every member of a three-way clash, not just the later pair", () => {
    expect(duplicateTypedRowIds([row("a", "مورد"), row("b", "مورد "), row("c", " مورد")])).toEqual(["a", "b", "c"]);
  });
});
