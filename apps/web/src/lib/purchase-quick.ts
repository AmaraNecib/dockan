import type { QuickAddSpec } from "./use-invoice-draft";

/**
 * The purchase quick-add form's field bag, in one place so its TYPE and its empty
 * value cannot disagree with the dirty rule that reads them (#345 review).
 *
 * `purchaseCartDirty` decides "is any of this work?" by reading these fields, and
 * its test enumerates `Object.keys(PURCHASE_QUICK.empty())`. That is the point of
 * this module: adding a field to the form makes the test's enumeration grow, so a
 * new field fails the suite until it is either counted as work or listed as a
 * documented exclusion. A field that only exists in the page would be invisible.
 */
export type PurchaseQuickFields = {
  name: string;
  barcode: string;
  categoryId: string;
  sellPrice: string;
  threshold: string;
  qty: string;
  unitCost: string;
};

/** Fields that are never blank on an untouched form, so they cannot signal work. */
export const PURCHASE_QUICK_NOT_WORK: readonly (keyof PurchaseQuickFields)[] = [
  // the form opens at 1, and a quantity of 1 is not work the owner typed
  "qty",
];

/** The quick-add field bag; purchase keeps what is typed across a close. */
export const PURCHASE_QUICK = {
  empty: (): PurchaseQuickFields => ({
    name: "",
    barcode: "",
    categoryId: "",
    sellPrice: "",
    threshold: "",
    qty: "1",
    unitCost: "",
  }),
  resetOnOpen: false,
  // the owner stocks several items in one sitting, so a successful create keeps
  // the destination category. The old handler cleared the item fields and kept
  // quickCategoryId for the same reason.
  keepOnCreate: ["categoryId"],
} satisfies QuickAddSpec<PurchaseQuickFields>;
