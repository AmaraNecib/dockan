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
/** cash refunds today; credit / debt-credit land as later values without a migration */
export const returnPayoutMethods = ["CASH"] as const;
/** review tag on a return-originated stock movement: created pending, consumed by review */
export const returnMarks = ["PENDING", "ACCEPTED", "REJECTED"] as const;
export const returnStatuses = ["PENDING_REVIEW", "ACCEPTED", "REJECTED_DAMAGED"] as const;
/** append-only stock ledger movement kinds (ticket 27) */
export const movementKinds = ["PURCHASE", "SALE", "MANUAL_ADJUSTMENT"] as const;
export const activityTypes = [
  "LOGIN",
  "PASSWORD_RESET",
  "STORE_SETUP",
  "CATEGORY_CREATED",
  "ITEM_CREATED",
  "ITEM_UPDATED",
  "ITEM_COST_CORRECTED",
  "PARTY_CREATED",
  "PARTY_UPDATED",
  "PARTY_DELETED",
  "SALE_CREATED",
  "PURCHASE_CREATED",
  "PAYMENT_RECORDED",
  "BACKUP_CREATED",
  "STOCK_ADJUSTED",
  "RETURN_RECORDED",
  "RETURN_REVIEWED",
  "ADJUSTMENT_RECORDED",
  "SETTINGS_UPDATED",
  "EXPENSE_RECORDED",
  "EXPENSE_CATEGORY_CREATED",
  "VAULT_UNLOCK_FAILED",
] as const;

/**
 * The first token of every activity `summary` the api writes. The api stays
 * locale-neutral and stores a stable ASCII tag plus positional data fields,
 * with the single free-text field (a name, invoice number or filename) always
 * last so embedded spaces survive the split.
 *
 * The web page owns the Arabic copy and has one branch per tag. This list is
 * the one source both sides enumerate: `activity.test.tsx` (web) asserts every
 * member has a branch, and `activity-tags.test.ts` (api) asserts every tag the
 * emit sites write is a member — so a new activity type cannot ship with a raw
 * key in the audit log (#253).
 *
 * The four VAULT_* entries are written by `VaultManager.recordFailure(event)`
 * (`summary: `${event} ${timestamp}``), not by a literal template, so the api
 * scan proves them only indirectly (via the web enumeration).
 */
export const activitySummaryTags = [
  "STORE_SETUP",
  "CATEGORY_CREATED",
  "ITEM_CREATED",
  "ITEM_CREATED_WITH_STOCK",
  "ITEM_UPDATED",
  "ITEM_COST_CORRECTED",
  "STOCK_ADJUSTED",
  "STOCK_LINKED",
  "PURCHASE_CORRECTED",
  "PARTY_CREATED",
  "PARTY_UPDATED",
  "PARTY_DELETED",
  "SALE_CREATED",
  "PURCHASE_CREATED",
  "PAYMENT_RECORDED",
  "SUPPLIER_PAYMENT",
  "SUPPLIER_RETURN",
  "SUPPLIER_REFUND",
  "SUPPLIER_ADJUSTMENT",
  "SUPPLIER_OPENING_BALANCE",
  "RETURN_RECORDED",
  "RETURN_REVIEWED",
  "EXPENSE_CATEGORY_CREATED",
  "EXPENSE_RECORDED",
  "SETTINGS_UPDATED",
  "BACKUP_CREATED",
  "DAILY_BACKUP",
  "PASSWORD_RESET",
  "VAULT_UNLOCK_FAILED",
  "VAULT_RECOVERY_FAILED",
  "VAULT_CHANGE_PASSPHRASE_FAILED",
  "VAULT_RECOVERY_RESET_FAILED",
  "VAULT_SETUP_RESUME_FAILED",
] as const;

export type ActivitySummaryTag = (typeof activitySummaryTags)[number];

/**
 * Every event code the api can write to the daily JSONL (`logger.info(event,
 * message, ctx)` and the two event-carrying helpers `recordFailure(event)` /
 * `rotateSession(event)`).
 *
 * Not an RPC shape: it is the shared vocabulary between the api's log call
 * sites and the diagnostics viewer (#253), which renders `logEvent_<code>`
 * instead of the raw English badge. `log-events.test.ts` (api) asserts the emit
 * sites stay inside this set; `log-copy.test.ts` (web) asserts every member has
 * Arabic copy. An unknown code still renders raw, so nothing is dropped.
 */
export const logEvents = [
  "FIRST_TIME_SETUP",
  "SETUP_LOCKED",
  "RPC_ERROR",
  "SERVER_BOOT_DONE",
  "SERVER_STARTED",
  "SERVER_ERROR",
  "SNAPSHOT_PERSIST_FAILED",
  "SESSION_SECRET_REGENERATED",
  "DASHBOARD_SECTION_FAILED",
  "WEB_UI_SERVE_FAILED",
  "VAULT_DISABLED",
  "VAULT_CREATED",
  "VAULT_UNLOCKED",
  "VAULT_RECOVERY_UNLOCKED",
  "VAULT_SETUP_DONE",
  "VAULT_SETUP_FAILED",
  "VAULT_SETUP_BACKUP_FAILED",
  "VAULT_SETUP_CLEANUP_FAILED",
  "VAULT_BACKUP_REFRESH_FAILED",
  "VAULT_PLAINTEXT_REMAINS",
  "VAULT_LOCK_FAILED",
  "VAULT_LOCK_LOST",
  "VAULT_LOCK_RECLAIM_RACED",
  "VAULT_LOCK_RECLAIMED",
  "VAULT_ATTEMPT_FAILED",
  "VAULT_STATE_RESET",
  "VAULT_OPT_OUT_IGNORED",
  "VAULT_PASSPHRASE_CHANGED",
  "VAULT_PASSPHRASE_RESET",
  "VAULT_RECOVERY_KEY_REMOVED",
  "VAULT_UNLOCK_FAILED",
  "VAULT_RECOVERY_FAILED",
  "VAULT_CHANGE_PASSPHRASE_FAILED",
  "VAULT_RECOVERY_RESET_FAILED",
  "VAULT_SESSION_REVOKED",
  "VAULT_LEGACY_PLAINTEXT_REMOVED",
  "VAULT_LEGACY_PLAINTEXT_STAYED",
  "VAULT_LEGACY_BACKUP_ENCRYPTED",
  "VAULT_LEGACY_BACKUP_STAYED",
] as const;

export type LogEvent = (typeof logEvents)[number];

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
    // bidi/zero-width controls pasted from Arabic-first UIs (including U+061C
    // ARABIC LETTER MARK); `\s` does not match them, so they must be stripped
    // or the same name becomes two keys
    .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
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

/**
 * A party (زبون / مورّد). Customers and suppliers are the same record shape;
 * the role picks the table. The two named aliases stay because the contract
 * lanes read per role, while every implementation path is shared (ADR-0007:
 * "the same code path").
 */
