import { describe, expect, it } from "bun:test";
import i18n from "i18next";
import type { TFunction } from "i18next";

import "../lib/i18n"; // side-effect: initializes i18next (ar)
import { movementDeltaClass, movementReasonText, supersededByCorrection, type PrecedenceRow } from "./stock";

// SAFETY: the initialized i18next instance is a TFunction; the module's default
// export is typed as a broader i18n interface, so the narrowing is asserted here
// rather than at each call site
const t = i18n.t.bind(i18n) as TFunction;

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

  it("styles a zero-delta cost correction as neutral, never as a loss", () => {
    expect(movementDeltaClass(0)).not.toBe("text-destructive");
    expect(movementDeltaClass(0)).toBe("text-muted-foreground");
    // real movements keep their gain/loss styling
    expect(movementDeltaClass(4)).toBe("text-success");
    expect(movementDeltaClass(-3)).toBe("text-destructive");
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

/** The badge copy is owned by the view and asserted by key, never a literal. */
describe("superseded-row copy", () => {
  it("uses the i18n key and never leaks the API token", () => {
    const copy = t("historySupersededByCorrection");
    expect(copy).not.toContain("COST_CORRECTION");
    expect(copy.length).toBeGreaterThan(0);
    expect(copy).not.toBe("historySupersededByCorrection");
  });
});
