import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { activityTypes, invoiceKinds, movementKinds, paymentMethods, returnMarks, returnPayoutMethods, returnStatuses, supplierAdjustmentDirections, supplierEntryKinds } from "@dokan/contracts";
/**
 * Drizzle table definitions. Column names are snake_case; the API layer
 * maps rows to the camelCase shapes of @dokan/contracts.
 * Schema is applied with CREATE TABLE IF NOT EXISTS at startup (MVP).
 */

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** loose normalized ASCII barcode; null = uncoded (ticket 28) */
  barcode: text("barcode"),
  categoryId: text("category_id")
    .notNull()
    .references(() => categories.id),
  /** live average cost per unit in DA (see docs/adr/0002) */
  costPrice: integer("cost_price").notNull(),
  sellingPrice: integer("selling_price").notNull(),
  lowStockThreshold: integer("low_stock_threshold").notNull().default(5),
  stockOnHand: integer("stock_on_hand").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  createdAt: text("created_at").notNull(),
});

export const suppliers = sqliteTable("suppliers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  createdAt: text("created_at").notNull(),
});

export const invoices = sqliteTable("invoices", {
  id: text("id").primaryKey(),
  invoiceNumber: text("invoice_number").notNull().unique(),
  kind: text("kind", { enum: invoiceKinds }).notNull(), // SALE | PURCHASE
  counterpartyId: text("counterparty_id"),
  counterpartyName: text("counterparty_name"),
  invoiceDate: text("invoice_date").notNull(),
  subtotalAmount: integer("subtotal_amount").notNull().default(0),
  discountType: text("discount_type", { enum: ["AMOUNT", "PERCENTAGE"] }),
  discountValue: integer("discount_value"),
  discountAmount: integer("discount_amount").notNull().default(0),
  totalAmount: integer("total_amount").notNull(),
  paidAmount: integer("paid_amount").notNull(),
  remainingAmount: integer("remaining_amount").notNull(),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Database-owned next invoice number; the singleton row is updated atomically. */
export const invoiceNumberSequence = sqliteTable("invoice_number_sequence", {
  id: integer("id").primaryKey(),
  nextNumber: integer("next_number").notNull(),
});

/**
 * #258 — the next number *per invoice kind*, so INV and SUP each run their own
 * dense series. A single global counter would punch holes in the other prefix
 * (a purchase would consume a sale's INV number) and a hole in a shop's invoice
 * book reads as a missing document. A separate table rather than a re-key of
 * invoice_number_sequence: that table is `CHECK (id = 1)` and ALTER TABLE
 * cannot change a CHECK, so a per-kind row could not be inserted on a database
 * created before #258. Rows are created by allocateInvoiceNumber on first use.
 */
export const invoiceNumberCounters = sqliteTable("invoice_number_counters", {
  kind: text("kind", { enum: invoiceKinds }).primaryKey(),
  nextNumber: integer("next_number").notNull(),
});

export const invoiceLines = sqliteTable("invoice_lines", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id")
    .notNull()
    .references(() => invoices.id),
  itemId: text("item_id").references(() => items.id),
  description: text("description").notNull(),
  quantity: integer("quantity").notNull(),
  defaultUnitPrice: integer("default_unit_price").notNull().default(0),
  unitPrice: integer("unit_price").notNull(),
  costAtSale: integer("cost_at_sale").notNull(),
  /** exact total COGS of this line's consumed layers (unrounded FIFO sum);
   * legacy rows carry quantity × cost_at_sale via the cogsExactV1 backfill */
  cogsExact: integer("cogs_exact").notNull().default(0),
  total: integer("total").notNull(),
  discountAllocated: integer("discount_allocated").notNull().default(0),
  netTotal: integer("net_total").notNull().default(0),
});

export const payments = sqliteTable("payments", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id")
    .notNull()
    .references(() => invoices.id),
  amount: integer("amount").notNull(),
  method: text("method", { enum: paymentMethods }).notNull(), // CASH | BANK
  note: text("note"),
  paidAt: text("paid_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const activities = sqliteTable("activities", {
  id: text("id").primaryKey(),
  at: text("at").notNull(),
  type: text("type", { enum: activityTypes }).notNull(),
  summary: text("summary").notNull(),
  ref: text("ref"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * Client UI preferences (key/value). Deliberately separate from `settings`
 * (store identity): these are shell state — sidebar collapse, the dashboard
 * getting-started dismissal — and must survive a packaged-app restart, where
 * localStorage is wiped because the sidecar binds a new random localhost port
 * each launch (apps/desktop/src-tauri/src/desktop.rs).
 */
export const preferences = sqliteTable("preferences", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** Database-owned next return number; the singleton row is updated atomically. */
export const returnNumberSequence = sqliteTable("return_number_sequence", {
  id: integer("id").primaryKey(),
  nextNumber: integer("next_number").notNull(),
});

/**
 * One cash refund / goods return against a past SALE invoice (append-only
 * money: the invoice itself is never rewritten). `status` is the review state
 * machine — PENDING_REVIEW until the owner accepts (the pending stock mark is
 * consumed) or rejects as damaged (the quantity is removed as a
 * MANUAL_ADJUSTMENT outflow).
 */
export const returns = sqliteTable("returns", {
  id: text("id").primaryKey(),
  returnNumber: text("return_number").notNull().unique(),
  invoiceId: text("invoice_id")
    .notNull()
    .references(() => invoices.id),
  /** whole DZD the return is worth; cashPaidOut + debtOffset = refundAmount */
  refundAmount: integer("refund_amount").notNull(),
  /** cash handed back to the customer now (whole DZD) */
  cashPaidOut: integer("cash_paid_out").notNull(),
  /** deducted from the invoice's remaining debt (whole DZD) */
  debtOffset: integer("debt_offset").notNull(),
  /** portion of debtOffset already applied to the invoice; new returns start
   * at 0 and gain their applied portion when the owner accepts (#68). */
  debtApplied: integer("debt_applied").notNull().default(0),
  /** 1 when acceptance may relieve invoices OTHER than this return's own —
   * only a return recorded under the tab-wide default (#256 round 3). An
   * explicit choice, and every row written before this column existed (hence
   * the 0 default), is own-invoice-only: its excess stays unapplied. */
  spreadsAcrossInvoices: integer("spreads_across_invoices", { mode: "boolean" }).notNull().default(false),
  /** CASH today; credit / debt-credit arrive later without a migration */
  payoutMethod: text("payout_method", { enum: returnPayoutMethods }).notNull(),
  /** Arabic owner note; rejection reasons ride here too */
  reason: text("reason"),
  status: text("status", { enum: returnStatuses }).notNull(),
  occurredAt: text("occurred_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** One returned invoice line with its whole-DZD refund snapshot. */
export const returnLines = sqliteTable("return_lines", {
  id: text("id").primaryKey(),
  returnId: text("return_id")
    .notNull()
    .references(() => returns.id),
  /** the original SALE line this unit came from */
  invoiceLineId: text("invoice_line_id")
    .notNull()
    .references(() => invoiceLines.id),
  itemId: text("item_id").references(() => items.id),
  /** snapshot of the item name at return time */
  description: text("description").notNull(),
  quantity: integer("quantity").notNull(),
  /** effective per-unit refund: round(netTotal / quantity) at return time */
  refundUnitPrice: integer("refund_unit_price").notNull(),
  /** quantity × refundUnitPrice, whole DZD */
  refundAmount: integer("refund_amount").notNull(),
});

/**
 * Which invoice a return's promised debt offset actually relieved (#256
 * round 2) — one row per invoice, written when the owner ACCEPTS the return,
 * in the same transaction as the offset itself.
 *
 * Round 1 could assume the offset only ever touched the return's own invoice,
 * so the invoice header derived its credit with
 * `SUM(returns.debt_applied) WHERE invoice_id = ?`. The approved rule takes
 * the refund off the party's whole tab "in this invoice or in another
 * invoice", so one return can now relieve several invoices and the header
 * needs the per-invoice attribution: `total − paid − returnCredit = remaining`
 * must still hold on EVERY invoice that moved. Append-only, like every other
 * money fact here.
 */
export const returnDebtApplications = sqliteTable("return_debt_applications", {
  id: text("id").primaryKey(),
  returnId: text("return_id")
    .notNull()
    .references(() => returns.id),
  /** the invoice whose remaining debt this portion relieved */
  invoiceId: text("invoice_id")
    .notNull()
    .references(() => invoices.id),
  amount: integer("amount").notNull(),
  createdAt: text("created_at").notNull(),
});

/** Append-only stock ledger (ticket 27). Rows are raw facts, never rewritten.
 * `returnMark` is the ONLY mutable tag: review-state metadata (PENDING →
 * ACCEPTED/REJECTED) on an otherwise immutable fact row, transitioned inside
 * the same transaction as `returns.status`. */
export const stockMovements = sqliteTable("stock_movements", {
  id: text("id").primaryKey(),
  itemId: text("item_id")
    .notNull()
    .references(() => items.id),
  kind: text("kind", { enum: movementKinds }).notNull(), // PURCHASE | SALE | MANUAL_ADJUSTMENT
  /** signed: positive = stock in, negative = stock out */
  delta: integer("delta").notNull(),
  unitCost: integer("unit_cost"),
  reason: text("reason"),
  ref: text("ref"),
  /** non-null only for return-originated movements: PENDING until reviewed */
  returnMark: text("return_mark", { enum: returnMarks }),
  occurredAt: text("occurred_at").notNull(),
  createdAt: text("created_at").notNull(),
});

/** Purchase-invoice linkage (ticket 29). Appends attribution records between an
 * invoice and earlier uninvoiced PURCHASE movements; never rewrites the ledger. */
export const stockLinks = sqliteTable("stock_links", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id")
    .notNull()
    .references(() => invoices.id),
  movementId: text("movement_id")
    .notNull()
    .references(() => stockMovements.id),
  quantity: integer("quantity").notNull(),
  createdAt: text("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// Supplier account (issue 161): one signed ledger per supplier (ADR-0009)
// ---------------------------------------------------------------------------

/** Append-only supplier account entries. `amount` is always positive; the kind
 * determines the sign in the #260 convention (positive = the supplier owes us, a
 * credit; so PAYMENT/RETURN +, PURCHASE/REFUND −), except an ADJUSTMENT whose
 * `direction` (WE_OWE −, THEY_OWE +, issue 176) carries it. An
 * entry with an `invoice_id` reduces that purchase invoice's remaining debt; an
 * entry with a null invoice is a credit/advance. Never rewritten. */
export const supplierAccountEntries = sqliteTable("supplier_account_entries", {
  id: text("id").primaryKey(),
  supplierId: text("supplier_id")
    .notNull()
    .references(() => suppliers.id),
  kind: text("kind", { enum: supplierEntryKinds }).notNull(),
  amount: integer("amount").notNull(),
  /** ADJUSTMENT only; null for every other kind */
  direction: text("direction", { enum: supplierAdjustmentDirections }),
  invoiceId: text("invoice_id").references(() => invoices.id),
  method: text("method", { enum: paymentMethods }),
  note: text("note"),
  ref: text("ref"),
  /**
   * #181 — the canonical dedup key of an ADJUSTMENT (null for every other kind
   * and for a pre-upgrade duplicate left unkeyed). Carries the client
   * idempotency key when one was sent, else the #177 signature. A partial unique
   * index makes it the DB backstop for the store guard.
   */
  dedupKey: text("dedup_key"),
  occurredAt: text("occurred_at").notNull(),
  createdAt: text("created_at").notNull(),
});

/** Database-owned next supplier-return number; the singleton row is updated
 * atomically like the invoice and sale-return sequences. */
export const supplierReturnNumberSequence = sqliteTable("supplier_return_number_sequence", {
  id: integer("id").primaryKey(),
  nextNumber: integer("next_number").notNull(),
});

/** One purchase return (issue 161). Auto-accepted — no review state. It always
 * writes a RETURN account entry (ref = return_number); `cash_back` records cash
 * received from the supplier in the same unit. */
export const supplierReturns = sqliteTable("supplier_returns", {
  id: text("id").primaryKey(),
  returnNumber: text("return_number").notNull().unique(),
  supplierId: text("supplier_id")
    .notNull()
    .references(() => suppliers.id),
  invoiceId: text("invoice_id").references(() => invoices.id),
  kind: text("kind", { enum: ["INVOICE_LINKED", "FREE_STANDING"] }).notNull(),
  amount: integer("amount").notNull(),
  debtReduction: integer("debt_reduction").notNull().default(0),
  credit: integer("credit").notNull().default(0),
  cashBack: integer("cash_back").notNull().default(0),
  reason: text("reason"),
  occurredAt: text("occurred_at").notNull(),
  createdAt: text("created_at").notNull(),
});

/** One returned purchase line with its whole-DZD snapshot. */
export const supplierReturnLines = sqliteTable("supplier_return_lines", {
  id: text("id").primaryKey(),
  returnId: text("return_id")
    .notNull()
    .references(() => supplierReturns.id),
  /** the original PURCHASE line this unit came from; null when free-standing */
  invoiceLineId: text("invoice_line_id").references(() => invoiceLines.id),
  itemId: text("item_id").references(() => items.id),
  description: text("description").notNull(),
  quantity: integer("quantity").notNull(),
  unitCost: integer("unit_cost").notNull(),
  amount: integer("amount").notNull(),
});

// ---------------------------------------------------------------------------
// Expenses and profit reports (ticket 31)
// ---------------------------------------------------------------------------

/**
 * Expense categories. `is_owner_withdrawal` flags owner cash-outs (سحوبات
 * المالك) so the report separates them from operating expenses by attribute.
 * Seeded with defaults once per database (see store setup).
 */
export const expenseCategories = sqliteTable("expense_categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  isOwnerWithdrawal: integer("is_owner_withdrawal").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Append-only expense records (تسجيل مصروف). The profit report derives every
 * figure from these raw rows plus SALE invoice lines at read time; no
 * precomputed money totals are stored anywhere.
 */
export const expenses = sqliteTable("expenses", {
  id: text("id").primaryKey(),
  categoryId: text("category_id")
    .notNull()
    .references(() => expenseCategories.id),
  /** whole dinars; positive by contract */
  amount: integer("amount").notNull(),
  note: text("note"),
  /** Algeria-local moment of the expense (editable for backdating) */
  occurredAt: text("occurred_at").notNull(),
  createdAt: text("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// better-auth tables (ticket 02 wires the adapter; schema lands here now)
// ---------------------------------------------------------------------------

export const users = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  image: text("image"),
  /** username-password login name = the normalized phone without + (ticket 02) */
  username: text("username").unique(),
  phoneNumber: text("phoneNumber").unique(),
  phoneNumberVerified: integer("phoneNumberVerified").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const sessions = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export const accounts = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  issuer: text("issuer").notNull().default(""),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const verifications = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Schema DDL applied at startup via CREATE TABLE IF NOT EXISTS (MVP; no
 * migration tooling yet). Column names mirror the table definitions above.
 */
export const SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL, barcode TEXT, category_id TEXT NOT NULL REFERENCES categories(id), cost_price INTEGER NOT NULL, selling_price INTEGER NOT NULL, low_stock_threshold INTEGER NOT NULL DEFAULT 5, stock_on_hand INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode)`,
  `CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, created_at TEXT NOT NULL)`,
  // Phone is the identity when present (ADR-0007); NULLs stay distinct, so the
  // partial index never blocks a walk-in without a phone.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone) WHERE phone IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS suppliers (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_phone ON suppliers(phone) WHERE phone IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, counterparty_id TEXT, counterparty_name TEXT, invoice_date TEXT NOT NULL, subtotal_amount INTEGER NOT NULL DEFAULT 0, discount_type TEXT, discount_value INTEGER, discount_amount INTEGER NOT NULL DEFAULT 0, total_amount INTEGER NOT NULL, paid_amount INTEGER NOT NULL, remaining_amount INTEGER NOT NULL, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_counterparty ON invoices(counterparty_id)`,
  `CREATE TABLE IF NOT EXISTS invoice_number_sequence (id INTEGER PRIMARY KEY CHECK (id = 1), next_number INTEGER NOT NULL)`,
  // #258 — per-kind invoice counters (SALE = INV, PURCHASE = SUP); see the
  // table definition for why this is not a re-key of the singleton above.
  `CREATE TABLE IF NOT EXISTS invoice_number_counters (kind TEXT PRIMARY KEY, next_number INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS return_number_sequence (id INTEGER PRIMARY KEY CHECK (id = 1), next_number INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS returns (id TEXT PRIMARY KEY, return_number TEXT NOT NULL UNIQUE, invoice_id TEXT NOT NULL REFERENCES invoices(id), refund_amount INTEGER NOT NULL, cash_paid_out INTEGER NOT NULL, debt_offset INTEGER NOT NULL, debt_applied INTEGER NOT NULL DEFAULT 0, spreads_across_invoices INTEGER NOT NULL DEFAULT 0, payout_method TEXT NOT NULL, reason TEXT, status TEXT NOT NULL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS return_lines (id TEXT PRIMARY KEY, return_id TEXT NOT NULL REFERENCES returns(id), invoice_line_id TEXT NOT NULL REFERENCES invoice_lines(id), item_id TEXT REFERENCES items(id), description TEXT NOT NULL, quantity INTEGER NOT NULL, refund_unit_price INTEGER NOT NULL, refund_amount INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_returns_invoice ON returns(invoice_id)`,
  `CREATE INDEX IF NOT EXISTS idx_return_lines_return ON return_lines(return_id)`,
  `CREATE INDEX IF NOT EXISTS idx_return_lines_invoice_line ON return_lines(invoice_line_id)`,
  `CREATE TABLE IF NOT EXISTS return_debt_applications (id TEXT PRIMARY KEY, return_id TEXT NOT NULL REFERENCES returns(id), invoice_id TEXT NOT NULL REFERENCES invoices(id), amount INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_return_debt_applications_invoice ON return_debt_applications(invoice_id)`,
  `CREATE INDEX IF NOT EXISTS idx_return_debt_applications_return ON return_debt_applications(return_id)`,
  `CREATE TABLE IF NOT EXISTS invoice_lines (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), item_id TEXT REFERENCES items(id), description TEXT NOT NULL, quantity INTEGER NOT NULL, default_unit_price INTEGER NOT NULL DEFAULT 0, unit_price INTEGER NOT NULL, cost_at_sale INTEGER NOT NULL, cogs_exact INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, discount_allocated INTEGER NOT NULL DEFAULT 0, net_total INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), amount INTEGER NOT NULL, method TEXT NOT NULL, note TEXT, paid_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS activities (id TEXT PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL, ref TEXT)`,
  `CREATE TABLE IF NOT EXISTS stock_movements (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), kind TEXT NOT NULL, delta INTEGER NOT NULL, unit_cost INTEGER, reason TEXT, ref TEXT, return_mark TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
  // #295 — the repeat-window read filters `item_id = ? AND created_at > ?`
  // (drizzle-store.ts `listStockMovementsSince`), and that read runs while the
  // manual adjustment HOLDS THE WRITE LOCK. Without this index every
  // adjustment full-scans the ledger: ~5.8 ms per adjustment at 100k rows,
  // against ~1.4 ms with the index.
  //
  // Additive and idempotent like every line here, so it needs no migration:
  // no user_version bump (CURRENT_SCHEMA_VERSION stays 6), no backfill, no row
  // rewrite. The index is built on the next boot from this same array —
  // ~50 ms at 100k rows, once.
  `CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(item_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS stock_links (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), movement_id TEXT NOT NULL REFERENCES stock_movements(id), quantity INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS supplier_account_entries (id TEXT PRIMARY KEY, supplier_id TEXT NOT NULL REFERENCES suppliers(id), kind TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0), direction TEXT CHECK (direction IN ('WE_OWE','THEY_OWE') OR direction IS NULL), invoice_id TEXT REFERENCES invoices(id), method TEXT, note TEXT, ref TEXT, dedup_key TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, CHECK (kind <> 'ADJUSTMENT' OR direction IS NOT NULL))`,
  `CREATE INDEX IF NOT EXISTS idx_supplier_entries_supplier ON supplier_account_entries(supplier_id, occurred_at)`,
  // #181 — the DB backstop for the adjustment dedup key. Partial so every
  // non-ADJUSTMENT row and any unkeyed legacy duplicate is exempt.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_entries_dedup ON supplier_account_entries(dedup_key) WHERE dedup_key IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS supplier_return_number_sequence (id INTEGER PRIMARY KEY CHECK (id = 1), next_number INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS supplier_returns (id TEXT PRIMARY KEY, return_number TEXT NOT NULL UNIQUE, supplier_id TEXT NOT NULL REFERENCES suppliers(id), invoice_id TEXT REFERENCES invoices(id), kind TEXT NOT NULL, amount INTEGER NOT NULL, debt_reduction INTEGER NOT NULL DEFAULT 0, credit INTEGER NOT NULL DEFAULT 0, cash_back INTEGER NOT NULL DEFAULT 0, reason TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_supplier_returns_supplier ON supplier_returns(supplier_id, occurred_at)`,
  `CREATE TABLE IF NOT EXISTS supplier_return_lines (id TEXT PRIMARY KEY, return_id TEXT NOT NULL REFERENCES supplier_returns(id), invoice_line_id TEXT REFERENCES invoice_lines(id), item_id TEXT REFERENCES items(id), description TEXT NOT NULL, quantity INTEGER NOT NULL, unit_cost INTEGER NOT NULL, amount INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_supplier_return_lines_return ON supplier_return_lines(return_id)`,
  `CREATE TABLE IF NOT EXISTS expense_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, is_owner_withdrawal INTEGER NOT NULL DEFAULT 0 CHECK (is_owner_withdrawal IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, category_id TEXT NOT NULL REFERENCES expense_categories(id), amount INTEGER NOT NULL CHECK (amount > 0), note TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_expenses_occurred_at ON expenses(occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, name TEXT NOT NULL, image TEXT, username TEXT UNIQUE, phoneNumber TEXT UNIQUE, phoneNumberVerified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL REFERENCES user(id))`,
  `CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, issuer TEXT NOT NULL DEFAULT '', userId TEXT NOT NULL REFERENCES user(id), accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt INTEGER, refreshTokenExpiresAt INTEGER, scope TEXT, password TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(providerId, accountId))`,
  `CREATE TABLE IF NOT EXISTS verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
];