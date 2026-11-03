import { describe, expect, it } from "bun:test";
import i18n from "i18next";

import { movementKinds } from "@dokan/contracts";

import "../lib/i18n"; // side-effect: initializes i18next (ar)
import { type Translate } from "../lib/i18n";
import {
  HISTORY_KIND_KEYS,
  kindLabel,
  movementDeltaClass,
  movementReasonText,
  supersededByCorrection,
  type PrecedenceRow,
} from "./stock";

// SAFETY: the initialized i18next instance's `t` is the catalogue-typed
// translator; the module's default export is typed as a broader i18n
// interface, so the narrowing is asserted here rather than at each call site
const t = i18n.t.bind(i18n) as Translate;

/** The api stores ASCII reason tokens; the item-history view owns the copy. */
describe("stock movement reason tokens", () => {
  it("translates a cost correction instead of leaking the token", () => {
    const rendered = movementReasonText(t, "COST_CORRECTION");
    expect(rendered).not.toContain("COST_CORRECTION");
    expect(rendered).toBe(t("historyReasonCostCorrection"));
  });

  it("renders an unknown legacy reason raw", () => {
    expect(movementReasonText(t, "opening")).toBe("opening");
  });

  it("renders both invoice-correction identifiers without template residue (#331)", () => {
    const rendered = movementReasonText(t, "INVOICE_CORRECTION INV-7 #line-42");
    expect(rendered).toBe("تصحيح فاتورة INV-7 #line-42");
    expect(rendered).not.toContain("{{");
  });

  it("pairs invoice-correction values with the matching translation options (#331)", () => {
    const calls: { key: string; vars: Record<string, string> | undefined }[] = [];
    const stub: Translate = (key, vars) => {
      calls.push({ key, vars });
      return `${vars?.number ?? ""}|${vars?.line ?? ""}`;
    };

    expect(movementReasonText(stub, "INVOICE_CORRECTION INV-7 #line-42")).toBe("INV-7|#line-42");
    expect(calls).toEqual([
      {
        key: "historyReasonInvoiceCorrection",
        vars: { number: "INV-7", line: "#line-42" },
      },
    ]);
  });

  // CHARACTERIZATION, not a behaviour fix. At ae9e416a the call passed
  // `{ context: rest }` and the copy's placeholder was literally `{{context}}`
  // (`git show ae9e416a:apps/web/src/lib/i18n.ts`), so the sentence rendered and
  // this test would have passed there too. What it pins is the pairing: revert the
  // call site to `{ context: rest }` while the copy keeps `{{note}}` and the `{{`
  // assertion below goes red — the ablation was run, not assumed. The rename itself
  // is invisible to `bun run typecheck` (see the comment in stock.tsx), so this
  // run-time pairing is the only guard.
  it("characterizes the copy's `note` placeholder as filled by the option of the same name (#322)", () => {
    const rendered = movementReasonText(t, "RETURN_REJECTED_DAMAGED RTN-7 — scratched");
    expect(rendered).toContain("RTN-7 — scratched");
    // an unfilled template would leak the braces onto the screen
    expect(rendered).not.toContain("{{");
  });

  it("styles a zero-delta cost correction as neutral, never as a loss", () => {
    expect(movementDeltaClass(0)).not.toBe("text-destructive");
    expect(movementDeltaClass(0)).toBe("text-muted-foreground");
    // real movements keep their gain/loss styling
    expect(movementDeltaClass(4)).toBe("text-success");
    expect(movementDeltaClass(-3)).toBe("text-destructive");
  });
});

/**
 * #331 — the movement kind's copy is a table over the contract's kinds, not an
 * if-chain with a silent default.
 *
 * `movementKinds` is the contract's own list, so the table in `stock.tsx` is
 * exhaustive over it: a kind the contract adds is a missing property at the
 * table, and `bun run typecheck` fails THERE — at the table — instead of the
 * screen quietly labelling the new kind as an adjustment. The if-chain this
 * replaces had no such edge; it fell through to the adjustment copy for every
 * kind it did not name, so a fourth kind rendered "تسوية" with no error and no
 * test.
 *
 * These assertions are the run-time half of the same claim, and the one the
 * compiler cannot make: `bun test` does not typecheck, so the table's key set
 * is compared with the contract's kind set here.
 */
