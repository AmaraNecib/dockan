import { afterEach, describe, expect, it } from "bun:test";
import i18n from "i18next";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly.
// SAFETY: only this flag is written; globalThis keeps every other property.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar)
import { activitySummaryText } from "./activity";

// SAFETY: the initialized i18next instance is a TFunction; the module's default
// export is typed as a broader i18n interface, so the narrowing is asserted here
// rather than at each call site
const t = i18n.t.bind(i18n) as TFunction;

let mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];

/** Render a translated summary node so `Trans` interpolates the real `<Amount>`. */
function renderNode(node: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  mounted.push({ root, host });
  return host;
}

function renderSummary(summary: string): string {
  return renderNode(activitySummaryText(t, summary)).textContent ?? "";
}

afterEach(() => {
  const entries = mounted;
  mounted = [];
  for (const entry of entries) act(() => entry.root.unmount());
  document.body.innerHTML = "";
});

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
    { summary: "ITEM_COST_CORRECTED 150 بطارية", keeps: ["150", "بطارية"] },
    { summary: "PARTY_CREATED CUSTOMER علي علي", keeps: ["علي علي", "زبون"] },
    { summary: "PARTY_UPDATED SUPPLIER صالح بن علي", keeps: ["صالح بن علي", "مورّد"] },
    { summary: "PARTY_DELETED CUSTOMER عماره", keeps: ["عماره", "زبون"] },
    { summary: "STOCK_ADJUSTED بطارية", keeps: ["بطارية"] },
    { summary: "STOCK_LINKED INV-1", keeps: ["INV-1"] },
    { summary: "PURCHASE_CORRECTED بطارية", keeps: ["بطارية"] },
    { summary: "SALE_CREATED INV-2", keeps: ["INV-2"] },
    { summary: "PAYMENT_RECORDED 5000 INV-2", keeps: ["5,000", "INV-2"] },
    { summary: "SUPPLIER_PAYMENT 500 شركة الأمل", keeps: ["500", "شركة الأمل"] },
    { summary: "SUPPLIER_RETURN PRT-1 300 شركة الأمل", keeps: ["PRT-1", "300", "شركة الأمل"] },
    { summary: "SUPPLIER_REFUND 200 شركة الأمل", keeps: ["200", "شركة الأمل"] },
    { summary: "EXPENSE_CATEGORY_CREATED WITHDRAWAL سحوبات", keeps: ["سحوبات"] },
    { summary: "EXPENSE_CATEGORY_CREATED NORMAL إيجار", keeps: ["إيجار"] },
    { summary: "EXPENSE_RECORDED 3000", keeps: ["3,000"] },
    { summary: "SETTINGS_UPDATED", keeps: [] },
    { summary: "BACKUP_CREATED dokan-2035-06-01.db", keeps: ["dokan-2035-06-01.db"] },
    { summary: "DAILY_BACKUP dokan-2035-06-01.db", keeps: ["dokan-2035-06-01.db"] },
    { summary: "PASSWORD_RESET 0551234567", keeps: ["0551234567"] },
    { summary: "RETURN_RECORDED RET-1 2000 INV-3 500", keeps: ["RET-1", "2,000", "INV-3"] },
    { summary: "RETURN_REVIEWED RET-1 ACCEPTED 2000", keeps: ["RET-1", "2,000"] },
  ];

  for (const { summary, keeps } of cases) {
    it(`renders "${summary}" without leaking its tag`, () => {
      const tag = summary.split(" ")[0]!;
      const rendered = renderSummary(summary);

      expect(rendered).not.toContain(tag);
      for (const field of keeps) expect(rendered).toContain(field);
    });
  }

  it("falls back to the translated default supplier when the party is absent", () => {
    const withParty = renderSummary("PURCHASE_CREATED INV-9 شركة الأمل");
    const withoutParty = renderSummary("PURCHASE_CREATED INV-9");

    expect(withParty).toContain("شركة الأمل");
    expect(withoutParty).not.toContain("PURCHASE_CREATED");
    expect(withoutParty).toContain(t("activitySupplierDefault"));
    expect(withoutParty).not.toBe(withParty);
  });

  it("distinguishes a withdrawal expense category from an ordinary one", () => {
    const withdrawal = renderSummary("EXPENSE_CATEGORY_CREATED WITHDRAWAL سحب");
    const ordinary = renderSummary("EXPENSE_CATEGORY_CREATED NORMAL إيجار");

    expect(withdrawal).not.toBe(ordinary);
    expect(withdrawal).toContain("سحب");
    expect(ordinary).toContain("إيجار");
  });

  it("keeps the debt figure only for a return that was settled against debt", () => {
    const withDebt = renderSummary("RETURN_RECORDED RET-1 2000 INV-3 500");
    const withoutDebt = renderSummary("RETURN_RECORDED RET-1 2000 INV-3 0");

    expect(withDebt).not.toBe(withoutDebt);
    expect(withDebt).toContain("500");
  });

  it("renders a payment amount through the money primitive, grouped (#254 round 2)", () => {
    // The finding: `activitySummaryText` interpolated the raw digits into the
    // Arabic sentence, so the owner read `5000 دج` beside a grouped `5,000 دج`
    // from `<Amount>` on the same screen. The digits AND the currency must now
    // come from the primitive.
    const host = renderNode(activitySummaryText(t, "PAYMENT_RECORDED 5000 INV-2"));

    expect(host.querySelector('[data-testid="money-figures"]')?.textContent).toBe("5,000");
    expect(host.querySelector('[data-testid="money-currency"]')?.textContent).toBe("دج");
    expect(host.textContent).toContain("5,000 دج");
    expect(host.textContent).not.toContain("5000 دج");
  });

  it("renders pre-token Arabic rows raw, so no migration is needed", () => {
    const legacy = "إنشاء تصنيف بطاريات";

    expect(renderSummary(legacy)).toBe(legacy);
  });

  it("renders an unknown token raw rather than dropping the row", () => {
    expect(renderSummary("SOMETHING_NEW payload")).toBe("SOMETHING_NEW payload");
  });
});
