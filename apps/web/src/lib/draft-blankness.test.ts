import { describe, expect, it } from "bun:test";

import type { Item } from "@dokan/contracts";

import { PASTED_BIDI_MARKS, draftBlank, percentageDraftInvalid } from "./amount-parse";
import { nextUnitCost, resolveInitialPaid, saleOverrideInvalid, saleUnitPrice, type SaleDraftLine } from "./invoice-draft";

/**
 * #238 — one blankness predicate, shared by every numeric-draft reader.
 *
 * #227 fixed one instance of a normalisation that can empty a non-blank draft
 * re-opening a raw-`.trim()` guard. This file closes the class: a bidi mark is
 * Unicode `Cf`, not ES `WhiteSpace`, so `.trim()` cannot drop it while
 * `normalizeArabicIndicDigits` does — and then a guard and the reader it guards
 * disagree about whether anything was chosen.
 *
 * The invariant pinned here is *not* "every site treats blank the same" (the
 * fallbacks differ on purpose, #146). It is: **every site judges a mark-only
 * draft exactly as it judges an empty draft**, and a mark *inside* a draft is
 * still a refusal, never a blank. The sites this file covers are the ones the
 * shared predicate reaches: `saleUnitPrice`, `saleOverrideInvalid`,
 * `nextUnitCost`, `resolveInitialPaid`, `percentageDraftInvalid` and
 * `draftBlank` itself. Raw-`.trim()` gates outside that set are recorded as
 * follow-ups, not silently claimed (#238 design).
 */

const RLM = "\u200f";

function item(sellingPrice = 1000): Item {
  return {
    id: "item-1",
    name: "منتج",
    barcode: null,
    categoryId: "cat-1",
    costPrice: 400,
    sellingPrice,
    lowStockThreshold: 0,
    stockOnHand: 0,
    createdAt: "2026-10-01T10:00:00",
    updatedAt: "2026-10-01T10:00:00",
  };
}

function overrideLine(draft: string): SaleDraftLine {
  return { item: item(), quantityDraft: "1", overrideType: "AMOUNT", overrideValue: draft };
}

/**
 * One row per numeric-draft reader / guard. `blankVerdict` is what both the
 * empty draft and (after #238) the mark-only draft must produce; `chosenVerdict`
 * is what a real, valid digit draft produces. Keeping the verdicts as strings
 * lets one table assert every site's shape without per-site comparisons.
 */
interface Site {
  name: string;
  judge: (draft: string) => string;
  chosenDraft: string;
  blankVerdict: string;
  chosenVerdict: string;
}

const SITES: readonly Site[] = [
  {
    name: "saleOverrideInvalid",
    judge: (draft) => String(saleOverrideInvalid({ overrideType: "AMOUNT", overrideValue: draft })),
    chosenDraft: "900",
    blankVerdict: "true", // a chosen override with no value is the free-line hole
    chosenVerdict: "false",
  },
  {
    name: "saleUnitPrice",
    judge: (draft) => String(saleUnitPrice(overrideLine(draft))),
    chosenDraft: "900",
    blankVerdict: "1000", // the item's default price
    chosenVerdict: "900",
  },
  {
    name: "percentageDraftInvalid",
    judge: (draft) => String(percentageDraftInvalid(draft)),
    chosenDraft: "50",
    blankVerdict: "false", // blank is «not chosen», which is not an error
    chosenVerdict: "false",
  },
  {
    name: "resolveInitialPaid",
    judge: (draft) => JSON.stringify(resolveInitialPaid(1000, draft, "")),
    chosenDraft: "400",
    blankVerdict: JSON.stringify({ ok: true, paid: undefined }),
    chosenVerdict: JSON.stringify({ ok: true, paid: 400 }),
  },
  {
    name: "nextUnitCost",
    judge: (draft) => String(nextUnitCost(draft, 1200)),
    chosenDraft: "400",
    blankVerdict: "0", // a cleared field is the documented explicit zero
    chosenVerdict: "400",
  },
  {
    name: "draftBlank",
    judge: (draft) => String(draftBlank(draft)),
    chosenDraft: "400",
    blankVerdict: "true",
    chosenVerdict: "false",
  },
];