describe("the movement kind's copy is exhaustive over the contract (issue 331)", () => {
  it("names every kind the contract declares, and no other", () => {
    expect(Object.keys(HISTORY_KIND_KEYS).sort()).toEqual([...movementKinds].sort());
  });

  it("gives each kind its own catalogue key", () => {
    expect(HISTORY_KIND_KEYS.PURCHASE).toBe("historyKind_PURCHASE");
    expect(HISTORY_KIND_KEYS.SALE).toBe("historyKind_SALE");
    expect(HISTORY_KIND_KEYS.MANUAL_ADJUSTMENT).toBe("historyKind_MANUAL_ADJUSTMENT");
    // a copy-paste that points two kinds at one key is a duplicate here rather
    // than plausible-looking Arabic on the screen
    expect(new Set(Object.values(HISTORY_KIND_KEYS)).size).toBe(movementKinds.length);
  });

  it("renders the intended Arabic copy for each kind without template residue", () => {
    const expectedCopies = {
      PURCHASE: "مشتريات",
      SALE: "بيع",
      MANUAL_ADJUSTMENT: "تسوية",
    } satisfies Record<(typeof movementKinds)[number], string>;
    const rendered = movementKinds.map((kind) => kindLabel(t, kind));
    expect(new Set(rendered).size).toBe(movementKinds.length);
    for (const kind of movementKinds) {
      const copy = kindLabel(t, kind);
      expect(copy).not.toMatch(/\{\{[^}]+\}\}/);
      expect(copy).toBe(expectedCopies[kind]);
      expect(copy).toMatch(/[\u0600-\u06FF]/);
      // never a key: a table that fell behind the contract renders the key
      // itself, which is the #322 symptom
      expect(Object.values(HISTORY_KIND_KEYS)).not.toContain(copy);
    }
  });
});

/** The date-ordered history can draw an inflow below a correction that was
 * recorded after it (issue 151). Those rows are flagged so the owner does not
 * read the purchase as one that never moved the average. */
describe("cost-correction recording-order precedence (issue 151)", () => {
  const correction = (createdAt: string): PrecedenceRow => ({
    delta: 0,
    unitCost: 300,
    reason: "COST_CORRECTION",
    createdAt,
  });
  const inflow = (createdAt: string, delta = 10): PrecedenceRow => ({
    delta,
    unitCost: 200,
    reason: null,
    createdAt,
  });
  const outflow = (createdAt: string): PrecedenceRow => ({
    delta: -4,
    unitCost: null,
    reason: null,
    createdAt,
  });

  it("flags a future-dated inflow recorded before a correction drawn above it", () => {
    // display order: the correction (index 0) then the earlier-recorded purchase
    const rows = [correction("2026-10-15T10:00:00"), inflow("2026-10-14T09:00:00")];
    expect(supersededByCorrection(rows)).toEqual(new Set([1]));
  });

  it("leaves an inflow recorded after the correction alone (the normal blend)", () => {
    const rows = [correction("2026-10-14T09:00:00"), inflow("2026-10-15T09:00:00")];
    expect(supersededByCorrection(rows)).toEqual(new Set());
  });

  it("never flags an outflow: it does not move the weighted average", () => {
    const rows = [correction("2026-10-15T10:00:00"), outflow("2026-10-14T09:00:00")];
    expect(supersededByCorrection(rows)).toEqual(new Set());
  });

  it("does not flag an inflow drawn above a correction recorded before it", () => {
    // display order: the purchase then the correction, so reading order is honest
    const rows = [inflow("2026-10-14T09:00:00"), correction("2026-10-15T10:00:00")];
    expect(supersededByCorrection(rows)).toEqual(new Set());
  });

  it("is empty for a plain date-ordered ledger with no correction", () => {
    expect(supersededByCorrection([inflow("2026-10-14T09:00:00"), outflow("2026-10-15T09:00:00")])).toEqual(new Set());
  });

  it("leaves a same-second tie unannotated rather than guessing the order", () => {
    const rows = [correction("2026-10-15T10:00:00"), inflow("2026-10-15T10:00:00")];
    expect(supersededByCorrection(rows)).toEqual(new Set());
  });

  it("ignores a correction recorded before the row and flags a higher one recorded after it", () => {
    const rows = [
      correction("2026-10-13T10:00:00"), // recorded before the row: does not supersede
      correction("2026-10-15T10:00:00"), // recorded after the row: supersedes
      inflow("2026-10-14T09:00:00"),
    ];
    expect(supersededByCorrection(rows)).toEqual(new Set([2]));
  });

  it("is empty for an empty ledger", () => {
    expect(supersededByCorrection([])).toEqual(new Set());
  });

  it("does not treat a zero-delta row without the correction token as a correction", () => {
    const opening: PrecedenceRow = { delta: 0, unitCost: 100, reason: "opening", createdAt: "2026-10-14T09:00:00" };
    expect(supersededByCorrection([opening, inflow("2026-10-13T09:00:00")])).toEqual(new Set());
  });

  it("does not treat a COST_CORRECTION row with a null unit cost as a correction", () => {
    // the api's own isCostCorrection requires a non-null unit cost, so a
    // null-cost legacy row is a replay no-op and must not supersede anything
    const nullCost: PrecedenceRow = { delta: 0, unitCost: null, reason: "COST_CORRECTION", createdAt: "2026-10-15T10:00:00" };
    expect(supersededByCorrection([nullCost, inflow("2026-10-14T09:00:00")])).toEqual(new Set());
  });
});

