import { describe, expect, it } from "bun:test";
import i18n from "i18next";
import type { TFunction } from "i18next";

import "../lib/i18n"; // side-effect: initializes i18next (ar)
import { movementReasonText } from "./stock";

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
});