describe("one blankness predicate across every numeric-draft reader (#238)", () => {
  it("decides blankness with the reader's normalisation, not a raw trim()", () => {
    // A bidi mark is `Cf`, not ES `WhiteSpace`, so `.trim()` alone reads it as
    // content while the shared predicate reads it as empty — the gap the guards
    // disagreed over. (Stated as a comment, not an assertion on `.trim()`, which
    // is a JavaScript-platform property rather than this code's.)
    expect(draftBlank(RLM)).toBe(true);
    expect(draftBlank("")).toBe(true);
    expect(draftBlank("   ")).toBe(true);
    expect(draftBlank("400")).toBe(false);
  });

  it("pins every site's verdict for empty, mark-only and a real digit draft", () => {
    for (const site of SITES) {
      expect([site.name, site.judge("")]).toEqual([site.name, site.blankVerdict]);
      expect([site.name, site.judge(RLM)]).toEqual([site.name, site.blankVerdict]);
      expect([site.name, site.judge(site.chosenDraft)]).toEqual([site.name, site.chosenVerdict]);
    }
    // percentageDraftInvalid's row has blank==chosen ("not invalid" both ways),
    // so its discriminating direction is pinned separately — otherwise a stub
    // that always returned false would pass the whole table.
    expect(percentageDraftInvalid("12.5")).toBe(true);
    expect(percentageDraftInvalid("abc")).toBe(true);
    expect(percentageDraftInvalid("101")).toBe(true);
  });

  it("judges mark-only exactly like empty at every site (the class invariant)", () => {
    for (const site of SITES) {
      expect([site.name, site.judge(RLM)]).toEqual([site.name, site.judge("")]);
    }
  });

  it("holds the invariant across the whole PASTED_BIDI_MARKS set, bare and wrapped", () => {
    // Drive the mark set, not one character: a later mark added to the list is
    // covered at every site with no test edit. The wrapped shape (` mark `) is
    // the real paste out of RTL text; the doubled mark pins the no-content path.
    for (const [index, mark] of PASTED_BIDI_MARKS.entries()) {
      for (const draft of [mark, ` ${mark} `, `${mark}${mark}`]) {
        for (const site of SITES) {
          expect([index, site.name, site.judge(draft)]).toEqual([index, site.name, site.judge("")]);
        }
      }
    }
  });

  it("holds for two DIFFERENT marks, not only one mark repeated", () => {
    for (const first of PASTED_BIDI_MARKS) {
      for (const second of PASTED_BIDI_MARKS) {
        expect([first, second, draftBlank(` ${first} ${second} `)]).toEqual([first, second, true]);
      }
    }
  });

  it("keeps the strip at the edge: a mark glued to digits is content, not blank", () => {
    for (const mark of PASTED_BIDI_MARKS) {
      expect([mark, draftBlank(`${mark}400`)]).toEqual([mark, false]);
      expect([mark, draftBlank(`400${mark}`)]).toEqual([mark, false]);
      // either Arabic-Indic digit script is content too, so the edge case cannot
      // be mistaken for a blank just because the digit is not ASCII
      expect([mark, draftBlank(`${mark}٥`)]).toEqual([mark, false]);
      expect([mark, draftBlank(`${mark}۵`)]).toEqual([mark, false]);
    }
  });

  it("keeps an interior mark a refusal at every site, never a blank", () => {
    // #227 deliberately leaves a mark inside a draft for the strict readers to
    // refuse: in the RTL page `1\u200f2` renders as `21`, so reading the logical
    // order would bill a number the owner never saw. It must stay a refusal at
    // every mark, not just the one RLM case.
    for (const mark of PASTED_BIDI_MARKS) {
      const interior = `1${mark}2`;
      expect([mark, draftBlank(interior)]).toEqual([mark, false]);
      expect([mark, percentageDraftInvalid(interior)]).toEqual([mark, true]);
      expect([mark, resolveInitialPaid(1000, interior, "")]).toEqual([mark, { ok: false }]);
      expect([mark, nextUnitCost(interior, 1200)]).toEqual([mark, 1200]);
      expect([mark, saleOverrideInvalid({ overrideType: "AMOUNT", overrideValue: interior })]).toEqual([mark, true]);
      // saleUnitPrice cannot itself refuse: it falls back to the default price,
      // and saleOverrideInvalid is what turns that into a submit refusal.
      expect([mark, saleUnitPrice(overrideLine(interior))]).toEqual([mark, 1000]);
    }
  });
});
