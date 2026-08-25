import { z } from "zod";

import { isValidAlgerianPhone } from "./phone";

/**
 * Dokan domain schemas — the single source of truth for every API
 * request and response shape. The database mirrors these.
 *
 * Conventions (see docs/adr):
 * - Money is whole Algerian Dinars (integers) — no float arithmetic.
 * - Timestamps are local Algeria time strings ("YYYY-MM-DD" for dates,
 *   "YYYY-MM-DDTHH:mm:ss" for moments). No UTC anywhere; local-first app.
 */

export const idSchema = z.string().uuid();
/** Whole-DA money. Capped at the max safe integer so any persisted sum can
 * never drift into float-inexact territory (2⁵³+ round-trips differently). */
export const dinarsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD (Algeria local time)");
export const localDateTimeSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
  "expected YYYY-MM-DDTHH:mm:ss (Algeria local time)",
);

// Enum value tuples are the single source of truth; the zod schemas below are
// built from them so the api's drizzle schema can import the same literals.
export const invoiceKinds = ["SALE", "PURCHASE"] as const;
export const paymentMethods = ["CASH", "BANK"] as const;
/** append-only stock ledger movement kinds (ticket 27) */
export const movementKinds = ["PURCHASE", "SALE", "MANUAL_ADJUSTMENT"] as const;
export const activityTypes = [
  "LOGIN",
  "PASSWORD_RESET",
  "CATEGORY_CREATED",
  "ITEM_CREATED",
  "ITEM_UPDATED",
  "PARTY_CREATED",
  "SALE_CREATED",
  "PURCHASE_CREATED",
  "PAYMENT_RECORDED",
  "BACKUP_CREATED",
  "STOCK_ADJUSTED",
  "SETTINGS_UPDATED",
  "EXPENSE_RECORDED",
  "EXPENSE_CATEGORY_CREATED",
] as const;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * Loose normalized ASCII barcode: printable ASCII, no whitespace, 3..64 chars.
 * Loose on purpose — EAN, Code39, QR payloads and shop-made codes must fit;
 * strict checksums are the scanner's job, not the schema's.
 */
export const barcodeSchema = z
  .string()
  .trim()
  .regex(/^[\x21-\x7E]{3,64}$/, "expected a printable ASCII barcode");

/**
 * One barcode normalization for api + web: NFC, strip zero-width/soft-hyphen
 * junk, uppercase, remove inner spaces. Arabic/IME output can never masquerade
 * as a barcode — it fails the ASCII check instead of storing mojibake.
 * Returns null when the result is not a valid barcode.
 */
export function normalizeBarcode(raw: string): string | null {
  const cleaned = raw
    .normalize("NFC")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\u00AD]/g, "")
    .toUpperCase()
    .replace(/\s+/g, "");
  return /^[\x21-\x7E]{3,64}$/.test(cleaned) ? cleaned : null;
}

/**
 * Text search key for names/categories: NFC, lowercase, collapse whitespace,
 * strip tatweel and Arabic diacritics so "بَطّارية" matches "بطارية".
 */
export function normalizeTextKey(raw: string): string {
  return raw
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u0640\u064B-\u0652\u0670]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const categorySchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1),
  createdAt: localDateTimeSchema,
  updatedAt: localDateTimeSchema,
});

export const itemSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1),
  /** loose normalized ASCII barcode; null = uncoded item (ticket 28) */
  barcode: barcodeSchema.nullable(),
  categoryId: idSchema,
  /** what the owner pays per unit, in DA */
  costPrice: dinarsSchema,
  /** what the customer pays per unit, in DA */
  sellingPrice: dinarsSchema,
  /** when stockOnHand drops to this, the item appears in the low-stock list */
  lowStockThreshold: z.number().int().min(0),
  /** available quantity, maintained transactionally with movements */
  stockOnHand: z.number().int().min(0),
  createdAt: localDateTimeSchema,
  updatedAt: localDateTimeSchema,
});

export const customerSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1),
  phone: z.string().trim().nullable(),
  createdAt: localDateTimeSchema,
});

export const supplierSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1),
  phone: z.string().trim().nullable(),
  createdAt: localDateTimeSchema,
});