export const partyRoleSchema = z.enum(["customer", "supplier"]);
/** The invoice kind a party role owns: a customer's invoices are SALE, a
 * supplier's are PURCHASE. One map for the store's role→kind lookups; the
 * router's kind→role inverse stays a single local branch. */
export const partyInvoiceKind = { customer: "SALE", supplier: "PURCHASE" } as const;
export const partySchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1),
  /** identity when present: unique across records. Null for a walk-in. */
  phone: z.string().trim().nullable(),
  createdAt: localDateTimeSchema,
});

/** role-typed aliases (structurally identical) */
export const customerSchema = partySchema;
export const supplierSchema = partySchema;

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
  /** snapshot of the FIFO cost consumed by this line (whole DZD unit cost) */
  costAtSale: dinarsSchema,
  /** exact total COGS of the layers this line consumed, before rounding (the
   * report sums this instead of quantity × costAtSale, whose per-unit rounding
   * drifts by up to half a DZD per unit — see docs/adr/0005) */
  cogsExact: dinarsSchema,
  /** gross line total before the invoice-level discount */
  total: dinarsSchema,
  /** proportional share of the invoice discount for item reporting */
  discountAllocated: dinarsSchema,
  /** gross line total less its internally allocated invoice discount */
  netTotal: dinarsSchema,
});

export const invoiceSchema = z.object({
  id: idSchema,
  /** auto-suggested with the kind in it (INV-0001 for a sale, SUP-0001 for a
   * supplier purchase — #258) but editable, unique */
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

/** Review tag a return-originated stock movement carries; null = not a return. */
export const returnMarkSchema = z.enum(returnMarks);

export const returnPayoutMethodSchema = z.enum(returnPayoutMethods);
export const returnStatusSchema = z.enum(returnStatuses);

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
  /** review tag on a return-originated movement; null otherwise */
  returnMark: returnMarkSchema.nullable(),
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
  storeAddress: z.string().trim().nullable(),
});

/**
 * One client UI preference (key/value). Preferences are shell state — sidebar
 * collapse, getting-started dismissal — not store identity, so they live in
 * their own table and never ride in `settings`. Stored server-side because a
 * packaged app serves the webview from a new random localhost port each
 * launch, which wipes localStorage.
 */
export const preferenceKeySchema = z.string().trim().min(1).max(64);
export const preferenceValueSchema = z.string().max(512);

export const preferencesGetOutputSchema = z.object({
  /** every preference in one cheap read; the shell and dashboard share it */
  values: z.record(preferenceKeySchema, preferenceValueSchema),
});

export const preferencesSetInputSchema = z.object({
  key: preferenceKeySchema,
  value: preferenceValueSchema,
});

export const preferencesSetOutputSchema = z.object({
  key: preferenceKeySchema,
  value: preferenceValueSchema,
});

// ---------------------------------------------------------------------------
// Expenses and profit reports (ticket 31)
// ---------------------------------------------------------------------------

/** Whole-dinar ceiling shared by the entity and its create input so report sums
 * can never approach MAX_SAFE_INTEGER at realistic volumes. */
export const MAX_EXPENSE_AMOUNT = 1_000_000_000_000;

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
  amount: z.number().int().positive().max(MAX_EXPENSE_AMOUNT),
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
 * Report window selection. `CUSTOM` resolves the custom pair half-open: a
 * missing lower bound opens at the beginning of records and a missing upper
 * bound clamps to now (Algeria-local) so a from-only report can never see
 * future-dated rows; at least one bound is required. Other presets ignore
 * the pair (the api computes the window in Algeria local time — see
 * apps/api/src/lib/report-ranges.ts). Both bounds are inclusive.
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
  /** supplier rows only (issue 161): the signed account balance in the #260
   * convention — positive when the supplier owes the shop (a credit), negative
   * when the shop owes the supplier. Null for a customer (customers keep
   * invoice-based debt) and for typed-only rows with no supplier account. */
  accountBalance: z.number().int().nullable(),
});

export const invoiceDetailSchema = invoiceSchema.extend({
  lines: z.array(invoiceLineSchema),
  payments: z.array(paymentSchema),
  /**
   * Debt this invoice's returns have actually relieved (the sum of the
   * returns' `debtApplied`). It is the missing term in the invoice header's
   * arithmetic: once a return has cleared part of the debt, `totalAmount −
   * paidAmount ≠ remainingAmount`, because that difference was settled with
   * returned goods rather than with money. An invoice-linked account-only
   * adjustment (تسوية, issue 176) that names this invoice reduces it the same
   * way and is summed here too. Surfacing it keeps the three stored figures
   * reconcilable instead of looking like corrupt data.
   */
  returnCreditAmount: dinarsSchema,
});

// ---------------------------------------------------------------------------
// Parties (issue 120): list aggregates, detail payload, delete result
// ---------------------------------------------------------------------------

/**
 * Per-party invoice aggregates. The list row and the detail strip share this
 * contract shape; the detail derives it from the same mapped invoices it
 * renders, so the strip can never disagree with the tab below it.
 * `remainingAmount` includes fully paid invoices as 0.
 */
export const partyStatsSchema = z.object({
  invoiceCount: z.number().int().min(0),
  /** sum of invoice totals (بيع for a customer, شراء for a supplier) */
  totalAmount: dinarsSchema,
  paidAmount: dinarsSchema,
  remainingAmount: dinarsSchema,
});

/** List seam: the joined aggregates live here, never on the entity schema
 * (wisdom 2026-08-27: widening itemSchema rippled through every consumer).
 * `accountBalance` / `accountEntryCount` are supplier-only (issue 176): the
 * signed account balance and how many ledger entries back it. Null for a
 * customer, who keeps invoice-based debt, and for a party with no account. The
 * bulk رصيد افتتاحي screen reads both to show the current balance and to ask
 * for confirmation before adding a second entry. */
export const partyListItemSchema = partySchema.extend({
  stats: partyStatsSchema,
  accountBalance: z.number().int().nullable(),
  accountEntryCount: z.number().int().min(0).nullable(),
});
export const partyListOutputSchema = z.object({ items: z.array(partyListItemSchema) });

/**
 * #183 — names-only party identity, for name-conflict checks that must not pay
 * for the list seam above (no invoice aggregates, no phone). The bulk
 * opening-balance screen folds typed names against this list; only `{ id, name }`
 * ever crosses the wire.
 */
export const partyNameSchema = partySchema.pick({ id: true, name: true });
export const partyNamesOutputSchema = z.object({ items: z.array(partyNameSchema) });

/**
 * #183 — the bulk opening-balance screen's supplier account summary: the signed
 * balance and the entry count the screen renders, keyed by supplier id. Leaner
 * than `listParties`: it reads only `supplier_account_entries`, never the
 * invoice join. A supplier with no entry is absent and the caller defaults to
 * 0/0. Uses the same sign expression as `listParties` and the supplier detail.
 */
