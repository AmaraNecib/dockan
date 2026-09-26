import { describe, expect, it } from "bun:test";
import i18n from "i18next";
import type { TFunction } from "i18next";

import "../lib/i18n"; // side-effect: initializes i18next (ar)
import { activitySummaryText } from "./activity";

// SAFETY: the initialized i18next instance is a TFunction; the module's default
// export is typed as a broader i18n interface, so the narrowing is asserted here
// rather than at each call site
const t = i18n.t.bind(i18n) as TFunction;

/**
 * The api stores ASCII tokens and this page owns the copy. A missing or
 * misordered branch would leak the raw token into the activity log, so each
 * case asserts both halves: the tag is gone AND the data survived.
 */
describe("activity summary tokens render translated copy", () => {
  const cases: { summary: string; keeps: string[] }[] = [
    { summary: "STORE_SETUP دكان النور", keeps: ["دكان النور"] },
    { summary: "CATEGORY_CREATED بطاريات", keeps: ["بطاريات"] },
    { summary: "ITEM_CREATED_WITH_STOCK 12 بطارية", keeps: ["12", "بطارية"] },
    { summary: "ITEM_CREATED بطارية", keeps: ["بطارية"] },
    { summary: "ITEM_UPDATED بطارية", keeps: ["بطارية"] },
    { summary: "STOCK_ADJUSTED بطارية", keeps: ["بطارية"] },
    { summary: "STOCK_LINKED INV-1", keeps: ["INV-1"] },
    { summary: "PURCHASE_CORRECTED بطارية", keeps: ["بطارية"] },
    { summary: "SALE_CREATED INV-2", keeps: ["INV-2"] },
    { summary: "PAYMENT_RECORDED 5000 INV-2", keeps: ["5000", "INV-2"] },
    { summary: "EXPENSE_CATEGORY_CREATED WITHDRAWAL سحوبات", keeps: ["سحوبات"] },
    { summary: "EXPENSE_CATEGORY_CREATED NORMAL إيجار", keeps: ["إيجار"] },
    { summary: "EXPENSE_RECORDED 3000", keeps: ["3000"] },
    { summary: "SETTINGS_UPDATED", keeps: [] },
    { summary: "BACKUP_CREATED dokan-2035-06-01.db", keeps: ["dokan-2035-06-01.db"] },
    { summary: "DAILY_BACKUP dokan-2035-06-01.db", keeps: ["dokan-2035-06-01.db"] },
    { summary: "PASSWORD_RESET 0551234567", keeps: ["0551234567"] },
    { summary: "RETURN_RECORDED RET-1 2000 INV-3 500", keeps: ["RET-1", "2000", "INV-3"] },
    { summary: "RETURN_REVIEWED RET-1 ACCEPTED 2000", keeps: ["RET-1", "2000"] },
  ];

  for (const { summary, keeps } of cases) {
    it(`renders "${summary}" without leaking its tag`, () => {
      const tag = summary.split(" ")[0]!;
      const rendered = activitySummaryText(t, summary);

      expect(rendered).not.toContain(tag);
      for (const field of keeps) expect(rendered).toContain(field);
    });
  }

  it("falls back to the translated default supplier when the party is absent", () => {
    const withParty = activitySummaryText(t, "PURCHASE_CREATED INV-9 شركة الأمل");
    const withoutParty = activitySummaryText(t, "PURCHASE_CREATED INV-9");

    expect(withParty).toContain("شركة الأمل");
    expect(withoutParty).not.toContain("PURCHASE_CREATED");
    expect(withoutParty).toContain(t("activitySupplierDefault"));
    expect(withoutParty).not.toBe(withParty);
  });

  it("distinguishes a withdrawal expense category from an ordinary one", () => {
    const withdrawal = activitySummaryText(t, "EXPENSE_CATEGORY_CREATED WITHDRAWAL سحب");
    const ordinary = activitySummaryText(t, "EXPENSE_CATEGORY_CREATED NORMAL إيجار");

    expect(withdrawal).not.toBe(ordinary);
    expect(withdrawal).toContain("سحب");
    expect(ordinary).toContain("إيجار");
  });

  it("keeps the debt figure only for a return that was settled against debt", () => {
    const withDebt = activitySummaryText(t, "RETURN_RECORDED RET-1 2000 INV-3 500");
    const withoutDebt = activitySummaryText(t, "RETURN_RECORDED RET-1 2000 INV-3 0");

    expect(withDebt).not.toBe(withoutDebt);
    expect(withDebt).toContain("500");
  });

  it("renders pre-token Arabic rows raw, so no migration is needed", () => {
    const legacy = "إنشاء تصنيف بطاريات";

    expect(activitySummaryText(t, legacy)).toBe(legacy);
  });

  it("renders an unknown token raw rather than dropping the row", () => {
    expect(activitySummaryText(t, "SOMETHING_NEW payload")).toBe("SOMETHING_NEW payload");
  });
});