/** SALE = the customer owes the shop; PURCHASE = the shop owes the supplier. */
export const invoiceKindSchema = z.enum(invoiceKinds);

/** A negotiated line price can be entered as a final amount or as a percentage
 * of the item's price at the time the sale is recorded. */
export const priceOverrideTypeSchema = z.enum(["AMOUNT", "PERCENTAGE"]);
export const priceOverrideSchema = z
  .object({
    type: priceOverrideTypeSchema,
    /** all persisted price adjustments are whole DZD / percentage points */
    value: z.number().int().min(0),
  })
  .superRefine((value, ctx) => {
    // .int() above already guarantees integer values; only the domain
    // bound on percentages is checked here.
    if (value.type === "PERCENTAGE" && value.value > 100) {
      ctx.addIssue({ code: "too_big", maximum: 100, origin: "number", path: ["value"] });
    }
  });

/** Invoice-level discount input and its persisted type. */
export const discountTypeSchema = z.enum(["AMOUNT", "PERCENTAGE"]);
/** Persisted value is an integer; percentages are whole percentage points. */
export const discountValueSchema = z.number().int().min(0);
export const invoiceDiscountSchema = z
  .object({
    type: discountTypeSchema,
    /** all persisted discount values are whole DZD / percentage points */
    value: z.number().int().min(0),
  })
  .superRefine((value, ctx) => {
    // .int() above already guarantees integer values; only the domain
    // bound on percentages is checked here.
    if (value.type === "PERCENTAGE" && value.value > 100) {
      ctx.addIssue({ code: "too_big", maximum: 100, origin: "number", path: ["value"] });
    }
  });

export const invoiceLineSchema = z.object({
  id: idSchema,
  invoiceId: idSchema,
  itemId: idSchema.nullable(),
  /** snapshot of the item name at sale time */
  description: z.string(),
  quantity: z.number().int().positive(),
  /** item's default price at checkout time (historical, never recomputed) */
  defaultUnitPrice: dinarsSchema,
  /** actual negotiated price used on this invoice (historical) */
  unitPrice: dinarsSchema,
  /** snapshot of the FIFO cost consumed by this line */
  costAtSale: dinarsSchema,
  /** gross line total before the invoice-level discount */
  total: dinarsSchema,
  /** proportional share of the invoice discount for item reporting */
  discountAllocated: dinarsSchema,
  /** gross line total less its internally allocated invoice discount */
  netTotal: dinarsSchema,
});

export const invoiceSchema = z.object({
  id: idSchema,
  /** auto-suggested (INV-0001) but editable, unique */
  invoiceNumber: z.string().min(1),
  kind: invoiceKindSchema,
  /** known party from the customers/suppliers lists, when used */
  counterpartyId: idSchema.nullable(),
  /** typed-in name when the owner does not want to create/choose a party ("give him a name or not") */
  counterpartyName: z.string().trim().min(1).nullable(),
  invoiceDate: localDateSchema,
  /** subtotal after line prices and before invoice discount */
  subtotalAmount: dinarsSchema,
  /** requested discount type/value, null when no discount was entered */
  discountType: discountTypeSchema.nullable(),
  discountValue: discountValueSchema.nullable(),
  /** applied discount, capped at subtotal and rounded to whole DZD */
  discountAmount: dinarsSchema,
  /** final amount after invoice discount */
  totalAmount: dinarsSchema,
  paidAmount: dinarsSchema,
  remainingAmount: dinarsSchema,
  notes: z.string().nullable(),
  createdAt: localDateTimeSchema,
  updatedAt: localDateTimeSchema,
});

export const paymentMethodSchema = z.enum(paymentMethods);

export const paymentSchema = z.object({
  id: idSchema,
  invoiceId: idSchema,
  amount: dinarsSchema.refine((v) => v > 0, "a payment must be positive"),
  method: paymentMethodSchema,
  note: z.string().nullable(),
  paidAt: localDateTimeSchema,
  createdAt: localDateTimeSchema,
});

export const activityTypeSchema = z.enum(activityTypes);

export const movementKindSchema = z.enum(movementKinds);