export const supplierAccountSummarySchema = z.object({
  id: idSchema,
  accountBalance: z.number().int(),
  accountEntryCount: z.number().int().min(0),
});
export const supplierAccountSummariesOutputSchema = z.object({ items: z.array(supplierAccountSummarySchema) });

/** Payments tab row: the invoice number is joined at this seam so the page
 * never renders a raw invoiceId. */
export const partyPaymentSchema = paymentSchema.extend({ invoiceNumber: z.string().min(1) });

// ---------------------------------------------------------------------------
// Supplier account (issue 161): one signed ledger per supplier (ADR-0009)
// ---------------------------------------------------------------------------

/** A supplier account entry. #260 — the sign is the DIRECTION OF THE BALANCE:
 * positive = the supplier owes us (a credit), negative = we owe the supplier.
 * Purchase = a debt, payment = reduces it, purchase return = reduces it,
 * account refund = draws the credit down. A manual adjustment (تسوية, issue 176)
 * carries a `direction` («يسالنا» / «نسالوه») that decides its sign. The amount
 * stored is always positive; the sign is applied when summing. */
export const supplierEntryKinds = ["PURCHASE", "PAYMENT", "RETURN", "REFUND", "ADJUSTMENT"] as const;
export const supplierEntryKindSchema = z.enum(supplierEntryKinds);

/** A manual adjustment's direction (issue 176). WE_OWE = «يسالنا» (he asks us:
 * the shop owes the supplier more, −); THEY_OWE = «نسالوه» (we ask him: the shop
 * owes less, +). #260 — the sign describes the balance's direction, not a cash
 * movement. The same two words will serve customers when their account lands. */
export const supplierAdjustmentDirections = ["WE_OWE", "THEY_OWE"] as const;
export const supplierAdjustmentDirectionSchema = z.enum(supplierAdjustmentDirections);

/** How a supplier payment is distributed. OLDEST = spread over unpaid invoices
 * oldest-first; INVOICE = a named invoice; CREDIT = leave the whole amount as
 * an advance (credit). */
export const supplierPayTargetSchema = z.object({
  kind: z.enum(["OLDEST", "INVOICE", "CREDIT"]),
  /** required when kind = INVOICE, forbidden otherwise */
  invoiceId: idSchema.optional(),
});

export const supplierAccountEntrySchema = z.object({
  id: idSchema,
  supplierId: idSchema,
  kind: supplierEntryKindSchema,
  /** always positive; the kind's sign is applied when summing */
  amount: z.number().int().positive(),
  /** the invoice this entry names, when it reduces/charges one */
  invoiceId: idSchema.nullable(),
  /** joined at the store seam so the UI never renders a raw invoiceId */
  invoiceNumber: z.string().nullable(),
  /** ADJUSTMENT only (issue 176): the direction that decides its sign. Null
   * for every other kind. */
  direction: supplierAdjustmentDirectionSchema.nullable(),
  method: paymentMethodSchema.nullable(),
  note: z.string().nullable(),
  /** voucher/return reference, when the entry came from a return */
  ref: z.string().nullable(),
  occurredAt: localDateTimeSchema,
  createdAt: localDateTimeSchema,
});

/** The supplier's signed balance and every account entry (newest first).
 * `balance` is a signed whole-DZD integer in the #260 convention: positive =
 * the supplier owes the shop (a credit), negative = the shop owes the supplier. */
export const supplierAccountSchema = z.object({
  balance: z.number().int(),
  entries: z.array(supplierAccountEntrySchema),
});

export const partyDetailOutputSchema = z.object({
  party: partySchema,
  stats: partyStatsSchema,
  /** every invoice of this party, newest first (no pagination: shop scale) */
  invoices: z.array(invoiceSchema),
  /** every payment on those invoices, newest first */
  payments: z.array(partyPaymentSchema),
  /** the signed supplier account; null for a customer (customers keep
   * invoice-based debt) */
  account: supplierAccountSchema.nullable(),
});

export const partyDeleteOutputSchema = z.object({ deleted: z.boolean() });

// ---------------------------------------------------------------------------
// Returns & refunds (cash today, payoutMethod future-proofs credit)
// ---------------------------------------------------------------------------

/** One refunded invoice line. `refundUnitPrice` is a whole-DZD snapshot of the
 * per-unit amount the customer actually paid (net of the allocated invoice
 * discount), so the voucher never recomputes money later. */
export const returnLineSchema = z.object({
  id: idSchema,
  returnId: idSchema,
  /** the original SALE invoice line this unit came from */
  invoiceLineId: idSchema,
  itemId: idSchema.nullable(),
  /** snapshot of the item name at return time */
  description: z.string(),
  quantity: z.number().int().positive(),
  /** effective per-unit refund: round(netTotal / sold line quantity) at return time */
  refundUnitPrice: dinarsSchema,
  /** quantity × refundUnitPrice, whole DZD */
  refundAmount: dinarsSchema,
});

/**
 * One return record. The status is the review state machine: a created return
 * is PENDING_REVIEW; accepting consumes the stock movement's pending mark,
 * rejecting (damaged) removes the quantity as a MANUAL_ADJUSTMENT outflow.
 *
 * Settlement (owner-approved split): the return value is refundAmount, and
 * the owner chooses how it is settled — cashPaidOut (cash handed back now)
 * plus debtOffset (deducted from the invoice's remaining debt). The two ALWAYS
 * sum to the return value; the debt portion never exceeds the invoice's
 * remaining debt (any excess flows to cash). Money on the invoice is only
 * ever reduced via the debt offset; the cash side is a cash record here.
 */
export const returnSchema = z.object({
  id: idSchema,
  /** auto-suggested RET-%04d (#258; legacy rows carry RTN-%04d), unique */
  returnNumber: z.string().min(1),
  invoiceId: idSchema,
  /** denormalized for the voucher and list views (join is one-to-one) */
  invoiceNumber: z.string().min(1),
  invoiceDate: localDateSchema,
  counterpartyName: z.string().trim().min(1).nullable(),
  /** whole DZD the return is worth; cashPaidOut + debtOffset = refundAmount */
  refundAmount: dinarsSchema,
  /** cash handed back to the customer now (whole DZD) */
  cashPaidOut: dinarsSchema,
  /** deducted from the invoice's remaining debt (whole DZD) */
  debtOffset: dinarsSchema,
  /** portion of the recorded debtOffset already applied to the invoice
   * (whole DZD). Pre-#68 returns were applied in full at creation; #68 defers
   * the application to acceptance, so new returns carry 0 until the owner
   * accepts. Applying never exceeds debtOffset, and the ledger reads this to
   * avoid double-relief when a legacy and a new return mix. */
  debtApplied: dinarsSchema,
  payoutMethod: returnPayoutMethodSchema,
  /** Arabic owner note; rejection reasons ride here too */
  reason: z.string().max(500).nullable(),
  status: returnStatusSchema,
  occurredAt: localDateTimeSchema,
  createdAt: localDateTimeSchema,
  updatedAt: localDateTimeSchema,
});

