import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { activityTypes, invoiceKinds, movementKinds, paymentMethods } from "@dokan/contracts";
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

/** Append-only stock ledger (ticket 27). Rows are raw facts, never rewritten. */
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
  `CREATE TABLE IF NOT EXISTS suppliers (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, counterparty_id TEXT, counterparty_name TEXT, invoice_date TEXT NOT NULL, subtotal_amount INTEGER NOT NULL DEFAULT 0, discount_type TEXT, discount_value INTEGER, discount_amount INTEGER NOT NULL DEFAULT 0, total_amount INTEGER NOT NULL, paid_amount INTEGER NOT NULL, remaining_amount INTEGER NOT NULL, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS invoice_number_sequence (id INTEGER PRIMARY KEY CHECK (id = 1), next_number INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS invoice_lines (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), item_id TEXT REFERENCES items(id), description TEXT NOT NULL, quantity INTEGER NOT NULL, default_unit_price INTEGER NOT NULL DEFAULT 0, unit_price INTEGER NOT NULL, cost_at_sale INTEGER NOT NULL, total INTEGER NOT NULL, discount_allocated INTEGER NOT NULL DEFAULT 0, net_total INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), amount INTEGER NOT NULL, method TEXT NOT NULL, note TEXT, paid_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS activities (id TEXT PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL, ref TEXT)`,
  `CREATE TABLE IF NOT EXISTS stock_movements (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), kind TEXT NOT NULL, delta INTEGER NOT NULL, unit_cost INTEGER, reason TEXT, ref TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS stock_links (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), movement_id TEXT NOT NULL REFERENCES stock_movements(id), quantity INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS expense_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, is_owner_withdrawal INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, category_id TEXT NOT NULL REFERENCES expense_categories(id), amount INTEGER NOT NULL, note TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_expenses_occurred_at ON expenses(occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, name TEXT NOT NULL, image TEXT, username TEXT UNIQUE, phoneNumber TEXT UNIQUE, phoneNumberVerified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL REFERENCES user(id))`,
  `CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, issuer TEXT NOT NULL DEFAULT '', userId TEXT NOT NULL REFERENCES user(id), accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt INTEGER, refreshTokenExpiresAt INTEGER, scope TEXT, password TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(providerId, accountId))`,
  `CREATE TABLE IF NOT EXISTS verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
];