/** One append-only ledger row (ticket 27). Raw fact — never rewritten. */
export const stockMovementSchema = z.object({
  id: idSchema,
  itemId: idSchema,
  kind: movementKindSchema,
  /** signed quantity: positive = stock in, negative = stock out */
  delta: z.number().int(),
  /** per-unit cost of an inflow; null for outflows */
  unitCost: dinarsSchema.nullable(),
  reason: z.string().nullable(),
  /** linked invoice id when the movement originates from one */
  ref: z.string().nullable(),
  occurredAt: localDateTimeSchema,
  createdAt: localDateTimeSchema,
});

export const stockMovementWithBalanceSchema = stockMovementSchema.extend({
  /** derived remaining stock right after this movement (FIFO projection) */
  stockAfter: z.number().int().min(0),
});

export const activitySchema = z.object({
  id: idSchema,
  at: localDateTimeSchema,
  type: activityTypeSchema,
  summary: z.string(),
  ref: z.string().nullable(),
});

export const settingsSchema = z.object({
  storeName: z.string().trim().min(1),
  storePhone: z.string().trim().nullable(),
});

// ---------------------------------------------------------------------------
// Expenses and profit reports (ticket 31)
// ---------------------------------------------------------------------------

/**
 * Expense category. `isOwnerWithdrawal` marks owner cash-outs (سحوبات المالك)
 * so the profit report separates operating expenses from rich-taking — matched
 * by attribute, never by name. One flagged category is seeded by default.
 */
export const expenseCategorySchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1),
  isOwnerWithdrawal: z.boolean(),
  createdAt: localDateTimeSchema,
  updatedAt: localDateTimeSchema,
});

/**
 * One raw expense record (تسجيل مصروف). Append-only by design: the profit
 * report derives every figure from these rows plus SALE invoice lines, so
 * nothing is ever stored as a fragile precomputed total. Amounts are capped
 * far below MAX_SAFE_INTEGER so report sums stay exact whole-DZD integers.
 */
export const expenseSchema = z.object({
  id: idSchema,
  categoryId: idSchema,
  /** whole dinars; must be positive — a zero-DZD expense is a no-op record */
  amount: z.number().int().positive().max(1_000_000_000_000),
  /** mirror of the input cap so persisted and returned shapes agree */
  note: z.string().max(500).nullable(),
  /** Algeria-local moment of the expense (editable for backdating) */
  occurredAt: localDateTimeSchema,
  createdAt: localDateTimeSchema,
});

/** Flexible report windows, computed in Algeria local time (ticket 31). */
export const reportRangePresets = [
  "24H",
  "7D",
  "28D",
  "30D",
  "CURRENT_MONTH",
  "3M",
  "6M",
  "CURRENT_YEAR",
  "LAST_YEAR",
  "CUSTOM",
] as const;

export const reportRangePresetSchema = z.enum(reportRangePresets);

/**
 * Report window selection. `CUSTOM` requires both `customFrom` and `customTo`;
 * other presets ignore them (the api computes the window in Algeria local
 * time — see apps/api/src/lib/report-ranges.ts). Both bounds are inclusive.
 */
export const profitReportInputSchema = z.object({
  preset: reportRangePresetSchema,
  customFrom: localDateTimeSchema.optional(),
  customTo: localDateTimeSchema.optional(),
});

/** One category's raw expense sum inside the report window. */
export const expenseCategoryTotalSchema = z.object({
  categoryId: idSchema,
  categoryName: z.string(),
  isOwnerWithdrawal: z.boolean(),
  total: z.number().int().min(0),
  count: z.number().int().min(0),
});

/**
 * Profit report the ui renders: revenue/COGS/gross profit, then operating
 * expenses and owner withdrawals separately, then the result after expenses.
 * Every figure is summed at read time from raw SALE invoice lines (netTotal,
 * costAtSale) and expense rows inside the window — nothing is precomputed.
 */