export const returnDetailSchema = returnSchema.extend({
  lines: z.array(returnLineSchema),
});

/** One returned purchase line (invoice-linked snaps the original line, a
 * free-standing return names the item and its current average cost). */
export const supplierReturnLineSchema = z.object({
  id: idSchema,
  returnId: idSchema,
  invoiceLineId: idSchema.nullable(),
  itemId: idSchema.nullable(),
  description: z.string(),
  quantity: z.number().int().positive(),
  unitCost: dinarsSchema,
  amount: dinarsSchema,
});

/** A purchase return (issue 161). Auto-accepted: there is no review state, so
 * the only status is the recorded fact. The signed account entry it produced
 * lives in `supplier_account_entries` with `ref = returnNumber`. */
export const supplierReturnSchema = z.object({
  id: idSchema,
  returnNumber: z.string().min(1),
  supplierId: idSchema,
  /** the supplier's current name, joined at the store seam so the voucher and
   * the global history can identify who holds the goods/credit */
  supplierName: z.string().nullable(),
  invoiceId: idSchema.nullable(),
  invoiceNumber: z.string().nullable(),
  /** INVOICE_LINKED snapshots original purchase lines; FREE_STANDING names an item */
  kind: z.enum(["INVOICE_LINKED", "FREE_STANDING"]),
  /** whole DZD returned */
  amount: dinarsSchema,
  /** portion that reduced an invoice's remaining debt */
  debtReduction: dinarsSchema,
  /** portion left as supplier credit */
  credit: dinarsSchema,
  /** cash received from the supplier at return time */
  cashBack: dinarsSchema,
  reason: z.string().max(500).nullable(),
  occurredAt: localDateTimeSchema,
  createdAt: localDateTimeSchema,
  lines: z.array(supplierReturnLineSchema),
});

// ---------------------------------------------------------------------------
// Pagination (issue 163): one shape for every flat, growing list.
// ---------------------------------------------------------------------------

/** Rows per page when the client sends no `limit`. */
export const DEFAULT_PAGE_SIZE = 10;
/** The page-size presets the shared pager offers, in rows. */
export const PAGE_SIZE_PRESETS = [20, 25, 50, 100] as const;
/** Ceiling for a manual page size: one request can never ask for the whole
 * table, and the number stays well inside SQLite's integer range. */
export const MAX_PAGE_SIZE = 500;

/** List pagination input: rows per page and rows to skip. Both optional;
 * `resolvePagination` applies the server defaults. */
export const paginationInputSchema = z.object({
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  offset: z.number().int().min(0).optional(),
});
export type PaginationInput = z.infer<typeof paginationInputSchema>;

/** The one list envelope: a page of rows plus the unfiltered total. */
export function pagedOutputSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), total: z.number().int().min(0) });
}

/** Apply the server's pagination defaults. The router resolves once so every
 * store read receives concrete numbers, never `undefined` semantics. */
export function resolvePagination(input: PaginationInput | undefined) {
  return { limit: input?.limit ?? DEFAULT_PAGE_SIZE, offset: input?.offset ?? 0 };
}

export const supplierReturnsListInputSchema = paginationInputSchema.extend({
  supplierId: idSchema.optional(),
});

export const supplierReturnsListOutputSchema = pagedOutputSchema(supplierReturnSchema);

// ---------------------------------------------------------------------------
// Party-detail tab pagination (issue 174)
// ---------------------------------------------------------------------------
// The tabs page; the money reads do not. `partyDetail` keeps returning the
// FULL invoice set because the in-page settle/pay panels and the deleteParty
// FK guard distribute money over every row (issue 163 deferred this on
// purpose). These three endpoints exist only for the tab tables.

/** Invoices tab. `unpaidOnly` matches `unpaidInvoices` (remaining > 0), the
 * customer tab's default filter; suppliers pass it false/omitted. */
export const partyInvoicesInputSchema = paginationInputSchema.extend({
  role: partyRoleSchema,
  id: idSchema,
  unpaidOnly: z.boolean().optional(),
});
export const partyInvoicesOutputSchema = pagedOutputSchema(invoiceSchema);

/** Payments tab: the customer payments list. A supplier's payments tab is the
 * signed account ledger, read through `supplierEntries`, so this read takes no
 * role. */
export const partyPaymentsInputSchema = paginationInputSchema.extend({
  id: idSchema,
});
export const partyPaymentsOutputSchema = pagedOutputSchema(partyPaymentSchema);

/** Payments tab, supplier half: the #161 signed account entries, newest first.
 * The unpaginated `listSupplierEntries` stays for the money paths. */
export const supplierEntriesInputSchema = paginationInputSchema.extend({ id: idSchema });
export const supplierEntriesOutputSchema = pagedOutputSchema(supplierAccountEntrySchema);

/** Read one purchase-return voucher by id. The print page must never scan a
 * paginated list for the requested row (issue #163 review). */
export const supplierReturnGetInputSchema = z.object({ returnId: idSchema });

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * The shortest password the contracts accept. Exported so the web layer's
 * pre-submit check and its Arabic copy cannot drift from the rule the api
 * enforces (packages/contracts/src/core.ts).
 */
export const MIN_PASSWORD_LENGTH = 4;

/**
 * The three outcomes of the legacy-plaintext sweep. "clean" and "remaining"
 * are confirmed facts; "unknown" means the sweep could not run (it threw or
 * the shell never heard back), and the UI must not present it as clean.
 */
export const plaintextCleanupStatuses = ["clean", "remaining", "unknown"] as const;
export type PlaintextCleanupStatus = (typeof plaintextCleanupStatuses)[number];

/**
 * The shortest vault passphrase the unified vault accepts (ADR-0008 §4.6).
 * Exported so the API's refusal and the web form's pre-check cannot drift.
 */
export const MIN_VAULT_PASSPHRASE_LENGTH = 8;

/**
 * Every stable vault error code the API or the web vault client can put in
 * front of the owner. The API never ships display copy (locale-neutral guard);
 * the web translates each code through apps/web/src/lib/i18n.ts, and
 * apps/web/src/lib/i18n.test.ts fails when a code here has no key there.
 */
