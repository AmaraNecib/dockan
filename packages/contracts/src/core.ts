import { z } from "zod";

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

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const categorySchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1),
  createdAt: localDateTimeSchema,
  updatedAt: localDateTimeSchema,
});

export const itemSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1),
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
export const invoiceKindSchema = z.enum(["SALE", "PURCHASE"]);

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

export const paymentMethodSchema = z.enum(["CASH", "BANK"]);

export const paymentSchema = z.object({
  id: idSchema,
  invoiceId: idSchema,
  amount: dinarsSchema.refine((v) => v > 0, "a payment must be positive"),
  method: paymentMethodSchema,
  note: z.string().nullable(),
  paidAt: localDateTimeSchema,
  createdAt: localDateTimeSchema,
});

export const activityTypeSchema = z.enum([
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
]);

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

export const loginInputSchema = z.object({
  password: z.string().min(1),
});

export const resetPasswordInputSchema = z.object({
  /** the build secret baked into the app; entering it lets the owner set a new password */
  secret: z.string().min(1),
  newPassword: z.string().min(4),
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
});

export const itemUpdateInputSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).optional(),
  categoryId: idSchema.optional(),
  costPrice: dinarsSchema.optional(),
  sellingPrice: dinarsSchema.optional(),
  lowStockThreshold: z.number().int().min(0).optional(),
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

export const loginOutputSchema = z.object({
  ok: z.literal(true),
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