export const profitReportOutputSchema = z.object({
  range: z.object({ preset: reportRangePresetSchema, from: localDateTimeSchema, to: localDateTimeSchema }),
  revenue: z.number().int().min(0),
  cogs: z.number().int().min(0),
  grossProfit: z.number().int(),
  operatingExpenses: z.number().int().min(0),
  ownerWithdrawals: z.number().int().min(0),
  resultAfterExpenses: z.number().int(),
  byCategory: z.array(expenseCategoryTotalSchema),
});

export const debtSummarySchema = z.object({
  /** null when the invoice carries only a typed-in name */
  counterpartyId: idSchema.nullable(),
  counterpartyName: z.string().nullable(),
  kind: invoiceKindSchema,
  remainingTotal: dinarsSchema,
  invoiceCount: z.number().int().min(0),
  oldestInvoiceDate: localDateSchema.nullable(),
  latestInvoiceDate: localDateSchema.nullable(),
});

export const invoiceDetailSchema = invoiceSchema.extend({
  lines: z.array(invoiceLineSchema),
  payments: z.array(paymentSchema),
});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const resetPasswordInputSchema = z.object({
  /** the build secret baked into the app; entering it lets the owner set a new password */
  secret: z.string().min(1),
  newPassword: z.string().min(4),
  /** the owner's Algerian mobile; becomes the login name after +213 normalization */
  phoneNumber: z.string().refine(isValidAlgerianPhone, "expected an Algerian mobile, e.g. +213550123123 or 0550123123"),
});

export const categoryCreateInputSchema = z.object({
  name: z.string().trim().min(1),
});

export const itemCreateInputSchema = z.object({
  name: z.string().trim().min(1),
  categoryId: idSchema,
  costPrice: dinarsSchema,
  sellingPrice: dinarsSchema,
  lowStockThreshold: z.number().int().min(0).optional(),
  barcode: barcodeSchema.optional(),
});

/** create item + initial stock in one unit (unknown-scan "create with stock") */
export const itemCreateWithStockInputSchema = itemCreateInputSchema.extend({
  stockOnHand: z.number().int().min(1),
});

export const itemUpdateInputSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).optional(),
  categoryId: idSchema.optional(),
  costPrice: dinarsSchema.optional(),
  sellingPrice: dinarsSchema.optional(),
  lowStockThreshold: z.number().int().min(0).optional(),
  /** null clears the barcode */
  barcode: barcodeSchema.nullable().optional(),
});

export const catalogSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(128),
  limit: z.number().int().min(1).max(50).optional(),
});

export const catalogMatchKindSchema = z.enum(["BARCODE_EXACT", "BARCODE_PARTIAL", "NAME", "CATEGORY"]);

export const catalogMatchSchema = z.object({
  item: itemSchema,
  category: categorySchema.nullable(),
  matchedBy: catalogMatchKindSchema,
});

export const catalogSearchOutputSchema = z.object({
  /** the single exact-barcode hit when one exists; ui adds it immediately */
  exact: catalogMatchSchema.nullable(),
  /** selectable results, ranked: partial-barcode > name > category */
  matches: z.array(catalogMatchSchema),
});

export const partyCreateInputSchema = z.object({
  name: z.string().trim().min(1),
  phone: z.string().trim().optional(),
});

export const invoiceLineInputSchema = z.object({
  itemId: idSchema,
  /** capped so quantity × price never approaches Number.MAX_SAFE_INTEGER */
  quantity: z.number().int().positive().max(1_000_000),
  /** explicit final price; omitted lines use the item's current kind-specific default */
  unitPrice: dinarsSchema.optional(),
  /** optional negotiated price entry; rejected when unitPrice is also supplied */
  priceOverride: priceOverrideSchema.optional(),
  /** flat aliases keep form integrations simple while the object is canonical */
  priceOverrideType: priceOverrideTypeSchema.optional(),
  priceOverrideValue: z.number().int().min(0).optional(),
});