export const VAULT_ERROR_CODES = [
  // emitted by the API gate, the broker and the lock refusal app
  "VAULT_ALREADY_CONFIGURED",
  "VAULT_BROKER_REQUIRED",
  "VAULT_CORRUPT",
  "VAULT_DATABASE_MISSING",
  "VAULT_INVALID",
  "VAULT_LAST_RECOVERY_KEY",
  "VAULT_LOCKED",
  "VAULT_LOCKED_BY_OTHER_INSTANCE",
  "VAULT_LOOPBACK_REQUIRED",
  "VAULT_NOT_UNLOCKED",
  "VAULT_PASSPHRASE_TOO_SHORT",
  "VAULT_RECOVERY_LIMIT",
  "VAULT_RECOVERY_NOT_FOUND",
  "VAULT_RESET_FAILED",
  "VAULT_SCHEMA_TOO_NEW",
  "VAULT_SETUP_FAILED",
  "VAULT_SETUP_IN_PROGRESS",
  "VAULT_SETUP_TOKEN_REQUIRED",
  "VAULT_WRONG_PASSPHRASE",
  "VAULT_WRONG_RECOVERY",
  // emitted by the web vault client itself (transport/envelope failures)
  "VAULT_MALFORMED_RESPONSE",
  "VAULT_UNEXPECTED",
  "VAULT_UNREACHABLE",
  "VAULT_UNSUPPORTED",
] as const;
export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[number];

export const needsSetupOutputSchema = z.object({
  needsSetup: z.boolean(),
  /** true when there is no owner but the database already holds shop data:
   * first-run setup is refused, and the UI must say so instead of showing a
   * login form that cannot succeed (ADR-0008 §4.1). */
  setupBlocked: z.boolean(),
});

export const firstTimeSetupInputSchema = z.object({
  ownerName: z.string().trim().min(1),
  phoneNumber: z.string().refine(isValidAlgerianPhone, "expected an Algerian mobile, e.g. +213550123123 or 0550123123"),
  // The unified vault (ADR-0008 §4.6) makes the passphrase the owner credential,
  // so the vault setup form sends no password. The legacy plaintext path still
  // requires one and refuses the call server-side when it is absent (and the
  // boot-token flow stays the only way to reach owner provisioning).
  password: z.string().min(MIN_PASSWORD_LENGTH).optional(),
  storeName: z.string().trim().min(1),
  storeAddress: z.string().trim().optional(),
  // Packaged installs only: the one-time boot token the desktop shell injects
  // into the webview's initial navigation. Absent in dev/e2e (no boot token),
  // where the loopback-only server keeps the open gate.
  setupToken: z.string().min(1).optional(),
});

export const firstTimeSetupOutputSchema = z.object({
  ok: z.literal(true),
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
  /** bounded so a pasted blob can never become a unique identity key */
  phone: z.string().trim().max(32).optional(),
});

/**
 * Editable party fields (the store patch); the RPC input adds the id. Names
 * may repeat; the store owns the phone uniqueness rule. An explicit
 * `phone: null` clears it, an omitted phone keeps the stored value.
 */
export const partyPatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  phone: z.string().trim().max(32).nullable().optional(),
});

export const partyUpdateInputSchema = partyPatchSchema
  .extend({ id: idSchema })
  .refine((value) => value.name !== undefined || value.phone !== undefined, {
    message: "an edit must change the name or the phone",
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

// --- supplier account inputs (issue 161) -----------------------------------

export const supplierPayInputSchema = z
  .object({
    supplierId: idSchema,
    amount: dinarsSchema.refine((v) => v > 0, "must be a positive amount"),
    method: paymentMethodSchema.optional(),
    note: z.string().nullable().optional(),
    /** oldest-first default; a specific invoice, or a pure credit advance */
    target: supplierPayTargetSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const target = value.target;
    if (target?.kind === "INVOICE" && target.invoiceId === undefined) {
      ctx.addIssue({ code: "custom", message: "an invoice target needs an invoiceId", path: ["target", "invoiceId"] });
    }
    if (target !== undefined && target.kind !== "INVOICE" && target.invoiceId !== undefined) {
      ctx.addIssue({ code: "custom", message: "invoiceId is only valid with an INVOICE target", path: ["target", "invoiceId"] });
    }
  });

/** One returned purchase line; returned quantity is capped at bought minus
 * already returned on the api. */
export const supplierReturnLineInputSchema = z.object({
  invoiceLineId: idSchema,
  quantity: z.number().int().positive().max(1_000_000),
});

/** A purchase return: either invoice-linked (`lines` + `invoiceId`) or
 * free-standing (`itemId` + `quantity` + `amount`). Auto-accepted — no review
 * state. `cashBack` records cash received to close the resulting credit. */
export const supplierReturnInputSchema = z
  .object({
    supplierId: idSchema,
    invoiceId: idSchema.optional(),
    lines: z.array(supplierReturnLineInputSchema).min(1).max(200).optional(),
    itemId: idSchema.optional(),
    quantity: z.number().int().positive().max(1_000_000).optional(),
    amount: dinarsSchema.refine((v) => v > 0, "must be a positive amount").optional(),
    reason: z.string().trim().max(500).nullable().optional(),
    /** cash received from the supplier now, to close the resulting credit */
    cashBack: dinarsSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const invoiceLinked = value.invoiceId !== undefined || value.lines !== undefined;
    const freeStanding = value.itemId !== undefined || value.quantity !== undefined || value.amount !== undefined;
    if (invoiceLinked && freeStanding) {
      ctx.addIssue({ code: "custom", message: "a purchase return is either invoice-linked or free-standing, not both" });
      return;
    }
    if (invoiceLinked) {
      if (value.invoiceId === undefined) ctx.addIssue({ code: "custom", message: "invoice-linked returns need an invoiceId", path: ["invoiceId"] });
      if (value.lines === undefined) ctx.addIssue({ code: "custom", message: "invoice-linked returns need lines", path: ["lines"] });
      return;
    }
    if (value.itemId === undefined) ctx.addIssue({ code: "custom", message: "free-standing returns need an itemId", path: ["itemId"] });
    if (value.quantity === undefined) ctx.addIssue({ code: "custom", message: "free-standing returns need a quantity", path: ["quantity"] });
    if (value.amount === undefined) ctx.addIssue({ code: "custom", message: "free-standing returns need an amount", path: ["amount"] });
  });

export const supplierRefundInputSchema = z.object({
  supplierId: idSchema,
  amount: dinarsSchema.refine((v) => v > 0, "must be a positive amount"),
  method: paymentMethodSchema.optional(),
  note: z.string().nullable().optional(),
});

/**
 * #176 — a manual adjustment (تسوية): a signed number written straight on the
 * supplier account, with no invoice. `direction` carries «يسالنا» (WE_OWE, −)
 * or «نسالوه» (THEY_OWE, +). An optional `invoiceId` turns it into a
 * discount/write-off that reduces THAT invoice's remaining without cash; a
 * linked reduction only makes sense in the THEY_OWE direction, so the contract
 * refuses the contradiction before any store work. The linked amount may not
 * exceed the invoice's remaining — the router refuses the excess instead of
 * silently moving it to credit.
 */
export const supplierAdjustInputSchema = z
  .object({
    supplierId: idSchema,
    direction: supplierAdjustmentDirectionSchema,
    amount: dinarsSchema.refine((v) => v > 0, "must be a positive amount"),
    /** free text; the form offers presets (رصيد افتتاحي / تصحيح / دين قديم / خصم) */
    reason: z.string().trim().max(500).nullable().optional(),
    /** backdatable; defaults to the server's now when omitted */
    occurredAt: localDateTimeSchema.optional(),
    /** the purchase invoice this adjustment discounts, when the owner links one */
    invoiceId: idSchema.optional(),
    /**
     * #181 — an explicit client idempotency key. When present it is the primary
     * dedup key (scoped to the supplier): a retry that changes `occurredAt` or
     * any other field but keeps the key is the same logical request and is
     * refused. The #177 signature guard stays in force as a backstop, so the key
     * can only add refusals. When absent the signature alone decides.
     */
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.invoiceId !== undefined && value.direction !== "THEY_OWE") {
      ctx.addIssue({ code: "custom", message: "a linked adjustment must be نسالوه (it reduces the invoice)", path: ["direction"] });
    }
  });

/** One row of the bulk رصيد افتتاحي screen: an existing supplier or an inline
 * new name, a direction, and an amount. `confirmExisting` acknowledges that
 * the supplier already carries an account entry (the screen asks before
 * saving). */
export const supplierOpeningBalanceRowInputSchema = z
  .object({
    supplierId: idSchema.optional(),
    newSupplierName: z.string().trim().min(1).max(200).optional(),
    direction: supplierAdjustmentDirectionSchema,
    amount: dinarsSchema.refine((v) => v > 0, "must be a positive amount"),
    confirmExisting: z.boolean().optional(),
    /** #184 — the destination the confirmation dialog named for a typed name
     * (`suppliersResolveName`'s answer). `null` means the dialog named a NEW
     * supplier. The write never uses this as its target; it refuses when its
     * own resolution differs, so the dialog can never name account A while the
     * amount lands on B. Omitted by callers that did not show a dialog. */
    expectedSupplierId: idSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const hasExisting = value.supplierId !== undefined;
    const hasNew = value.newSupplierName !== undefined;
    if (hasExisting === hasNew) {
      ctx.addIssue({ code: "custom", message: "a row names either an existing supplierId or a new supplierName" });
    }
    // #184 — the consistency check belongs to a resolved typed name only; on an
    // explicit id it would be silently ignored, so refuse it instead
    if (value.expectedSupplierId !== undefined && !hasNew) {
      ctx.addIssue({ code: "custom", message: "expectedSupplierId is only valid with newSupplierName" });
    }
  });

/** The whole batch: one shared date + reason, one account-only adjustment per
 * filled row. No invoice link exists in the bulk screen. */
export const supplierOpeningBalancesInputSchema = z.object({
  occurredAt: localDateTimeSchema,
  reason: z.string().trim().max(500).nullable().optional(),
  rows: z.array(supplierOpeningBalanceRowInputSchema).min(1).max(200),
});

export const supplierOpeningBalancesOutputSchema = z.object({
  /** how many adjustment entries were written (one per filled row) */
  created: z.number().int().min(0),
  /** the suppliers touched, with their balance after the batch */
  accounts: z.array(z.object({ supplierId: idSchema, name: z.string(), balance: z.number().int() })),
});

/** #184 — resolve a typed supplier name to the account the server would write
 * an opening-balance row to, WITHOUT writing. The row signature is part of the
 * input so the resolver can reproduce both arms of the server rule: the account
 * already holding the signature (a retry), then the entry-count/lowest-id
 * tie-break. The confirmation dialog renders the result instead of mirroring
 * the rule on the client. */
export const supplierResolveNameInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  direction: supplierAdjustmentDirectionSchema,
  amount: dinarsSchema.refine((v) => v > 0, "must be a positive amount"),
  occurredAt: localDateTimeSchema,
  reason: z.string().trim().max(500).nullable().optional(),
});

