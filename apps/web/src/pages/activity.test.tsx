import { describe, expect, it } from "bun:test";
import i18n from "i18next";
import type { TFunction } from "i18next";
import { activitySummaryTags, activityTypes } from "@dokan/contracts";

import "../lib/i18n"; // side-effect: initializes i18next (ar)
import { activityRefLink, activitySummaryText } from "./activity";

// SAFETY: the initialized i18next instance is a TFunction; the module's default
// export is typed as a broader i18n interface, so the narrowing is asserted here
// rather than at each call site
const t = i18n.t.bind(i18n) as TFunction;

/**
 * The api stores ASCII tokens and this page owns the copy. A missing or
 * misordered branch would leak the raw token into the activity log, so each
 * case asserts both halves: the tag is gone AND the data survived.
 *
 * #253 — the fixture list is keyed by the tag and MUST cover
 * `activitySummaryTags` exactly (see the enumeration test below), so a new
 * server tag cannot ship without a branch: the web suite fails here.
 */
type Case = { tag: (typeof activitySummaryTags)[number]; summary: string; keeps: string[] };

describe("activity summary tokens render translated copy", () => {
  const cases: Case[] = [
    { tag: "STORE_SETUP", summary: "STORE_SETUP دكان النور", keeps: ["دكان النور"] },
    { tag: "CATEGORY_CREATED", summary: "CATEGORY_CREATED بطاريات", keeps: ["بطاريات"] },
    { tag: "ITEM_CREATED_WITH_STOCK", summary: "ITEM_CREATED_WITH_STOCK 12 بطارية", keeps: ["12", "بطارية"] },
    { tag: "ITEM_CREATED", summary: "ITEM_CREATED بطارية", keeps: ["بطارية"] },
    { tag: "ITEM_UPDATED", summary: "ITEM_UPDATED بطارية", keeps: ["بطارية"] },
    { tag: "ITEM_COST_CORRECTED", summary: "ITEM_COST_CORRECTED 150 بطارية", keeps: ["150", "بطارية"] },
    { tag: "PARTY_CREATED", summary: "PARTY_CREATED CUSTOMER علي علي", keeps: ["علي علي", "زبون"] },
    { tag: "PARTY_UPDATED", summary: "PARTY_UPDATED SUPPLIER صالح بن علي", keeps: ["صالح بن علي", "مورّد"] },
    { tag: "PARTY_DELETED", summary: "PARTY_DELETED CUSTOMER عماره", keeps: ["عماره", "زبون"] },
    { tag: "STOCK_ADJUSTED", summary: "STOCK_ADJUSTED بطارية", keeps: ["بطارية"] },
    { tag: "STOCK_LINKED", summary: "STOCK_LINKED INV-1", keeps: ["INV-1"] },
    { tag: "PURCHASE_CORRECTED", summary: "PURCHASE_CORRECTED بطارية", keeps: ["بطارية"] },
    { tag: "SALE_CREATED", summary: "SALE_CREATED INV-2", keeps: ["INV-2"] },
    { tag: "PURCHASE_CREATED", summary: "PURCHASE_CREATED INV-7 شركة الأمل", keeps: ["INV-7", "شركة الأمل"] },
    { tag: "PAYMENT_RECORDED", summary: "PAYMENT_RECORDED 5000 INV-2", keeps: ["5000", "INV-2"] },
    { tag: "SUPPLIER_PAYMENT", summary: "SUPPLIER_PAYMENT 500 شركة الأمل", keeps: ["500", "شركة الأمل"] },
    { tag: "SUPPLIER_RETURN", summary: "SUPPLIER_RETURN PRT-1 300 شركة الأمل", keeps: ["PRT-1", "300", "شركة الأمل"] },
    { tag: "SUPPLIER_REFUND", summary: "SUPPLIER_REFUND 200 شركة الأمل", keeps: ["200", "شركة الأمل"] },
    { tag: "SUPPLIER_ADJUSTMENT", summary: "SUPPLIER_ADJUSTMENT WE_OWE 400 شركة الأمل", keeps: ["400", "شركة الأمل"] },
    { tag: "SUPPLIER_OPENING_BALANCE", summary: "SUPPLIER_OPENING_BALANCE THEY_OWE 100000 محمد بن علي", keeps: ["100000", "محمد بن علي"] },
    { tag: "EXPENSE_CATEGORY_CREATED", summary: "EXPENSE_CATEGORY_CREATED WITHDRAWAL سحوبات", keeps: ["سحوبات"] },
    { tag: "EXPENSE_RECORDED", summary: "EXPENSE_RECORDED 3000", keeps: ["3000"] },
    { tag: "SETTINGS_UPDATED", summary: "SETTINGS_UPDATED", keeps: [] },
    { tag: "BACKUP_CREATED", summary: "BACKUP_CREATED dokan-2035-06-01.db", keeps: ["dokan-2035-06-01.db"] },
    { tag: "DAILY_BACKUP", summary: "DAILY_BACKUP dokan-2035-06-01.db", keeps: ["dokan-2035-06-01.db"] },
    { tag: "PASSWORD_RESET", summary: "PASSWORD_RESET 0551234567", keeps: ["0551234567"] },
    { tag: "RETURN_RECORDED", summary: "RETURN_RECORDED RET-1 2000 INV-3 500", keeps: ["RET-1", "2000", "INV-3"] },
    { tag: "RETURN_REVIEWED", summary: "RETURN_REVIEWED RET-1 ACCEPTED 2000", keeps: ["RET-1", "2000"] },
    { tag: "VAULT_UNLOCK_FAILED", summary: "VAULT_UNLOCK_FAILED 2026-10-16T09:00:00", keeps: ["2026-10-16T09:00:00"] },
    { tag: "VAULT_RECOVERY_FAILED", summary: "VAULT_RECOVERY_FAILED 2026-10-16T09:00:00", keeps: ["2026-10-16T09:00:00"] },
    { tag: "VAULT_CHANGE_PASSPHRASE_FAILED", summary: "VAULT_CHANGE_PASSPHRASE_FAILED 2026-10-16T09:00:00", keeps: ["2026-10-16T09:00:00"] },
    { tag: "VAULT_RECOVERY_RESET_FAILED", summary: "VAULT_RECOVERY_RESET_FAILED 2026-10-16T09:00:00", keeps: ["2026-10-16T09:00:00"] },
  ];

  it("covers exactly the server's summary-tag vocabulary", () => {
    const covered = cases.map((entry) => entry.tag);
    // no duplicates, and the same set as the contract constant
    expect(new Set(covered).size).toBe(covered.length);
    expect([...covered].sort()).toEqual([...activitySummaryTags].sort());
  });

  for (const { summary, keeps } of cases) {
    it(`renders "${summary}" without leaking its tag`, () => {
      const tag = summary.split(" ")[0]!;
      const rendered = activitySummaryText(t, summary);

      expect(rendered).not.toContain(tag);
      for (const field of keeps) expect(rendered).toContain(field);
    });
  }

  it("acceptance: the opening-balance row is an Arabic sentence naming the supplier", () => {
    const rendered = activitySummaryText(t, "SUPPLIER_OPENING_BALANCE THEY_OWE 100000 محمد بن علي");

    expect(rendered).not.toContain("SUPPLIER_OPENING_BALANCE");
    expect(rendered).not.toContain("THEY_OWE");
    expect(rendered).toContain("رصيد افتتاحي");
    expect(rendered).toContain("محمد بن علي");
    expect(rendered).toContain("100000");
    // the direction word is the SAME key the supplier account screen uses, so
    // the two screens cannot disagree (#252 owns the label text)
    expect(rendered).toContain(t("supplierAdjustDirectionTheyOwe"));
  });

  it("renders both supplier-account directions distinctly", () => {
    const weOwe = activitySummaryText(t, "SUPPLIER_OPENING_BALANCE WE_OWE 100000 محمد");
    const theyOwe = activitySummaryText(t, "SUPPLIER_OPENING_BALANCE THEY_OWE 100000 محمد");

    expect(weOwe).not.toBe(theyOwe);
    expect(weOwe).toContain(t("supplierAdjustDirectionWeOwe"));
    expect(theyOwe).toContain(t("supplierAdjustDirectionTheyOwe"));
    // neither direction word is the raw token
    expect(weOwe).not.toContain("WE_OWE");
    expect(theyOwe).not.toContain("THEY_OWE");
  });

  it("gives every activity type a translated badge, never the raw enum", () => {
    for (const type of activityTypes) {
      const copy = t(`activityType_${type}`);
      expect(copy, `missing i18n key activityType_${type}`).not.toBe(`activityType_${type}`);
      expect(copy.trim().length, `empty copy for activityType_${type}`).toBeGreaterThan(0);
    }
  });

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

/**
 * #253 — the reference column printed `ref.slice(0, 8)`, an id the owner could
 * not act on. The tag (not the type) decides the target because several types
 * carry more than one tag with different refs.
 */
describe("activity reference links", () => {
  const item = { summary: "ITEM_CREATED بطارية", ref: "1111aaaa-2222" };
  const invoice = { summary: "SALE_CREATED INV-2", ref: "3333bbbb-4444" };
  const supplier = { summary: "SUPPLIER_PAYMENT 500 شركة الأمل", ref: "5555cccc-6666" };

  it("links an item row to its history", () => {
    expect(activityRefLink(item)).toEqual({ to: "/items/$itemId/history", params: { itemId: "1111aaaa-2222" } });
  });

  it("links an invoice row to the invoice", () => {
    expect(activityRefLink(invoice)).toEqual({ to: "/invoices/$invoiceId", params: { invoiceId: "3333bbbb-4444" } });
    // PAYMENT_RECORDED is an invoice payment; SUPPLIER_PAYMENT is not, even
    // though BOTH rows carry activity type PAYMENT_RECORDED
    expect(activityRefLink({ summary: "PAYMENT_RECORDED 5000 INV-2", ref: "3333bbbb-4444" })).toEqual({
      to: "/invoices/$invoiceId",
      params: { invoiceId: "3333bbbb-4444" },
    });
  });

  it("links the supplier-account rows to the supplier", () => {
    expect(activityRefLink(supplier)).toEqual({ to: "/suppliers/$partyId", params: { partyId: "5555cccc-6666" } });
    for (const summary of ["SUPPLIER_ADJUSTMENT THEY_OWE 100", "SUPPLIER_OPENING_BALANCE THEY_OWE 100000 محمد", "SUPPLIER_REFUND 20 شركة"]) {
      expect(activityRefLink({ summary, ref: "5555cccc-6666" })).toEqual({ to: "/suppliers/$partyId", params: { partyId: "5555cccc-6666" } });
    }
  });

  it("sends a party row to the route named by its role token", () => {
    expect(activityRefLink({ summary: "PARTY_CREATED SUPPLIER صالح", ref: "7777dddd" })).toEqual({ to: "/suppliers/$partyId", params: { partyId: "7777dddd" } });
    expect(activityRefLink({ summary: "PARTY_DELETED CUSTOMER عماره", ref: "8888eeee" })).toEqual({ to: "/customers/$partyId", params: { partyId: "8888eeee" } });
  });

  it("does not link a type whose ref has no detail screen", () => {
    // SUPPLIER_RETURN's ref is a supplier-RETURN id (router.ts:923), not the
    // supplier; RETURN_RECORDED/EXPENSE_RECORDED have no standalone detail route
    for (const summary of ["SUPPLIER_RETURN PRT-1 300 شركة", "RETURN_RECORDED RET-1 2000 INV-3 0", "EXPENSE_RECORDED 3000", "SETTINGS_UPDATED", "BACKUP_CREATED dokan.db"]) {
      expect(activityRefLink({ summary, ref: "9999ffff" })).toBeNull();
    }
  });

  it("has no target without a ref", () => {
    expect(activityRefLink({ summary: "STORE_SETUP دكان", ref: null })).toBeNull();
    expect(activityRefLink({ summary: "STORE_SETUP دكان", ref: "" })).toBeNull();
  });
});