export const invoiceCreateInputSchema = z
  .object({
    kind: invoiceKindSchema,
    counterpartyId: idSchema.nullable().optional(),
    /** typed-in name, mutually optional with counterpartyId */
    counterpartyName: z.string().trim().min(1).nullable().optional(),
    invoiceDate: localDateSchema.optional(),
    notes: z.string().nullable().optional(),
    lines: z.array(invoiceLineInputSchema).min(1),
    /** optional invoice-level amount or percentage discount */
    discount: invoiceDiscountSchema.optional(),
    /** flat aliases for clients that keep separate form fields */
    discountType: discountTypeSchema.optional(),
    discountValue: z.number().int().min(0).optional(),
    /** cash paid at invoice time; the rest becomes the debt (remainingAmount) */
    initialPaid: dinarsSchema.refine((v) => v > 0, "must be a positive amount").optional(),
    paymentMethod: paymentMethodSchema.optional(),
  })
  .superRefine((input, ctx) => {
    const hasType = input.discountType !== undefined;
    const hasValue = input.discountValue !== undefined;
    if (hasType !== hasValue) {
      ctx.addIssue({ code: "custom", message: "discountType and discountValue must be supplied together", path: [hasType ? "discountValue" : "discountType"] });
    }
    // .int() on the fields already guarantees integers; only bounds are checked here.
    if (input.discountType === "PERCENTAGE" && (input.discountValue ?? 0) > 100) {
      ctx.addIssue({ code: "too_big", maximum: 100, origin: "number", path: ["discountValue"] });
    }
    if (input.discount !== undefined && hasType && hasValue && (input.discount.type !== input.discountType || input.discount.value !== input.discountValue)) {
      ctx.addIssue({ code: "custom", message: "conflicting discount inputs", path: ["discount"] });
    }
    for (const [index, line] of input.lines.entries()) {
      const hasOverrideType = line.priceOverrideType !== undefined;
      const hasOverrideValue = line.priceOverrideValue !== undefined;
      if (hasOverrideType !== hasOverrideValue) {
        ctx.addIssue({ code: "custom", message: "priceOverrideType and priceOverrideValue must be supplied together", path: ["lines", index, hasOverrideType ? "priceOverrideValue" : "priceOverrideType"] });
      }
      if (line.priceOverrideType === "PERCENTAGE" && (line.priceOverrideValue ?? 0) > 100) {
        ctx.addIssue({ code: "too_big", maximum: 100, origin: "number", path: ["lines", index, "priceOverrideValue"] });
      }
      if (line.priceOverride !== undefined && hasOverrideType && hasOverrideValue && (line.priceOverride.type !== line.priceOverrideType || line.priceOverride.value !== line.priceOverrideValue)) {
        ctx.addIssue({ code: "custom", message: "conflicting price override inputs", path: ["lines", index, "priceOverride"] });
      }
      // One negotiated-price path per line: an explicit unitPrice and an
      // override would silently disagree about which one the shop actually
      // billed, so the pair is rejected like the discount aliases above.
      const hasPriceOverride = line.priceOverride !== undefined || hasOverrideType || hasOverrideValue;
      if (line.unitPrice !== undefined && hasPriceOverride) {
        ctx.addIssue({ code: "custom", message: "unitPrice cannot be combined with a price override", path: ["lines", index, "unitPrice"] });
      }
      // Purchase lines price the stock cost basis, not a negotiated sale price.
      if (input.kind === "PURCHASE" && hasPriceOverride) {
        ctx.addIssue({ code: "custom", message: "price override is sale-only", path: ["lines", index, "priceOverride"] });
      }
    }
  });

export const invoicePayInputSchema = z.object({
  invoiceId: idSchema,
  amount: dinarsSchema.refine((v) => v > 0, "must be a positive amount"),
  method: paymentMethodSchema.optional(),
  note: z.string().nullable().optional(),
});

export const invoiceListInputSchema = z.object({
  kind: invoiceKindSchema.optional(),
  /** UNPAID | PARTIAL | PAID — derived from remainingAmount */
  status: z.enum(["UNPAID", "PARTIAL", "PAID"]).optional(),
  fromDate: localDateSchema.optional(),
  toDate: localDateSchema.optional(),
});

export const activityListInputSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});

export const logsTailInputSchema = z.object({
  lines: z.number().int().min(1).max(500).optional(),
});

export const settingsUpdateInputSchema = z.object({
  storeName: z.string().trim().min(1).optional(),
  storePhone: z.string().trim().nullable().optional(),
});