/** The supplier a write would land on, or null when the name is new and a write
 * would create one. Shared by the single and batch resolve outputs (#184/#255). */
export const resolvedSupplierSchema = z.object({ id: idSchema, name: z.string(), accountEntryCount: z.number().int().min(0) });

export const supplierResolveNameOutputSchema = z.object({
  supplier: resolvedSupplierSchema.nullable(),
});

/**
 * #255 — resolve MANY typed names in one read. A per-row `suppliersResolveName`
 * call rereads every supplier name and recomputes every account summary, so a
 * full 200-row batch cost 200× the two lists; here they are read once and each
 * row still gets its own signature probe through the same resolver.
 */
export const supplierResolveNamesInputSchema = z.object({
  occurredAt: localDateTimeSchema,
  reason: z.string().trim().max(500).nullable().optional(),
  rows: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        direction: supplierAdjustmentDirectionSchema,
        amount: dinarsSchema.refine((v) => v > 0, "must be a positive amount"),
      }),
    )
    .min(1)
    .max(200),
});

export const supplierResolveNamesOutputSchema = z.object({
  /** parallel to the input rows: the account each name would write to, or null
   * for a name a write would create */
  suppliers: z.array(resolvedSupplierSchema.nullable()),
});

export const returnLineInputSchema = z.object({
  invoiceLineId: idSchema,
  /** capped so quantity × price never approaches Number.MAX_SAFE_INTEGER */
  quantity: z.number().int().positive().max(1_000_000),
});

export const returnsCreateInputSchema = z.object({
  invoiceId: idSchema,
  /** bounded so one request can never drive an unbounded transaction */
  lines: z.array(returnLineInputSchema).min(1).max(200),
  /** Arabic owner note; the reason string on the record */
  reason: z.string().trim().max(500).nullable().optional(),
  /** cash today; credit / debt-credit arrive later without a migration */
  payoutMethod: returnPayoutMethodSchema.optional(),
  /** how the owner settles the return: cash handed back now (defaults to the
   * whole return value — all cash). The debt portion is refundTotal minus
   * this, capped at the invoice's remaining debt; any excess flows back to
   * cash, so the split always sums to the return value. */
  cashPaidOut: dinarsSchema.optional(),
});

export const returnsListInputSchema = paginationInputSchema.extend({
  /** optional scope: only this invoice's returns */
  invoiceId: idSchema.optional(),
});

/** Complete return history for one invoice. The review panel's form needs every
 * prior return to compute the remaining returnable quantity and the refund
 * preview, so this read is deliberately unpaginated while `returnsList` (the
 * review screen) pages. */
export const returnsForInvoiceInputSchema = z.object({ invoiceId: idSchema });

export const returnsReviewInputSchema = z.object({
  returnId: idSchema,
  /** rejection note appended to the standard damaged-return reason */
  reason: z.string().trim().max(500).optional(),
});

export const returnsGetInputSchema = z.object({
  returnId: idSchema,
});

export const invoiceListInputSchema = paginationInputSchema.extend({
  kind: invoiceKindSchema.optional(),
  /** UNPAID | PARTIAL | PAID — derived from remainingAmount */
  status: z.enum(["UNPAID", "PARTIAL", "PAID"]).optional(),
  fromDate: localDateSchema.optional(),
  toDate: localDateSchema.optional(),
});

