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
export const dinarsSchema = z.number().int().min(0);
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD (Algeria local time)");
export const localDateTimeSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
  "expected YYYY-MM-DDTHH:mm:ss (Algeria local time)",
);

// Enum value tuples are the single source of truth; the zod schemas below are
// built from them so the api's drizzle schema can import the same literals.
export const invoiceKinds = ["SALE", "PURCHASE"] as const;
export const paymentMethods = ["CASH", "BANK"] as const;
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

export const invoiceLineSchema = z.object({
  id: idSchema,
  invoiceId: idSchema,
  itemId: idSchema.nullable(),
  /** snapshot of the item name at sale time */
  description: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: dinarsSchema,
  /** snapshot of the item's average cost at line creation — profit = unitPrice − costAtSale */
  costAtSale: dinarsSchema,
  total: dinarsSchema,
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
  quantity: z.number().int().positive(),
  /** defaults to the item's current selling price when omitted */
  unitPrice: dinarsSchema.optional(),
});

export const invoiceCreateInputSchema = z.object({
  kind: invoiceKindSchema,
  counterpartyId: idSchema.nullable().optional(),
  /** typed-in name, mutually optional with counterpartyId */
  counterpartyName: z.string().trim().min(1).nullable().optional(),
  invoiceDate: localDateSchema.optional(),
  notes: z.string().nullable().optional(),
  lines: z.array(invoiceLineInputSchema).min(1),
  /** cash paid at invoice time; the rest becomes the debt (remainingAmount) */
  initialPaid: dinarsSchema.refine((v) => v > 0, "must be a positive amount").optional(),
  paymentMethod: paymentMethodSchema.optional(),
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

export const debtsOutputSchema = z.object({
  /** customers who owe the shop */
  owedToUs: z.array(debtSummarySchema),
  /** suppliers the shop owes */
  weOwe: z.array(debtSummarySchema),
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
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;
export type Invoice = z.infer<typeof invoiceSchema>;
export type InvoiceDetail = z.infer<typeof invoiceDetailSchema>;
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type Activity = z.infer<typeof activitySchema>;
export type ActivityType = z.infer<typeof activityTypeSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type DebtSummary = z.infer<typeof debtSummarySchema>;

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