/**
 * Issue 215 — the api resolves precedence over the WHOLE ledger and annotates
 * each row with the recording order of the correction that supersedes it, so
 * the badge survives pagination and same-second ties. The view renders that
 * answer; only a response cached before the field existed falls back to the
 * page-local comparison of issue 151.
 */
describe("cost-correction precedence survives pagination (issue 215)", () => {
  const row = (over: Partial<PrecedenceRow> & Pick<PrecedenceRow, "delta">): PrecedenceRow => ({
    unitCost: null,
    reason: null,
    createdAt: "2026-10-15T10:00:00",
    ...over,
  });

  it("badges a row the api marked superseded when the correction is on another page", () => {
    // no correction row on this page at all, so a page-local rule would miss it
    const rows = [
      row({ delta: 5, unitCost: 100, seq: 2, supersededBySeq: null }),
      row({ delta: 10, unitCost: 200, seq: 1, supersededBySeq: 3 }),
    ];
    expect(supersededByCorrection(rows)).toEqual(new Set([1]));
  });

  it("trusts the annotation even when the page-local rule would disagree", () => {
    // the annotated row is drawn ABOVE the correction-looking row here; the
    // page-local fallback would not flag it, the api's whole-ledger answer does
    const rows = [
      row({ delta: 10, unitCost: 200, seq: 1, supersededBySeq: 3 }),
      row({ delta: 0, unitCost: 300, reason: "COST_CORRECTION", seq: 2, supersededBySeq: null }),
    ];
    expect(supersededByCorrection(rows)).toEqual(new Set([0]));
  });

  it("flags nothing when the api annotated every row as not superseded", () => {
    const rows = [
      row({ delta: 10, unitCost: 200, seq: 1, supersededBySeq: null }),
      row({ delta: -4, seq: 2, supersededBySeq: null }),
    ];
    expect(supersededByCorrection(rows)).toEqual(new Set());
  });

  it("uses the page-local fallback when the api did not annotate the response", () => {
    const rows = [
      row({ delta: 0, unitCost: 300, reason: "COST_CORRECTION", createdAt: "2026-10-15T10:00:00" }),
      row({ delta: 10, unitCost: 200, createdAt: "2026-10-14T09:00:00" }),
    ];
    expect(supersededByCorrection(rows)).toEqual(new Set([1]));
  });

  it("prefers recording order inside the fallback when both rows carry seq", () => {
    // equal createdAt: the legacy rule ties and stays silent, but seq orders
    // the correction after the row, so the fallback flags it deterministically
    const rows = [
      row({ delta: 0, unitCost: 300, reason: "COST_CORRECTION", createdAt: "2026-10-15T10:00:00", seq: 3 }),
      row({ delta: 10, unitCost: 200, createdAt: "2026-10-15T10:00:00", seq: 1 }),
    ];
    expect(supersededByCorrection(rows)).toEqual(new Set([1]));
  });

  it("never badges an outflow even if the annotation is present", () => {
    const rows = [row({ delta: -4, seq: 1, supersededBySeq: 3 })];
    // only inflows move the weighted average, so a corrupt annotation must not
    // teach the view to badge one (issue 151 invariant, kept on both sides)
    expect(supersededByCorrection(rows)).toEqual(new Set());
  });
});

/** The badge copy is owned by the view and asserted by key, never a literal. */
describe("superseded-row copy", () => {
  it("uses the i18n key and never leaks the API token", () => {
    const copy = t("historySupersededByCorrection");
    expect(copy).not.toContain("COST_CORRECTION");
    expect(copy.length).toBeGreaterThan(0);
    expect(copy).not.toBe("historySupersededByCorrection");
  });

  it("makes no page-relative claim, so it reads correctly cross-page", () => {
    // issue 222: the correction a badge points at can sit on a prior page, so
    // the copy must state the recording order, never a page position
    const copy = t("historySupersededByCorrection");
    expect(copy).toContain("قبل");
    for (const pageWord of ["أعلاه", "أعلى", "بالأعلى", "فوق", "أسفل", "صفحة", "تحت", "أدناه"]) {
      expect(copy).not.toContain(pageWord);
    }
  });
});