export const activityListInputSchema = paginationInputSchema;

export const logsTailInputSchema = z.object({
  lines: z.number().int().min(1).max(500).optional(),
});

export const settingsUpdateInputSchema = z.object({
  storeName: z.string().trim().min(1).optional(),
  storePhone: z.string().trim().nullable().optional(),
  storeAddress: z.string().trim().nullable().optional(),
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
  amount: z.number().int().positive().max(MAX_EXPENSE_AMOUNT),
  note: z.string().trim().max(500).nullable().optional(),
  /** Algeria-local moment; defaults to now at the api */
  occurredAt: localDateTimeSchema.optional(),
});

export const expenseListInputSchema = paginationInputSchema.extend({
  /** empty/absent = all categories (a record never escapes every filter) */
  categoryIds: z.array(idSchema).max(100).optional(),
  /** window preset, resolved in Algeria local time at the api (same math as
   * the profit report). When absent and no from/to bounds are sent, the
   * window defaults to the current month. */
  preset: reportRangePresetSchema.optional(),
  /** CUSTOM window bounds; at least one bound is required with a CUSTOM
   * preset, and a lone bound is half-open exactly like from/to below (a
   * missing upper clamps to now, a missing lower opens at the beginning of
   * records). */
  customFrom: localDateTimeSchema.optional(),
  customTo: localDateTimeSchema.optional(),
  /** inclusive local-datetime bounds; an alternative to a preset. Half-open:
   * an absent bound stays open-ended (from-only filters up to "now", to-only
   * filters since the beginning of records) — pinned by wire tests */
  from: localDateTimeSchema.optional(),
  to: localDateTimeSchema.optional(),
  sortBy: z.enum(["occurredAt", "amount"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

export const expenseListOutputSchema = pagedOutputSchema(expenseSchema);

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

export const entityListOutputSchema = z.object({
  items: z.array(z.unknown()),
});

export const invoiceListOutputSchema = pagedOutputSchema(invoiceSchema);

export const returnsListOutputSchema = pagedOutputSchema(returnDetailSchema);

export const returnsForInvoiceOutputSchema = z.object({ items: z.array(returnDetailSchema) });

/**
 * Lightweight pending-return count (issue 118) for the shell badge and the
 * dashboard notice. A dedicated aggregate keeps the always-mounted sidebar
 * from pulling every return row just to render a number.
 */
export const returnsPendingCountOutputSchema = z.object({
  count: z.number().int().min(0),
});

export const itemHistoryInputSchema = z.object({
  itemId: idSchema,
}).merge(paginationInputSchema);

/**
 * One item-history row plus the recording-order fields the superseded-row
 * badge needs (issue 215). Both fields are additive and optional: a response
 * cached before they existed still parses, and an old client ignores them.
 *
 * `seq` is the store rowid (the ledger's append order). `supersededBySeq` is
 * the recording order of the nearest correction the date-ordered view draws
 * above this row and that was recorded after it — resolved by the api over the
 * WHOLE ledger, so the badge survives pagination. `null` means no such
 * correction supersedes the row.
 */
export const itemHistoryMovementSchema = stockMovementWithBalanceSchema.extend({
  seq: z.number().int().min(1).optional(),
  supersededBySeq: z.number().int().min(1).nullable().optional(),
});

export const itemHistoryOutputSchema = z.object({
  movements: z.array(itemHistoryMovementSchema),
  /** number of movements in the whole ledger, not just this page */
  total: z.number().int().min(0),
  stockOnHand: z.number().int().min(0),
});

export const debtsOutputSchema = z.object({
  /** customers who owe the shop */
  owedToUs: z.array(debtSummarySchema),
  /** suppliers the shop owes */
  weOwe: z.array(debtSummarySchema),
});

/**
 * Landing-screen payload (issue 84). `day` is the server's own Algeria-local
 * date — never the device clock — and every money figure is aggregated in
 * SQL, so the client renders exactly what the server counted: no capped list
 * is summed and no page is re-sorted client-side.
 */
export const dashboardSummaryOutputSchema = z.object({
  /** the server's Algeria-local day, "YYYY-MM-DD" */
  day: localDateSchema,
  /** exact sum of SALE invoice totals dated `day`, computed in SQL */
  salesTotal: dinarsSchema,
  /** number of SALE invoices dated `day` */
  salesCount: z.number().int().min(0),
  /** party-attributed unpaid SALE debt — mirrors the debts screen's drill-down */
  owedToUs: dinarsSchema,
  /** the signed supplier NET position across all suppliers (#260): positive =
   * the suppliers owe the shop (a credit), negative = the shop owes them.
   * Signed to match the /debts supplier group total, so a valid credit state
   * never fails output validation (Greptile round 2). Bounded to the safe
   * integer range like every other money field. */
  weOwe: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  /** count of items at or below their low-stock threshold, or null when that
   * read failed. Nullable so one failing section cannot blank the money
   * figures that did load. */
  lowStockCount: z.number().int().min(0).nullable(),
  /** low-stock rows for the detail list, ordered by on-hand then name */
  lowStockItems: z.array(itemSchema).nullable(),
  /** the five newest invoices by creation time, newest first */
  recentInvoices: z.array(invoiceSchema).nullable(),
});

/**
 * Getting-started checklist progress (issue 97). Every flag is derived from a
 * real record on the server — an item, a purchase invoice, a sale invoice, and
 * a party-attributed unpaid SALE debt — never from a client-settable flag.
 * `hasDebt` mirrors the dashboard/debts predicate: a party-less walk-in
 * remainder is not "someone who owes you", so it does not complete the step.
 */
export const onboardingProgressOutputSchema = z.object({
  hasItems: z.boolean(),
  hasPurchase: z.boolean(),
  hasSale: z.boolean(),
  hasDebt: z.boolean(),
});

/**
 * Server-written milestone the web reads as a preference: the getting-started
 * checklist was completed from real records. Shared so the router that writes
 * it and the web hook that reads it cannot drift.
 */
export const ONBOARDING_COMPLETED_PREFERENCE_KEY = "ui.onboarding.completed";

export const onboardingCompleteOutputSchema = z.object({
  /** true when every record exists and the milestone is recorded */
  completed: z.boolean(),
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

/** item rows as returned by listItems: the owning category's display name
 * comes pre-joined so the UI never renders the raw categoryId (issue 67). */
export const itemListItemSchema = itemSchema.extend({ categoryName: z.string().nullable() });
export const itemListInputSchema = paginationInputSchema;
export const itemListOutputSchema = pagedOutputSchema(itemListItemSchema);
/** Unpaginated item read for pickers/selects: a dropdown needs the whole
 * catalog, not a page. Kept separate so `itemsList` can paginate freely. */
export const itemListAllOutputSchema = z.object({ items: z.array(itemListItemSchema) });

export const activityListOutputSchema = pagedOutputSchema(activitySchema);

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
export type PartyRole = z.infer<typeof partyRoleSchema>;
export type PartyInvoiceKind = (typeof partyInvoiceKind)[PartyRole];
/** A customer or a supplier: one record shape (see partySchema). */
export type Party = z.infer<typeof partySchema>;
export type PartyStats = z.infer<typeof partyStatsSchema>;
export type PartyListItem = z.infer<typeof partyListItemSchema>;
export type PartyName = z.infer<typeof partyNameSchema>;
export type SupplierAccountSummary = z.infer<typeof supplierAccountSummarySchema>;
export type PartyPayment = z.infer<typeof partyPaymentSchema>;
export type PartyDetail = z.infer<typeof partyDetailOutputSchema>;
export type InvoiceKind = z.infer<typeof invoiceKindSchema>;
export type PriceOverride = z.infer<typeof priceOverrideSchema>;
export type DiscountType = z.infer<typeof discountTypeSchema>;
export type DiscountValue = z.infer<typeof discountValueSchema>;
export type InvoiceDiscount = z.infer<typeof invoiceDiscountSchema>;
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;
export type Invoice = z.infer<typeof invoiceSchema>;
export type InvoiceDetail = z.infer<typeof invoiceDetailSchema>;
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
export type ReturnPayoutMethod = z.infer<typeof returnPayoutMethodSchema>;
export type ReturnMark = z.infer<typeof returnMarkSchema>;
export type ReturnStatus = z.infer<typeof returnStatusSchema>;
export type ReturnLine = z.infer<typeof returnLineSchema>;
export type ReturnDetail = z.infer<typeof returnDetailSchema>;
export type SupplierEntryKind = z.infer<typeof supplierEntryKindSchema>;
export type SupplierAdjustmentDirection = z.infer<typeof supplierAdjustmentDirectionSchema>;
export type SupplierAccountEntry = z.infer<typeof supplierAccountEntrySchema>;
export type SupplierAccount = z.infer<typeof supplierAccountSchema>;
export type SupplierPayTarget = z.infer<typeof supplierPayTargetSchema>;
export type SupplierReturnLine = z.infer<typeof supplierReturnLineSchema>;
export type SupplierReturnRecord = z.infer<typeof supplierReturnSchema>;
export type SupplierReturnsListFilters = z.infer<typeof supplierReturnsListInputSchema>;
export type ReturnsPendingCount = z.infer<typeof returnsPendingCountOutputSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type Activity = z.infer<typeof activitySchema>;
export type ActivityType = z.infer<typeof activityTypeSchema>;
export type MovementKind = z.infer<typeof movementKindSchema>;
export type StockMovement = z.infer<typeof stockMovementSchema>;
export type StockMovementWithBalance = z.infer<typeof stockMovementWithBalanceSchema>;
export type ItemHistoryMovement = z.infer<typeof itemHistoryMovementSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type Preferences = z.infer<typeof preferencesGetOutputSchema>["values"];
export type DebtSummary = z.infer<typeof debtSummarySchema>;
export type DashboardSummary = z.infer<typeof dashboardSummaryOutputSchema>;
export type OnboardingProgress = z.infer<typeof onboardingProgressOutputSchema>;
export type ExpenseCategory = z.infer<typeof expenseCategorySchema>;
export type Expense = z.infer<typeof expenseSchema>;
export type ReportRangePreset = z.infer<typeof reportRangePresetSchema>;
export type ExpenseCategoryTotal = z.infer<typeof expenseCategoryTotalSchema>;
export type ProfitReport = z.infer<typeof profitReportOutputSchema>;

export type CatalogSearchInput = z.infer<typeof catalogSearchInputSchema>;
export type CatalogMatchKind = z.infer<typeof catalogMatchKindSchema>;
export type CatalogMatch = z.infer<typeof catalogMatchSchema>;

export type ItemCreate = z.infer<typeof itemCreateInputSchema>;
export type ItemUpdate = z.infer<typeof itemUpdateInputSchema>;
export type ItemListItem = z.infer<typeof itemListItemSchema>;
export type PartyCreate = z.infer<typeof partyCreateInputSchema>;
export type PartyUpdate = z.infer<typeof partyPatchSchema>;
/** The RPC edit input: the patch plus the record id. */
export type PartyUpdateInput = z.infer<typeof partyUpdateInputSchema>;
export type InvoiceCreate = z.infer<typeof invoiceCreateInputSchema>;
export type InvoicePay = z.infer<typeof invoicePayInputSchema>;
export type SupplierPay = z.infer<typeof supplierPayInputSchema>;
export type SupplierReturn = z.infer<typeof supplierReturnInputSchema>;
export type SupplierReturnLineInput = z.infer<typeof supplierReturnLineInputSchema>;
export type SupplierRefund = z.infer<typeof supplierRefundInputSchema>;
export type SupplierAdjust = z.infer<typeof supplierAdjustInputSchema>;
export type SupplierOpeningBalanceRow = z.infer<typeof supplierOpeningBalanceRowInputSchema>;
export type SupplierOpeningBalances = z.infer<typeof supplierOpeningBalancesInputSchema>;
export type SupplierOpeningBalancesResult = z.infer<typeof supplierOpeningBalancesOutputSchema>;
export type SupplierResolveName = z.infer<typeof supplierResolveNameInputSchema>;
export type SupplierResolveNameResult = z.infer<typeof supplierResolveNameOutputSchema>;
export type SupplierResolveNames = z.infer<typeof supplierResolveNamesInputSchema>;
export type SupplierResolveNamesResult = z.infer<typeof supplierResolveNamesOutputSchema>;
export type InvoiceListFilters = z.infer<typeof invoiceListInputSchema>;
export type ItemListInput = z.infer<typeof itemListInputSchema>;
export type ItemHistoryInput = z.infer<typeof itemHistoryInputSchema>;
export type ActivityListFilters = z.infer<typeof activityListInputSchema>;
export type SettingsUpdate = z.infer<typeof settingsUpdateInputSchema>;
export type PurchaseAllocation = z.infer<typeof purchaseAllocationSchema>;
export type ReturnLineInput = z.infer<typeof returnLineInputSchema>;
export type ReturnsCreate = z.infer<typeof returnsCreateInputSchema>;
export type ReturnsListFilters = z.infer<typeof returnsListInputSchema>;
export type ReturnsReview = z.infer<typeof returnsReviewInputSchema>;
export type ExpenseCategoryCreate = z.infer<typeof expenseCategoryCreateInputSchema>;
export type ExpenseCreate = z.infer<typeof expenseCreateInputSchema>;
export type ExpenseListFilters = z.infer<typeof expenseListInputSchema>;
export type ProfitReportInput = z.infer<typeof profitReportInputSchema>;