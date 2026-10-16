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
 * still a refusal, never a blank.
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
    // The exact gap: raw trim() reads the mark as content, the shared predicate
    // reads it as empty. This is why the four guards disagreed with their reader.
    expect(RLM.trim() === "").toBe(false);
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

  it("keeps an interior mark a refusal at every site, never a blank", () => {
    // #227 deliberately leaves a mark inside a draft for the strict readers to
    // refuse: in the RTL page `1\u200f2` renders as `21`, so reading the logical
    // order would bill a number the owner never saw. It must stay a refusal.
    const interior = `1${RLM}2`;
    expect(draftBlank(interior)).toBe(false);
    expect(percentageDraftInvalid(interior)).toBe(true);
    expect(resolveInitialPaid(1000, interior, "")).toEqual({ ok: false });
    expect(nextUnitCost(interior, 1200)).toBe(1200);
    expect(saleOverrideInvalid({ overrideType: "AMOUNT", overrideValue: interior })).toBe(true);
  });
});