export const stockAddManualInputSchema = z.object({
  itemId: idSchema,
  /** signed; nonzero; magnitude-capped so sqlite INTEGER + JS number stay exact */
  delta: z.number().int().refine((v) => v !== 0 && Math.abs(v) <= 1_000_000, "delta must be a nonzero integer within ±1,000,000"),
  unitCost: dinarsSchema.optional(),
  reason: z.string().trim().optional(),
  /** Algeria-local moment; defaults to now at the api */
  occurredAt: localDateTimeSchema.optional(),
  /** PURCHASE = stock-in without an invoice (ticket 29); defaults to a plain adjustment */
  kind: z.enum(["PURCHASE", "MANUAL_ADJUSTMENT"]).default("MANUAL_ADJUSTMENT"),
});

export const expenseCategoryCreateInputSchema = z.object({
  name: z.string().trim().min(1),
  /** mark this category as owner withdrawals (سحوبات المالك) */
  isOwnerWithdrawal: z.boolean().optional(),
});

export const expenseCreateInputSchema = z.object({
  categoryId: idSchema,
  /** same cap as the entity so an absurd input can never threaten 2^53 sums */
  amount: z.number().int().positive().max(1_000_000_000_000),
  note: z.string().trim().max(500).nullable().optional(),
  /** Algeria-local moment; defaults to now at the api */
  occurredAt: localDateTimeSchema.optional(),
});

