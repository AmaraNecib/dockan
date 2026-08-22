import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Mirrors the zod enums in packages/contracts (the single source of truth);
// keep these tuples in sync with core.ts when an enum grows.
const invoiceKinds = ["SALE", "PURCHASE"] as const;
const paymentMethods = ["CASH", "BANK"] as const;
const activityTypes = [
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
  totalAmount: integer("total_amount").notNull(),
  paidAmount: integer("paid_amount").notNull(),
  remainingAmount: integer("remaining_amount").notNull(),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const invoiceLines = sqliteTable("invoice_lines", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id")
    .notNull()
    .references(() => invoices.id),
  itemId: text("item_id").references(() => items.id),
  description: text("description").notNull(),
  quantity: integer("quantity").notNull(),
  unitPrice: integer("unit_price").notNull(),
  costAtSale: integer("cost_at_sale").notNull(),
  total: integer("total").notNull(),
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

// ---------------------------------------------------------------------------
// better-auth tables (ticket 02 wires the adapter; schema lands here now)
// ---------------------------------------------------------------------------

export const users = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").unique(),
  emailVerified: integer("email_verified").notNull().default(0),
  image: text("image"),
  phoneNumber: text("phone_number").unique(),
  phoneNumberVerified: integer("phone_number_verified").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sessions = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export const accounts = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at"),
  refreshTokenExpiresAt: integer("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const verifications = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Schema DDL applied at startup via CREATE TABLE IF NOT EXISTS (MVP; no
 * migration tooling yet). Column names mirror the table definitions above.
 */
export const SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES categories(id), cost_price INTEGER NOT NULL, selling_price INTEGER NOT NULL, low_stock_threshold INTEGER NOT NULL DEFAULT 5, stock_on_hand INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS suppliers (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, counterparty_id TEXT, counterparty_name TEXT, invoice_date TEXT NOT NULL, total_amount INTEGER NOT NULL, paid_amount INTEGER NOT NULL, remaining_amount INTEGER NOT NULL, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS invoice_lines (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), item_id TEXT REFERENCES items(id), description TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL, cost_at_sale INTEGER NOT NULL, total INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), amount INTEGER NOT NULL, method TEXT NOT NULL, note TEXT, paid_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS activities (id TEXT PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL, ref TEXT)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, phone_number TEXT UNIQUE, phone_number_verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ip_address TEXT, user_agent TEXT, user_id TEXT NOT NULL REFERENCES user(id))`,
  `CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES user(id), access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
];