export const expenseListInputSchema = z.object({
  /** empty/absent = all categories (a record never escapes every filter) */
  categoryIds: z.array(idSchema).max(100).optional(),
  /** window preset, resolved in Algeria local time at the api (same math as
   * the profit report). When absent and no from/to bounds are sent, the
   * window defaults to the current month. */
  preset: reportRangePresetSchema.optional(),
  /** required together when preset = CUSTOM */
  customFrom: localDateTimeSchema.optional(),
  customTo: localDateTimeSchema.optional(),
  /** inclusive local-datetime bounds; an alternative to a preset */
  from: localDateTimeSchema.optional(),
  to: localDateTimeSchema.optional(),
  sortBy: z.enum(["occurredAt", "amount"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

export const expenseListOutputSchema = z.object({
  items: z.array(expenseSchema),
});

// --- purchase intake (ticket 29) -------------------------------------------

export const purchaseAllocationSchema = z.object({
  itemId: idSchema,
  quantity: z.number().int().positive(),
});
export const purchasesLinkStockInputSchema = z.object({
  invoiceId: idSchema,
  allocations: z.array(purchaseAllocationSchema).min(1),
});

export const purchasesLinkStockOutputSchema = z.object({
  /** total quantity attributed to earlier uninvoiced movements */
  linked: z.number().int().min(0),
  /** allocation share not matched to earlier uninvoiced stock — already
   * covered by the invoice's own posting, so no movement is created */
  remainderMoved: z.number().int().min(0),
});

export const purchasesProposalOutputSchema = z.object({
  invoiceId: idSchema,
  items: z.array(
    z.object({
      itemId: idSchema,
      itemName: z.string(),
      lineQuantity: z.number().int().min(0),
      uninvoicedQty: z.number().int().min(0),
      proposedLinkQty: z.number().int().min(0),
      remainderQty: z.number().int().min(0),
    }),
  ),
});

export const purchasesCorrectLineInputSchema = z.object({
  lineId: idSchema,
  quantity: z.number().int().positive(),
  unitCost: dinarsSchema,
});

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export const healthOutputSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
});

export const resetPasswordOutputSchema = z.object({
  ok: z.literal(true),
});

export const entityListOutputSchema = z.object({
  items: z.array(z.unknown()),
});

export const invoiceListOutputSchema = z.object({
  items: z.array(invoiceSchema),
  totalCount: z.number().int().min(0),
});

export const itemHistoryOutputSchema = z.object({
  movements: z.array(stockMovementWithBalanceSchema),
  stockOnHand: z.number().int().min(0),
});

export const debtsOutputSchema = z.object({
  /** customers who owe the shop */
  owedToUs: z.array(debtSummarySchema),
  /** suppliers the shop owes */
  weOwe: z.array(debtSummarySchema),
});

export const debtsByPartyInputSchema = z
  .object({
    kind: invoiceKindSchema,
    /** exactly the summary's party identity: id when known, null for typed-only */
    counterpartyId: idSchema.nullable(),
    /** typed name; null only when the party is id-backed */
    counterpartyName: z.string().trim().min(1).nullable(),
  })
  .refine((v) => v.counterpartyId !== null || v.counterpartyName !== null, {
    message: "a debts group always has a known id or a typed name",
    // NOTE: when an id IS supplied it is authoritative — the store matches
    // on it and the name only labels the request (id-over-name identity,
    // same as debtSummaries' grouping key), so a mismatched name can never
    // re-route invoices to another party.
  });

export const lowStockOutputSchema = z.object({
  items: z.array(itemSchema),
});

export const activityListOutputSchema = z.object({
  items: z.array(activitySchema),
});

export const logsTailOutputSchema = z.object({
  file: z.string(),
  lines: z.array(z.string()),
});

export const backupManualOutputSchema = z.object({
  path: z.string(),
  createdAt: localDateTimeSchema,
});

// ---------------------------------------------------------------------------
// Types (z.infer) — the API and web import these, never z directly.
// ---------------------------------------------------------------------------

export type Category = z.infer<typeof categorySchema>;
export type Item = z.infer<typeof itemSchema>;
export type Customer = z.infer<typeof customerSchema>;
export type Supplier = z.infer<typeof supplierSchema>;
export type InvoiceKind = z.infer<typeof invoiceKindSchema>;
export type PriceOverride = z.infer<typeof priceOverrideSchema>;
export type DiscountType = z.infer<typeof discountTypeSchema>;
export type DiscountValue = z.infer<typeof discountValueSchema>;
export type InvoiceDiscount = z.infer<typeof invoiceDiscountSchema>;
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;
export type Invoice = z.infer<typeof invoiceSchema>;
export type InvoiceDetail = z.infer<typeof invoiceDetailSchema>;
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type Activity = z.infer<typeof activitySchema>;
export type ActivityType = z.infer<typeof activityTypeSchema>;
export type MovementKind = z.infer<typeof movementKindSchema>;
export type StockMovement = z.infer<typeof stockMovementSchema>;
export type StockMovementWithBalance = z.infer<typeof stockMovementWithBalanceSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type DebtSummary = z.infer<typeof debtSummarySchema>;
export type ExpenseCategory = z.infer<typeof expenseCategorySchema>;
export type Expense = z.infer<typeof expenseSchema>;
export type ReportRangePreset = z.infer<typeof reportRangePresetSchema>;
export type ExpenseCategoryTotal = z.infer<typeof expenseCategoryTotalSchema>;
export type ProfitReport = z.infer<typeof profitReportOutputSchema>;

export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>;
export type CatalogSearchInput = z.infer<typeof catalogSearchInputSchema>;
export type CatalogMatchKind = z.infer<typeof catalogMatchKindSchema>;
export type CatalogMatch = z.infer<typeof catalogMatchSchema>;

export type ItemCreate = z.infer<typeof itemCreateInputSchema>;
export type ItemUpdate = z.infer<typeof itemUpdateInputSchema>;
export type PartyCreate = z.infer<typeof partyCreateInputSchema>;
export type InvoiceCreate = z.infer<typeof invoiceCreateInputSchema>;
export type InvoicePay = z.infer<typeof invoicePayInputSchema>;
export type InvoiceListFilters = z.infer<typeof invoiceListInputSchema>;
export type ActivityListFilters = z.infer<typeof activityListInputSchema>;
export type SettingsUpdate = z.infer<typeof settingsUpdateInputSchema>;
export type PurchaseAllocation = z.infer<typeof purchaseAllocationSchema>;
export type ExpenseCategoryCreate = z.infer<typeof expenseCategoryCreateInputSchema>;
export type ExpenseCreate = z.infer<typeof expenseCreateInputSchema>;
export type ExpenseListFilters = z.infer<typeof expenseListInputSchema>;
export type ProfitReportInput = z.infer<typeof profitReportInputSchema>;