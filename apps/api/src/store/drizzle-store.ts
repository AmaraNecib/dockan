import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type {
  Activity,
  Category,
  Customer,
  DebtSummary,
  Expense,
  ExpenseCategory,
  Invoice,
  InvoiceDetail,
  InvoiceLine,
  InvoiceListFilters,
  Item,
  ItemCreate,
  ItemUpdate,
  OnboardingProgress,
  PaginationInput,
  Party,
  PartyCreate,
  PartyDetail,
  PartyListItem,
  PartyRole,
  PartyStats,
  PartyUpdate,
  Payment,
  PaymentMethod,
  ReturnDetail,
  ReturnMark,
  Settings,
  SettingsUpdate,
  StockMovement,
  Supplier,
  SupplierAccountEntry,
  SupplierAdjustmentDirection,
  SupplierEntryKind,
  SupplierReturnRecord,
} from "@dokan/contracts";
import { ONBOARDING_COMPLETED_PREFERENCE_KEY, normalizePartyPhone, normalizeTextKey, partyInvoiceKind, resolvePagination } from "@dokan/contracts";
import type { Connection } from "../db/connection";
import { SCHEMA_DDL, activities, categories, customers, expenseCategories, expenses, invoiceLines, invoiceNumberSequence, invoices, items, payments, preferences, returnLines, returnNumberSequence, returns, settings, stockLinks, stockMovements, supplierAccountEntries, supplierReturnLines, supplierReturns, suppliers } from "../db/schema";
import { bookSaleLineForReturns } from "../lib/return-calculations";
import { supplierBalance } from "../lib/supplier-ledger";
import { localDateTime } from "../lib/logger";
import { stampSchemaVersionLocked } from "../lib/schema-version";
import type { DashboardAggregates, InvoiceInsert, InvoiceLineInsert, PartyDeleteResult, ProfitSaleLine, ReturnInsert, ReturnLineInsert, StockLink, StoreLogger, StorePort, SupplierAdjustmentInsert, SupplierEntryInsert, SupplierReturnInsert, SupplierReturnLineInsert } from "./port";
import { PartyError, SupplierAdjustmentError } from "./port";

/**
 * The signed-amount SQL for one supplier-ledger alias. Kept in one place
 * (issue 176): if `debtSummaries` or `listParties` forgot the ADJUSTMENT branch
 * the /debts screen and the supplier detail would disagree about the balance.
 * Mirrors `supplierEntrySign` in ../lib/supplier-ledger.ts. `alias` comes from a
 * closed literal, never input.
 */
const supplierSignedAmountSql = (alias: string): string =>
  `CASE WHEN ${alias}.kind IN ('PURCHASE','REFUND') OR (${alias}.kind = 'ADJUSTMENT' AND ${alias}.direction = 'WE_OWE') THEN ${alias}.amount ELSE -${alias}.amount END`;

/** An ADJUSTMENT's sign comes from its direction, so the store refuses to write
 * one without it (issue 176). The SQL sign expression signs a null direction as
 * negative while `supplierEntrySign` throws; validating here keeps every
 * persistence path on the same side of that line (the ALTER migration cannot
 * add a table-level CHECK, so this is the boundary the fresh DDL CHECK
 * complements). */
const assertAdjustmentDirection = (kind: SupplierEntryKind, direction: SupplierAdjustmentDirection | null | undefined): void => {
  if (kind === "ADJUSTMENT" && direction !== "WE_OWE" && direction !== "THEY_OWE") {
    throw new Error("a supplier adjustment entry needs a direction");
  }
};

const now = () => localDateTime();
const id = () => randomUUID();

/**
 * Default expense categories (ticket 31). The owner-withdrawal entry MUST be
 * flagged — the profit report splits operating expenses from owner cash-outs
 * by this attribute, never by name.
 */
const EXPENSE_CATEGORY_DEFAULTS: ReadonlyArray<{ name: string; isOwnerWithdrawal: boolean }> = [
  { name: "كراء المحل", isOwnerWithdrawal: false },
  { name: "كهرباء وماء وغاز", isOwnerWithdrawal: false },
  { name: "أجور ورواتب", isOwnerWithdrawal: false },
  { name: "نقل وتوصيل", isOwnerWithdrawal: false },
  { name: "صيانة وتصليح", isOwnerWithdrawal: false },
  { name: "مصاريف أخرى", isOwnerWithdrawal: false },
  { name: "سحوبات المالك", isOwnerWithdrawal: true },
];

/** Durable marker: once written, the default set is complete and never re-seeded. */
const EXPENSE_CATEGORIES_MARKER = "seed.expenseCategoriesV1";

const firstRowOf = <T,>(rows: T[]): T => {
  const row = rows[0];
  if (row === undefined) throw new Error("expected a row from the database, got none");
  return row;
};

// Aliased selects: drizzle returns rows with these camelCase keys, which is
// exactly the contracts shape. No snake-to-camel mapping anywhere.
const categoryCols = { id: categories.id, name: categories.name, createdAt: categories.createdAt, updatedAt: categories.updatedAt };
const itemCols = {
  id: items.id,
  name: items.name,
  barcode: items.barcode,
  categoryId: items.categoryId,
  costPrice: items.costPrice,
  sellingPrice: items.sellingPrice,
  lowStockThreshold: items.lowStockThreshold,
  stockOnHand: items.stockOnHand,
  createdAt: items.createdAt,
  updatedAt: items.updatedAt,
};
const invoiceCols = {
  id: invoices.id,
  invoiceNumber: invoices.invoiceNumber,
  kind: invoices.kind,
  counterpartyId: invoices.counterpartyId,
  counterpartyName: invoices.counterpartyName,
  invoiceDate: invoices.invoiceDate,
  subtotalAmount: invoices.subtotalAmount,
  discountType: invoices.discountType,
  discountValue: invoices.discountValue,
  discountAmount: invoices.discountAmount,
  totalAmount: invoices.totalAmount,
  paidAmount: invoices.paidAmount,
  remainingAmount: invoices.remainingAmount,
  notes: invoices.notes,
  createdAt: invoices.createdAt,
  updatedAt: invoices.updatedAt,
};
const customerCols = { id: customers.id, name: customers.name, phone: customers.phone, createdAt: customers.createdAt };
const supplierCols = { id: suppliers.id, name: suppliers.name, phone: suppliers.phone, createdAt: suppliers.createdAt };

/** Closed literal map: the role picks the table; never caller text. */
const PARTY_TABLES = { customer: "customers", supplier: "suppliers" } as const;

/** One SQLite scalar as the driver hands it back: text, number, or NULL. */
type SqlScalar = string | number | null | undefined;

/**
 * One aggregate row for a party row (list and detail share this shape).
 * SQLite returns COUNT/SUM numerically; the mapper coerces once here.
 */
type PartyAggregateRow = {
  id: SqlScalar;
  name: SqlScalar;
  phone: SqlScalar;
  createdAt: SqlScalar;
  invoiceCount: SqlScalar;
  totalAmount: SqlScalar;
  paidAmount: SqlScalar;
  remainingAmount: SqlScalar;
  /** supplier-only (issue 176); null for a customer */
  accountBalance: SqlScalar;
  accountEntryCount: SqlScalar;
};

const toPartyListItem = (r: PartyAggregateRow): PartyListItem => ({
  id: String(r.id),
  name: String(r.name),
  phone: r.phone === null || r.phone === undefined ? null : String(r.phone),
  createdAt: String(r.createdAt),
  stats: safePartyStats(r),
  accountBalance: r.accountBalance === null || r.accountBalance === undefined ? null : safeSignedWhole(r.accountBalance),
  accountEntryCount: r.accountEntryCount === null || r.accountEntryCount === undefined ? null : safeWhole(r.accountEntryCount),
});

/**
 * Coerce one SQLite aggregate into the contract's dinars shape. A legacy row
 * with a negative or fractional stored amount would otherwise fail
 * `dinarsSchema` output validation and blank the whole list/detail page, so
 * the store clamps at the edge instead of letting one bad row 500 the screen
 * (the dashboard's degrade-one-section precedent).
 */
const safeWhole = (value: SqlScalar): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(parsed))) : 0;
};

/**
 * Coerce a SIGNED aggregate (the supplier account balance) without the
 * non-negativity clamp `safeWhole` applies. A negative balance is a legitimate
 * credit («يسالنا»), so clamping it to 0 would make the list disagree with the
 * supplier detail and /debts (issue 176). Only the safe-integer ceiling and
 * non-finite values are guarded. */
const safeSignedWhole = (value: SqlScalar): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const truncated = Math.trunc(parsed);
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(-Number.MAX_SAFE_INTEGER, truncated));
};

type SqlPartyStats = { invoiceCount: SqlScalar; totalAmount: SqlScalar; paidAmount: SqlScalar; remainingAmount: SqlScalar };

const safePartyStats = (stats: Partial<SqlPartyStats>): PartyStats => ({
  invoiceCount: safeWhole(stats.invoiceCount),
  totalAmount: safeWhole(stats.totalAmount),
  paidAmount: safeWhole(stats.paidAmount),
  remainingAmount: safeWhole(stats.remainingAmount),
});
const lineCols = {
  id: invoiceLines.id,
  invoiceId: invoiceLines.invoiceId,
  itemId: invoiceLines.itemId,
  description: invoiceLines.description,
  quantity: invoiceLines.quantity,
  defaultUnitPrice: invoiceLines.defaultUnitPrice,
  unitPrice: invoiceLines.unitPrice,
  costAtSale: invoiceLines.costAtSale,
  cogsExact: invoiceLines.cogsExact,
  total: invoiceLines.total,
  discountAllocated: invoiceLines.discountAllocated,
  netTotal: invoiceLines.netTotal,
};
const paymentCols = {
  id: payments.id,
  invoiceId: payments.invoiceId,
  amount: payments.amount,
  method: payments.method,
  note: payments.note,
  paidAt: payments.paidAt,
  createdAt: payments.createdAt,
};
const activityCols = { id: activities.id, at: activities.at, type: activities.type, summary: activities.summary, ref: activities.ref };
const expenseCategoryCols = {
  id: expenseCategories.id,
  name: expenseCategories.name,
  isOwnerWithdrawal: expenseCategories.isOwnerWithdrawal,
  createdAt: expenseCategories.createdAt,
  updatedAt: expenseCategories.updatedAt,
};
const expenseCols = {
  id: expenses.id,
  categoryId: expenses.categoryId,
  amount: expenses.amount,
  note: expenses.note,
  occurredAt: expenses.occurredAt,
  createdAt: expenses.createdAt,
};
const movementCols = {
  id: stockMovements.id,
  itemId: stockMovements.itemId,
  kind: stockMovements.kind,
  delta: stockMovements.delta,
  unitCost: stockMovements.unitCost,
  reason: stockMovements.reason,
  ref: stockMovements.ref,
  returnMark: stockMovements.returnMark,
  occurredAt: stockMovements.occurredAt,
  createdAt: stockMovements.createdAt,
};
const returnLineCols = {
  id: returnLines.id,
  returnId: returnLines.returnId,
  invoiceLineId: returnLines.invoiceLineId,
  itemId: returnLines.itemId,
  description: returnLines.description,
  quantity: returnLines.quantity,
  refundUnitPrice: returnLines.refundUnitPrice,
  refundAmount: returnLines.refundAmount,
};

// returning() yields snake_case rows; these mappers convert the seven shapes
// we write back into their contract camelCase forms, checked with satisfies.
const toCategory = (r: typeof categories.$inferSelect): Category =>
  ({ id: r.id, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt }) satisfies Category;
const toItem = (r: typeof items.$inferSelect): Item =>
  ({ id: r.id, name: r.name, barcode: r.barcode, categoryId: r.categoryId, costPrice: r.costPrice, sellingPrice: r.sellingPrice, lowStockThreshold: r.lowStockThreshold, stockOnHand: r.stockOnHand, createdAt: r.createdAt, updatedAt: r.updatedAt }) satisfies Item;
/** Legacy rows predate subtotal_amount; a read-time heuristic maps the
 * pre-discount shape (no discount, subtotal 0, nonzero total) back to total.
 * New rows always carry a real subtotal, so the rewrite can never fire on
 * them; kept here once so toInvoice/getInvoiceDetail/listInvoices agree. */
function normalizeInvoiceLegacy(row: typeof invoices.$inferSelect): Pick<Invoice, "subtotalAmount" | "discountType" | "discountValue" | "discountAmount"> {
  return {
    subtotalAmount: row.subtotalAmount === 0 && row.totalAmount > 0 && row.discountType === null && (row.discountAmount ?? 0) === 0 ? row.totalAmount : row.subtotalAmount,
    discountType: row.discountType ?? null,
    discountValue: row.discountValue ?? null,
    discountAmount: row.discountAmount ?? 0,
  };
}

/**
 * Map invoice rows for the recent list. A malformed legacy row can throw inside
 * normalizeInvoiceLegacy, and that must degrade this one section rather than
 * reject the whole summary and blank the money figures that already succeeded.
 * Sitting outside the allSettled boundary is exactly how the original bug
 * worked, so the guard lives here.
 */
function mapRecentInvoices(rows: Array<typeof invoices.$inferSelect>): Invoice[] | null {
  try {
    return rows.map((row) => ({ ...row, ...normalizeInvoiceLegacy(row) }) satisfies Invoice);
  } catch {
    return null;
  }
}

const toCustomer = (r: typeof customers.$inferSelect): Customer =>
  ({ id: r.id, name: r.name, phone: r.phone, createdAt: r.createdAt }) satisfies Customer;
const toSupplier = (r: typeof suppliers.$inferSelect): Supplier =>
  ({ id: r.id, name: r.name, phone: r.phone, createdAt: r.createdAt }) satisfies Supplier;
const toInvoice = (r: typeof invoices.$inferSelect): Invoice =>
  ({ id: r.id, invoiceNumber: r.invoiceNumber, kind: r.kind, counterpartyId: r.counterpartyId, counterpartyName: r.counterpartyName, invoiceDate: r.invoiceDate, ...normalizeInvoiceLegacy(r), totalAmount: r.totalAmount, paidAmount: r.paidAmount, remainingAmount: r.remainingAmount, notes: r.notes, createdAt: r.createdAt, updatedAt: r.updatedAt }) satisfies Invoice;
const toInvoiceLine = (r: typeof invoiceLines.$inferSelect): InvoiceLine =>
  ({
    id: r.id,
    invoiceId: r.invoiceId,
    itemId: r.itemId,
    description: r.description,
    quantity: r.quantity,
    defaultUnitPrice: r.defaultUnitPrice ?? r.unitPrice,
    unitPrice: r.unitPrice,
    costAtSale: r.costAtSale,
    cogsExact: r.cogsExact,
    total: r.total,
    discountAllocated: r.discountAllocated ?? 0,
    netTotal: r.netTotal ?? r.total,
  }) satisfies InvoiceLine;
const toPayment = (r: typeof payments.$inferSelect): Payment =>
  ({ id: r.id, invoiceId: r.invoiceId, amount: r.amount, method: r.method, note: r.note, paidAt: r.paidAt, createdAt: r.createdAt }) satisfies Payment;
const toMovement = (r: typeof stockMovements.$inferSelect): StockMovement =>
  ({ id: r.id, itemId: r.itemId, kind: r.kind, delta: r.delta, unitCost: r.unitCost, reason: r.reason, ref: r.ref, returnMark: r.returnMark, occurredAt: r.occurredAt, createdAt: r.createdAt }) satisfies StockMovement;
/** The movement rows carry return_mark; the contracts shape exposes it as returnMark. */
const toReturn = (r: (typeof returns.$inferSelect) & { invoice_number: string; invoice_date: string; counterparty_name: string | null }): ReturnDetail =>
  ({
    id: r.id,
    returnNumber: r.returnNumber,
    invoiceId: r.invoiceId,
    invoiceNumber: r.invoice_number,
    invoiceDate: r.invoice_date,
    counterpartyName: r.counterparty_name,
    refundAmount: r.refundAmount,
    cashPaidOut: r.cashPaidOut,
    debtOffset: r.debtOffset,
    debtApplied: r.debtApplied,
    payoutMethod: r.payoutMethod,
    reason: r.reason,
    status: r.status,
    occurredAt: r.occurredAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lines: [],
  }) satisfies ReturnDetail;
const toReturnLine = (r: typeof returnLines.$inferSelect): ReturnDetail["lines"][number] =>
  ({
    id: r.id,
    returnId: r.returnId,
    invoiceLineId: r.invoiceLineId,
    itemId: r.itemId,
    description: r.description,
    quantity: r.quantity,
    refundUnitPrice: r.refundUnitPrice,
    refundAmount: r.refundAmount,
  }) satisfies ReturnDetail["lines"][number];
const toExpenseCategory = (r: typeof expenseCategories.$inferSelect): ExpenseCategory =>
  ({ id: r.id, name: r.name, isOwnerWithdrawal: r.isOwnerWithdrawal === 1, createdAt: r.createdAt, updatedAt: r.updatedAt }) satisfies ExpenseCategory;
const toExpense = (r: typeof expenses.$inferSelect): Expense =>
  ({ id: r.id, categoryId: r.categoryId, amount: r.amount, note: r.note, occurredAt: r.occurredAt, createdAt: r.createdAt }) satisfies Expense;
const toStockLink = (r: typeof stockLinks.$inferSelect): StockLink =>
  ({ id: r.id, invoiceId: r.invoiceId, movementId: r.movementId, quantity: r.quantity, createdAt: r.createdAt }) satisfies StockLink;

/** A supplier account entry joined to its invoice number (nullable). */
type SupplierEntryRow = {
  id: string;
  supplierId: string;
  kind: SupplierEntryKind;
  amount: number;
  direction: SupplierAdjustmentDirection | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  method: PaymentMethod | null;
  note: string | null;
  ref: string | null;
  occurredAt: string;
  createdAt: string;
};
const toSupplierEntry = (r: SupplierEntryRow): SupplierAccountEntry => ({
  id: r.id,
  supplierId: r.supplierId,
  kind: r.kind,
  amount: r.amount,
  direction: r.direction,
  invoiceId: r.invoiceId,
  invoiceNumber: r.invoiceNumber,
  method: r.method,
  note: r.note,
  ref: r.ref,
  occurredAt: r.occurredAt,
  createdAt: r.createdAt,
});

const toSupplierReturnLine = (r: typeof supplierReturnLines.$inferSelect): SupplierReturnRecord["lines"][number] => ({
  id: r.id,
  returnId: r.returnId,
  invoiceLineId: r.invoiceLineId,
  itemId: r.itemId,
  description: r.description,
  quantity: r.quantity,
  unitCost: r.unitCost,
  amount: r.amount,
});

const toSupplierReturn = (
  r: typeof supplierReturns.$inferSelect & { invoice_number: string | null; supplier_name: string | null },
): SupplierReturnRecord => ({
  id: r.id,
  returnNumber: r.returnNumber,
  supplierId: r.supplierId,
  supplierName: r.supplier_name,
  invoiceId: r.invoiceId,
  invoiceNumber: r.invoice_number,
  kind: r.kind,
  amount: r.amount,
  debtReduction: r.debtReduction,
  credit: r.credit,
  cashBack: r.cashBack,
  reason: r.reason,
  occurredAt: r.occurredAt,
  createdAt: r.createdAt,
  lines: [],
});

/**
 * Seed the default expense categories atomically with a durable marker, and
 * SELF-HEAL partial seeds left by a boot interrupted mid-seed (the pre-fix
 * loop committed row by row, so a crash between inserts left a marker-less
 * non-empty table that the old count===0 guard would skip forever — the
 * owner-withdrawal category could go missing).
 *
 * - Fresh table → all defaults + marker land in ONE transaction.
 * - Marker-less table whose rows are ALL default names → a partial seed from
 *   the legacy loop (or a crash between seed and marker write): resume with
 *   INSERT ... ON CONFLICT(name) DO NOTHING so missing defaults, including
 *   the flagged withdrawal category, appear exactly once.
 * - Any other non-empty table (owner-created categories present) → the
 *   "defaults only when empty" upgrade policy holds: nothing is added and
 *   user categories or renamed defaults are never duplicated.
 *
 * The unit opens with BEGIN IMMEDIATE — the write lock is reserved BEFORE
 * the marker/rows read (same primitive as StorePort.withTransactionImmediate,
 * which setup() cannot call here: it already holds the serialization queue,
 * and re-entering it would deadlock). Two processes racing boot on a
 * fresh/partially-seeded database otherwise BOTH read under a deferred
 * snapshot and the loser dies with SQLITE_BUSY_SNAPSHOT mid-startup; with
 * the immediate begin the loser waits on busy_timeout, then re-runs as a
 * no-op against the winner's committed marker.
 */
export const seedExpenseCategories = (conn: Connection): void => {
  conn.raw.exec("BEGIN IMMEDIATE");
  try {
    // SAFETY: fixed SQL identifiers and bound parameters only; the cast
    // promises the exact keys the literal SELECT produces
    const existing = conn.raw.query("SELECT name FROM expense_categories").all() as Array<{ name: string }>;
    // SAFETY: the literal SELECT reads the marker key; the cast promises the
    // single string column the settings row exposes
    const marker = conn.raw.query("SELECT value FROM settings WHERE key = ?").all(EXPENSE_CATEGORIES_MARKER) as Array<{ value: string }>;
    // the read and the writes share one transaction, so a crash mid-seed
    // either commits everything or nothing and the next boot resumes from
    // the marker state deterministically
    const names = new Set(existing.map((row) => row.name));
    const partialDefaultSeed =
      existing.length > 0 &&
      marker.length === 0 &&
      existing.every((row) => EXPENSE_CATEGORY_DEFAULTS.some((candidate) => candidate.name === row.name));
    if (existing.length === 0 || partialDefaultSeed) {
      for (const category of EXPENSE_CATEGORY_DEFAULTS) {
        if (names.has(category.name)) continue;
        const inserted = conn.raw
          .query("INSERT INTO expense_categories (id, name, is_owner_withdrawal, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO NOTHING")
          .run(id(), category.name, category.isOwnerWithdrawal ? 1 : 0, now(), now());
        // SAFETY: the unique-name conflict path is the idempotency guard;
        // nothing is written twice by definition
        void inserted;
      }
      conn.raw.query("INSERT INTO settings (key, value) VALUES (?, 'done') ON CONFLICT(key) DO NOTHING").run(EXPENSE_CATEGORIES_MARKER);
    }
    conn.raw.exec("COMMIT");
  } catch (err) {
    conn.raw.exec("ROLLBACK");
    throw err;
  }
};

/** Durable marker: the typed-name backfill ran to completion. */
const COUNTERPARTY_BACKFILL_MARKER = "migration.counterpartyBackfillV1";

/**
 * One-time backfill (ADR-0007, issue 120): legacy invoices stored only a typed
 * `counterparty_name` with a null id. Create one party per distinct trimmed
 * name and point the matching invoices at it, so the debts page and the new
 * customers pages group by identity instead of by spelling («علي علي» vs
 * «على علي» are two debtors today).
 *
 * Marker-gated AND self-healing: an existing same-named party is reused, so a
 * crashed or raced run resumes without duplicating a debtor, and the UPDATE
 * only touches invoices that still have a null id. BEGIN IMMEDIATE reserves
 * the write lock before the marker read, so two processes booting the same
 * legacy database converge (the loser waits on busy_timeout, then sees the
 * winner's marker). The invoice's `counterparty_name` is never rewritten.
 */
export const backfillCounterparties = (conn: Connection): void => {
  conn.raw.exec("BEGIN IMMEDIATE");
  try {
    // SAFETY: settings.key is the primary key; this literal SELECT yields one
    // string column per row, so the cast names what the driver already returns.
    const marker = conn.raw.query("SELECT value FROM settings WHERE key = ?").all(COUNTERPARTY_BACKFILL_MARKER) as Array<{ value: string }>;
    if (marker.length > 0) {
      conn.raw.exec("COMMIT");
      return;
    }
    // SAFETY: Object.keys over a closed const map yields exactly its keys,
    // which are the PartyRole literals; the index then reads that same map.
    const kinds = (Object.keys(partyInvoiceKind) as PartyRole[]).map((role) => ({ kind: partyInvoiceKind[role], table: PARTY_TABLES[role] }));
    for (const { kind, table } of kinds) {
      // SAFETY: fixed SQL identifiers and bound parameters; the distinct names
      // are the only data read and every write binds them.
      const rawNames = conn.raw
        .query(
          `SELECT DISTINCT TRIM(counterparty_name) AS name FROM invoices
           WHERE kind = ? AND counterparty_id IS NULL AND counterparty_name IS NOT NULL AND TRIM(counterparty_name) <> ''
           ORDER BY name`,
        )
        .all(kind) as Array<{ name: string }>;
      // Collapse spellings that are the same identity (case, double spaces,
      // diacritics, tatweel, bidi marks) with the SAME key the picker matches
      // on, so the backfill cannot leave «علي  علي» as a second debtor. JS trim
      // also drops NBSP/tab-only names that SQLite's TRIM passes through.
      // One pass builds every group and its spellings; the write loop below
      // never rescans the full name set.
      const groups = new Map<string, { representative: string; spellings: string[] }>();
      for (const { name } of rawNames) {
        const key = normalizeTextKey(name);
        if (key === "") continue;
        const group = groups.get(key);
        if (group === undefined) groups.set(key, { representative: name, spellings: [name] });
        else group.spellings.push(name);
      }
      // SAFETY: the party table's id/name columns are TEXT (db/schema.ts);
      // the SELECT is ordered so a duplicate-name reuse target is deterministic.
      const existingParties = conn.raw.query(`SELECT id, name FROM ${table} ORDER BY created_at, id`).all() as Array<{ id: string; name: string }>;
      for (const [key, group] of groups) {
        const existing = existingParties.find((party) => normalizeTextKey(party.name) === key);
        const partyId = existing?.id ?? id();
        if (existing === undefined) {
          conn.raw.query(`INSERT INTO ${table} (id, name, phone, created_at) VALUES (?, ?, NULL, ?)`).run(partyId, group.representative, now());
        }
        for (const spelling of group.spellings) {
          conn.raw.query(`UPDATE invoices SET counterparty_id = ? WHERE kind = ? AND counterparty_id IS NULL AND TRIM(counterparty_name) = ?`).run(partyId, kind, spelling);
        }
      }
    }
    conn.raw.query("INSERT INTO settings (key, value) VALUES (?, 'done') ON CONFLICT(key) DO NOTHING").run(COUNTERPARTY_BACKFILL_MARKER);
    conn.raw.exec("COMMIT");
  } catch (err) {
    conn.raw.exec("ROLLBACK");
    throw err;
  }
};

const SUPPLIER_ACCOUNT_MARKER = "migration.supplierAccountV1";

/**
 * One-time backfill of supplier accounts for existing PURCHASE invoices
 * (develop fixtures / upgraded installs, issue 161). Creates a PURCHASE charge
 * for every id-backed purchase invoice and one PAYMENT entry for its already-
 * paid amount, so the signed balance agrees with the invoice debt the app
 * already showed (the `paid_amount` cache, not a sum of payment rows — a legacy
 * invoice could carry a paid amount without a matching row). Customer SALE
 * invoices are untouched. Marker-gated AND `NOT EXISTS`-guarded, so a lost
 * marker can never double-charge a supplier. Runs inside one transaction, so an
 * interrupted boot re-runs the pair instead of silently skipping it. Ids are
 * real UUIDs because the account contract validates them on the way out.
 */
export const backfillSupplierAccounts = (conn: Connection): void => {
  conn.raw.exec("BEGIN IMMEDIATE");
  try {
    // SAFETY: settings.key is the primary key; this literal SELECT yields one
    // string column per row, so the cast names what the driver already returns.
    const marker = conn.raw.query("SELECT value FROM settings WHERE key = ?").all(SUPPLIER_ACCOUNT_MARKER) as Array<{ value: string }>;
    if (marker.length > 0) {
      conn.raw.exec("COMMIT");
      return;
    }
    // SAFETY: the SELECT aliases exactly these columns from invoices, whose
    // types are fixed by db/schema.ts. total_amount > 0 keeps the ledger's
    // CHECK(amount > 0) from aborting boot on a legacy zero-total purchase;
    // the EXISTS keeps an orphaned counterparty_id (pre-#120 data) from
    // violating the suppliers(id) foreign key; the NOT EXISTS is the second
    // idempotency guard behind the marker.
    const invoiceRows = conn.raw
      .query("SELECT id, counterparty_id AS supplierId, total_amount AS totalAmount, paid_amount AS paidAmount, created_at AS createdAt FROM invoices WHERE kind = 'PURCHASE' AND counterparty_id IS NOT NULL AND total_amount > 0 AND EXISTS (SELECT 1 FROM suppliers s WHERE s.id = invoices.counterparty_id) AND NOT EXISTS (SELECT 1 FROM supplier_account_entries e WHERE e.invoice_id = invoices.id AND e.kind = 'PURCHASE')")
      .all() as Array<{ id: string; supplierId: string; totalAmount: number; paidAmount: number; createdAt: string }>;
    const insertEntry = conn.raw.query(
      "INSERT INTO supplier_account_entries (id, supplier_id, kind, amount, invoice_id, method, note, ref, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
    );
    for (const invoice of invoiceRows) {
      insertEntry.run(id(), invoice.supplierId, "PURCHASE", invoice.totalAmount, invoice.id, null, null, invoice.createdAt, invoice.createdAt);
      if (invoice.paidAmount > 0) {
        insertEntry.run(id(), invoice.supplierId, "PAYMENT", invoice.paidAmount, invoice.id, null, null, invoice.createdAt, invoice.createdAt);
      }
    }
    conn.raw.query("INSERT INTO settings (key, value) VALUES (?, 'done') ON CONFLICT(key) DO NOTHING").run(SUPPLIER_ACCOUNT_MARKER);
    conn.raw.exec("COMMIT");
  } catch (err) {
    conn.raw.exec("ROLLBACK");
    throw err;
  }
};

type DebtSummaryRow = {
  kind: unknown;
  counterparty_id: unknown;
  counterparty_name: unknown;
  remaining_total: unknown;
  invoice_count: unknown;
  oldest_date: unknown;
  latest_date: unknown;
  account_balance: unknown;
};

/**
 * Store methods that write to the database. The vault connection must be told
 * when the in-memory image changes; the wrapper below marks it before the
 * queued call runs. Read-only methods are absent on purpose, so a page load
 * never triggers a snapshot write.
 */
const MUTATING_METHODS: ReadonlySet<keyof StorePort> = new Set([
  "setup",
  "createCategory",
  "createItem",
  "updateItem",
  "setItemStockAndCost",
  "insertStockMovement",
  "insertStockLink",
  "createExpenseCategory",
  "insertExpense",
  "createParty",
  "updateParty",
  "deleteParty",
  "allocateInvoiceNumber",
  "allocateReturnNumber",
  "insertReturn",
  "insertReturnLine",
  "transitionReturnStatus",
  "applyDebtOffsetToInvoice",
  "setDebtApplied",
  "setReturnMarks",
  "setReturnReason",
  "insertInvoice",
  "insertInvoiceLine",
  "insertPayment",
  "applyPaymentToInvoice",
  "setInvoicePaidAmounts",
  "insertSupplierEntry",
  "insertSupplierAdjustment",
  "allocateSupplierReturnNumber",
  "insertSupplierReturn",
  "insertSupplierReturnLine",
  "recordOnboardingCompletion",
  "insertActivity",
  "setSetting",
  "setPreference",
  "updateSettings",
]);

/**
 * SQLite adapter for StorePort, built on Drizzle + bun:sqlite.
 * This file is the only place that knows the driver; everything above it
 * speaks StorePort (ADR-0003). A postgres adapter replaces this file, not
 * anything above it.
 */
export function createDrizzleStore(conn: Connection, logger?: StoreLogger): StorePort {
  const { db } = conn;

  /**
   * One queue guards the single SQLite connection (greptile: direct store
   * operations could interleave with open transactions). Transactions hold
   * the queue exclusively; plain operations either join an open transaction
   * safely (same connection) or wait behind it. Everything funnels through
   * serializeStore below.
   */
  let jobQueue: Promise<unknown> = Promise.resolve();
  const runSerialized = <T,>(job: () => Promise<T>): Promise<T> => {
    const run = jobQueue.then(job);
    jobQueue = run.catch(() => undefined);
    return run;
  };

  /**
   * Persist the vault image before success is reported. On ultimate failure
   * the connection's fail-stop hook runs (production exits the process) and a
   * typed error is rethrown: a SQLite unit that already committed must never
   * be reported as a failed business operation, because a client retry would
   * duplicate it. The caller must not ROLLBACK after this point.
   */
  const persistOrFail = async (): Promise<void> => {
    try {
      await conn.persistIfDirty();
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      logger?.error?.("SNAPSHOT_PERSIST_FAILED", "committed data could not be written to the encrypted snapshot", wrapped);
      conn.onFatalError?.(wrapped);
      throw wrapped;
    }
  };

  /** A store whose calls skip the queue: used inside transaction units, where
   * the unit itself already holds the queue. Never escapes withTransaction. */
  const directSeed = (raw: StorePort): StorePort =>
    // SAFETY: same key set and same values; no wrapper is applied
    Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value])) as StorePort;

  /** Shared BEGIN/COMMIT/ROLLBACK body for deferred and write-first units.
   * immediate=true uses BEGIN IMMEDIATE, which takes the write lock BEFORE the
   * first read — see withTransactionImmediate's comment for why money paths
   * need it (no SQLITE_BUSY_SNAPSHOT on read-to-write upgrade). */
  const runTransaction = <T>(immediate: boolean, fn: (tx: StorePort) => Promise<T>): Promise<T> => {
    // serialized against every other store call; the unit keeps the queue
    // for its whole run so no second BEGIN can appear mid-transaction. The
    // callback receives an unqueued store (directSeed) so its internal calls
    // never deadlock, while every EXTERNAL operation queues behind the unit
    // and can never land inside this transaction (greptile P1).
    return runSerialized(async () => {
      const tx = directSeed(store);
      conn.raw.exec(immediate ? "BEGIN IMMEDIATE" : "BEGIN");
      // set the flag only after BEGIN succeeded: a failed BEGIN must never
      // leave persistence permanently disabled, and the catch below must only
      // run with a real open transaction
      conn.inTransaction = true;
      let committed = false;
      try {
        const result = await fn(tx);
        conn.raw.exec("COMMIT");
        committed = true;
        // the unit committed: vault mode must persist the image before the
        // caller sees the result (a crash after a money response must not
        // lose the money); the file-backed connection ignores this seam
        conn.inTransaction = false;
        conn.markDirty();
        await persistOrFail();
        return result;
      } catch (err) {
        conn.inTransaction = false;
        // only a unit that never committed may be rolled back; after COMMIT a
        // failed snapshot write is fail-stop (never reported as a failed call)
        if (!committed) {
          try {
            conn.raw.exec("ROLLBACK");
          } catch {
            // a failed BEGIN leaves no transaction to roll back
          }
        }
        throw err;
      }
    });
  };

  const serializeStore = (raw: StorePort): StorePort => {
    // SAFETY: a port object exposes only documented members
    const entries = Object.entries(raw) as Array<[keyof StorePort, unknown]>;
    const wrapEntry = ([key, value]: readonly [keyof StorePort, unknown]): readonly [string, StorePort[keyof StorePort]] => {
      if (key === "withTransaction") {
        // SAFETY: withTransaction keeps its own serialization; no wrapper needed
        return [key, value as StorePort["withTransaction"]];
      }
      if (key === "withTransactionImmediate") {
        // SAFETY: same serialization contract as withTransaction; no wrapper needed
        return [key, value as StorePort["withTransactionImmediate"]];
      }
      // args are never[] (the object shape opaques them); R is resolved at
      // each call site to the raw method's real result type
      // SAFETY: value is the raw method this key names; binding the receiver
      // keeps this.*-style methods (settings, activities) callable without
      // changing the call signature (R resolves at each call site)
      const wrapped = <R,>(...args: never[]): Promise<R> =>
        runSerialized(async () => {
          // SAFETY: value is the raw method this key names (its result type is R);
          // .bind fixes the receiver, so this.*-style methods keep working
          const result = await (value as (...a: never[]) => Promise<R>).bind(raw)(...args);
          if (!MUTATING_METHODS.has(key)) return result;
          // A direct mutating call commits its own statement(s). Keep the call
          // and the snapshot write inside ONE queue slot, so the next queued
          // transaction cannot begin before the image is durable and success
          // is only reported after the write landed.
          conn.markDirty();
          await persistOrFail();
          return result;
        });
      // SAFETY: wrapped implements the raw method named by key via its generic R
      return [key, wrapped as StorePort[keyof StorePort]];
    };
    // SAFETY: fromEntries returns a plain dictionary keyed by the exact names,
    // so the value type is the method union indexed by those same keys
    const built = Object.fromEntries(entries.map(wrapEntry)) as Record<keyof StorePort, StorePort[keyof StorePort]>;
    // SAFETY: built mirrors raw's exact key set; every member is present
    return built as StorePort;
  };

  /**
   * Ticket 01 created auth tables with snake_case columns. Those tables were
   * empty before Better Auth was introduced, so rebuild that legacy shape
   * before the current DDL runs; CREATE TABLE IF NOT EXISTS cannot rename or
   * remove the old NOT NULL columns.
   */
  const rebuildLegacyAuthTables = (): void => {
    const tables = ["user", "session", "account", "verification"] as const;
    const looksLegacy = (table: string): boolean => {
      try {
        // SAFETY: PRAGMA table_info returns rows shaped { name, type, ... }
        const rows = conn.raw.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (rows.length === 0) return false; // table does not exist yet
        const names = new Set(rows.map((row) => row.name));
        return names.has("account_id") || names.has("provider_id") || names.has("user_id") || names.has("expires_at");
      } catch {
        return false; // table missing on fresh db
      }
    };
    const legacyTables = tables.filter(looksLegacy);
    const occupied = legacyTables.filter((table) => {
      // The table exists: its schema read succeeded above. A count failure is a
      // real error, not "empty", and swallowing it here would let startup reach
      // DROP TABLE and delete populated credential or session rows. Let it
      // abort the rebuild instead.
      // SAFETY: COUNT(*) returns one row with a numeric count
      const rows = conn.raw.query(`SELECT COUNT(*) AS count FROM ${table}`).all() as Array<{ count: number }>;
      return Number(rows[0]?.count ?? 0) > 0;
    });
    if (occupied.length > 0) {
      throw new Error(`cannot rebuild non-empty legacy auth tables: ${occupied.join(", ")}`);
    }
    for (const table of legacyTables) conn.raw.exec(`DROP TABLE ${table}`);
  };

  /**
   * Ticket 28: legacy databases predate the items.barcode column. CREATE
   * TABLE IF NOT EXISTS cannot add it, so ALTER here when missing. New
   * databases get the column from DDL and skip this entirely.
   */
  const ensureItemsBarcodeColumn = (): void => {
    // SAFETY: PRAGMA table_info returns rows shaped { name, type, ... }
    const rows = conn.raw.query("PRAGMA table_info(items)").all() as Array<{ name: string }>;
    if (rows.length > 0 && !rows.some((row) => row.name === "barcode")) {
      conn.raw.exec("ALTER TABLE items ADD COLUMN barcode TEXT");
    }
  };

  /** Legacy databases predate stock_movements.return_mark (a nullable review
   * tag; null = not a return movement). CREATE TABLE IF NOT EXISTS cannot add
   * it, so ALTER here when missing — the barcode pattern. */
  const ensureStockMovementsReturnMarkColumn = (): void => {
    // SAFETY: PRAGMA table_info returns rows shaped { name, type, ... }
    const rows = conn.raw.query("PRAGMA table_info(stock_movements)").all() as Array<{ name: string }>;
    if (rows.length > 0 && !rows.some((row) => row.name === "return_mark")) {
      conn.raw.exec("ALTER TABLE stock_movements ADD COLUMN return_mark TEXT");
    }
  };

  /**
   * Issue 176: version-2 databases predate the manual-adjustment direction
   * column. CREATE TABLE IF NOT EXISTS cannot add it, so ALTER here when
   * missing (the barcode pattern), idempotent by construction. Every existing
   * row keeps `direction = NULL`, which is exactly right for the pre-existing
   * kinds; no data backfill is needed. Fresh databases get the column from
   * SCHEMA_DDL and skip this.
   */
  const ensureSupplierAdjustmentDirectionColumn = (): void => {
    // SAFETY: PRAGMA table_info returns rows shaped { name, type, ... }
    const rows = conn.raw.query("PRAGMA table_info(supplier_account_entries)").all() as Array<{ name: string }>;
    if (rows.length > 0 && !rows.some((row) => row.name === "direction")) {
      conn.raw.exec("ALTER TABLE supplier_account_entries ADD COLUMN direction TEXT");
    }
  };

  /** Settlement columns (cashPaidOut / debtOffset) for databases that predate
   * the owner-approved cash/debt split. ALTER when missing (barcode pattern);
   * rows created before the split carry cash 0 + debt 0 + a real refund, which
   * the backfill reclassifies as all-cash (they were cash refunds). Not
   * marker-gated: the row invariant (cash=0 AND debt=0 AND refund>0) cannot
   * match a genuine post-split row (whose two amounts always sum to the
   * return value, so at most one is zero). */
  const ensureReturnsSettlementColumns = (): void => {
    // SAFETY: PRAGMA table_info returns rows shaped { name, type, ... }
    const rows = conn.raw.query("PRAGMA table_info(returns)").all() as Array<{ name: string }>;
    const names = new Set(rows.map((row) => row.name));
    if (rows.length > 0 && !names.has("cash_paid_out")) {
      conn.raw.exec("ALTER TABLE returns ADD COLUMN cash_paid_out INTEGER NOT NULL DEFAULT 0");
    }
    if (rows.length > 0 && !names.has("debt_offset")) {
      conn.raw.exec("ALTER TABLE returns ADD COLUMN debt_offset INTEGER NOT NULL DEFAULT 0");
    }
    if (rows.length > 0) {
      conn.raw.exec("UPDATE returns SET cash_paid_out = refund_amount WHERE cash_paid_out = 0 AND debt_offset = 0 AND refund_amount > 0");
    }
    // #68: the applied portion. Legacy (pre-fix) rows had their ENTIRE
    // debtOffset applied at creation — the old code settled the debt in the
    // same unit as the insert and never reverted it on accept/reject — so the
    // backfill marks every existing row as fully applied. New rows are created
    // with debt_applied = 0 and gain their portion on acceptance. This is what
    // lets returnsAccept apply min(debtOffset − debtApplied, remaining) and
    // never double-relieve a debt that was already settled pre-fix.
    // The ALTER + backfill are ONE transaction (the ensureSaleColumns marker
    // pattern): a boot interrupted between them rolls back, so the next setup
    // re-runs the pair instead of silently skipping the backfill forever.
    if (rows.length > 0 && !names.has("debt_applied")) {
      conn.raw.exec("BEGIN IMMEDIATE");
      try {
        conn.raw.exec("ALTER TABLE returns ADD COLUMN debt_applied INTEGER NOT NULL DEFAULT 0");
        conn.raw.exec("UPDATE returns SET debt_applied = debt_offset");
        conn.raw.exec("COMMIT");
      } catch (error) {
        conn.raw.exec("ROLLBACK");
        throw error;
      }
    }
  };

  /** Additive ticket #30 columns for databases created before discounts. */
  /** Additive ticket #30 columns created with a durable completion marker.
   * The historical-data backfill is tracked by the marker, NOT by column
   * presence: a boot interrupted between the ALTERs and the UPDATEs would
   * otherwise see the columns on restart and silently skip the backfill
   * forever (greptile P1). The marker + DDL + backfill are one SQLite
   * transaction, so an interrupted upgrade either leaves everything pending
   * or completes everything; the next setup() re-runs until the marker lands. */
  const ensureSaleColumns = (): void => {
    // SAFETY: only fixed SQL identifiers are interpolated; each ALTER is
    // guarded by PRAGMA so repeated setup calls are idempotent.
    conn.raw.exec("BEGIN");
    try {
      // SAFETY: PRAGMA table_info returns one object with a string name per column.
      const invoiceRows = conn.raw.query("PRAGMA table_info(invoices)").all() as Array<{ name: string }>;
      const invoiceNames = new Set(invoiceRows.map((row) => row.name));
      const invoiceColumns: Array<[string, string]> = [
        ["subtotal_amount", "INTEGER NOT NULL DEFAULT 0"],
        ["discount_type", "TEXT"],
        ["discount_value", "INTEGER"],
        ["discount_amount", "INTEGER NOT NULL DEFAULT 0"],
      ];
      for (const [name, definition] of invoiceColumns) {
        if (invoiceRows.length > 0 && !invoiceNames.has(name)) conn.raw.exec(`ALTER TABLE invoices ADD COLUMN ${name} ${definition}`);
      }

      // SAFETY: PRAGMA table_info returns one object with a string name per column.
      const lineRows = conn.raw.query("PRAGMA table_info(invoice_lines)").all() as Array<{ name: string }>;
      const lineNames = new Set(lineRows.map((row) => row.name));
      const lineColumns: Array<[string, string]> = [
        ["default_unit_price", "INTEGER NOT NULL DEFAULT 0"],
        ["discount_allocated", "INTEGER NOT NULL DEFAULT 0"],
        ["net_total", "INTEGER NOT NULL DEFAULT 0"],
      ];
      for (const [name, definition] of lineColumns) {
        if (lineRows.length > 0 && !lineNames.has(name)) conn.raw.exec(`ALTER TABLE invoice_lines ADD COLUMN ${name} ${definition}`);
      }

      // Exact per-line COGS (issue 43 follow-up on ADR-0005): one additive
      // column; legacy rows backfill quantity × cost_at_sale — exact for
      // PURCHASE rows (cost was the unit cost); the old report formula for
      // SALE rows written between #30 and #43 (they predate the exact
      // snapshot); the documented approximation for the pre-#30 stub era.
      if (lineRows.length > 0 && !lineNames.has("cogs_exact")) conn.raw.exec("ALTER TABLE invoice_lines ADD COLUMN cogs_exact INTEGER NOT NULL DEFAULT 0");

      // SAFETY: settings.key is PRIMARY KEY; a supported query yields one
      // object with a single string value per row.
      const markerRows = conn.raw.query("SELECT value FROM settings WHERE key = ?").all("migration.saleColumnsV1") as Array<{ value: string }>;
      if (markerRows.length === 0) {
        // Legacy rows predate these values. Each UPDATE is target-restricted by
        // the row INVARIANT a pre-migration row provably has, not by column
        // presence alone. Domain facts: before ticket #30, SALE was a stub, so
        // every pre-existing invoice line is kind=PURCHASE whose unitPrice is
        // its cost basis (no overrides existed) and whose discount columns
        // carry the new-column defaults. That is exactly the shape tested
        // here (default 0, unit > 0, allocated 0, net 0). Post-ticket-30
        // checkout can legitimately persist a zero default price with a
        // negotiated positive unitPrice (item priced 0, owner charges more)
        // on a markerless upgraded DB, and such a line can never match: when
        // undiscounted, net = gross − 0 > 0; when discounted, allocated > 0;
        // only a free unit (0) evades both, and that is excluded by unit > 0.
        // An already-migrated or partially-migrated database re-runs as a
        // no-op, and legit modern zeros are never rewritten.
        conn.raw.exec("UPDATE invoices SET subtotal_amount = total_amount WHERE subtotal_amount = 0 AND total_amount > 0 AND discount_type IS NULL AND (discount_amount IS NULL OR discount_amount = 0)");
        conn.raw.exec("UPDATE invoice_lines SET default_unit_price = unit_price WHERE default_unit_price = 0 AND unit_price > 0 AND discount_allocated = 0 AND net_total = 0");
        conn.raw.exec("UPDATE invoice_lines SET net_total = total WHERE net_total = 0 AND discount_allocated = 0 AND total > 0");
        conn.raw.exec("INSERT INTO settings (key, value) VALUES ('migration.saleColumnsV1', 'done') ON CONFLICT(key) DO NOTHING");
      }
      // Self-healing repair, NOT marker-gated: a pre-migration row (or one
      // written by a build that predates this column) carries cogs_exact = 0
      // while cost_at_sale > 0 → the report would silently understate COGS.
      // The row invariants make the UPDATE idempotent and re-run-safe: rows
      // the migration just backfilled keep their value, and modern rows
      // always write exact > 0 whenever cost_at_sale > 0 (a positive exact
      // sum is possible only when some consumed layer cost more than 0). A
      // row whose cost_at_sale ROUNDED to zero while its layers cost a
      // fraction of a DZD is left as the pre-#43 formula reported it — the
      // exact figure is unrecoverable from the rounded snapshot, and this
      // repair never claims more accuracy than the old report had. A marker
      // is still written for diagnostics/evidence, but column presence alone
      // can never skip the repair (greptile-P1 symmetric trap: a rollback to
      // a pre-#43 build writes DEFAULT 0 on naive inserts, and the next #43
      // boot must heal those rows even though the marker exists).
      // SAFETY: settings.key is PRIMARY KEY; a supported query yields one
      // object with a single string value per row.
      const cogsMarker = conn.raw.query("SELECT value FROM settings WHERE key = ?").all("migration.cogsExactV1") as Array<{ value: string }>;
      if (cogsMarker.length === 0) {
        conn.raw.exec("INSERT INTO settings (key, value) VALUES ('migration.cogsExactV1', 'done') ON CONFLICT(key) DO NOTHING");
      }
      conn.raw.exec("UPDATE invoice_lines SET cogs_exact = quantity * cost_at_sale WHERE cogs_exact = 0 AND quantity > 0 AND cost_at_sale > 0");
      conn.raw.exec("COMMIT");
    } catch (err) {
      conn.raw.exec("ROLLBACK");
      throw err;
    }
  };

  /**
   * Seed the default expense categories atomically with a durable marker, and
   * SELF-HEAL partial seeds left by a boot interrupted mid-seed (the pre-fix
   * loop committed row by row, so a crash between inserts left a marker-less
   * non-empty table that the old count===0 guard would skip forever — the
   * owner-withdrawal category could go missing).
   *
   * - Fresh table → all defaults + marker land in ONE transaction.
   * - Marker-less table whose rows are ALL default names → a partial seed from
   *   the legacy loop (or a crash between seed and marker write): resume with
   *   INSERT ... ON CONFLICT(name) DO NOTHING so missing defaults, including
   *   the flagged withdrawal category, appear exactly once.
   * - Any other non-empty table (owner-created categories present) → the
   *   "defaults only when empty" upgrade policy holds: nothing is added and
   *   user categories or renamed defaults are never duplicated.
   */
  async function setup(): Promise<void> {
    rebuildLegacyAuthTables();
    ensureItemsBarcodeColumn();
    ensureStockMovementsReturnMarkColumn();
    ensureSupplierAdjustmentDirectionColumn();
    ensureReturnsSettlementColumns();
    for (const ddl of SCHEMA_DDL) await db.run(sql.raw(ddl));
    ensureSaleColumns();
    // issue 120: point legacy typed-name invoices at real party records (once).
    // Deliberately fail-loud like every other migration in this file: a failed
    // identity backfill must not boot into name-grouped debts silently.
    backfillCounterparties(conn);
    // issue 161: give existing id-backed purchase invoices a signed supplier
    // account (charge + one payment entry per existing payment row). Runs after
    // the counterparty backfill so typed-name purchases now have a supplier id.
    backfillSupplierAccounts(conn);

    // The singleton seed is one conditional INSERT, so two processes opening
    // an existing database cannot both initialize a competing counter. The
    // numeric expression preserves the old lastInvoiceNumber behavior for
    // legacy/manual INV-* rows while the sequence owns future allocations.
    await db.run(sql`
      INSERT INTO invoice_number_sequence (id, next_number)
      SELECT 1, COALESCE((SELECT MAX(CASE
        WHEN invoice_number GLOB 'INV-[0-9]*' THEN CAST(substr(invoice_number, 5) AS INTEGER)
        ELSE 0
      END) FROM invoices), 0) + 1
      WHERE NOT EXISTS (SELECT 1 FROM invoice_number_sequence WHERE id = 1)
    `);

    // Same conditional seed for the return number sequence (RTN-%04d), so two
    // processes booting an existing database converge on one counter.
    await db.run(sql`
      INSERT INTO return_number_sequence (id, next_number)
      SELECT 1, COALESCE((SELECT MAX(CASE
        WHEN return_number GLOB 'RTN-[0-9]*' THEN CAST(substr(return_number, 5) AS INTEGER)
        ELSE 0
      END) FROM returns), 0) + 1
      WHERE NOT EXISTS (SELECT 1 FROM return_number_sequence WHERE id = 1)
    `);

    // Same conditional seed for the supplier-return number sequence (PRT-%04d).
    await db.run(sql`
      INSERT INTO supplier_return_number_sequence (id, next_number)
      SELECT 1, COALESCE((SELECT MAX(CASE
        WHEN return_number GLOB 'PRT-[0-9]*' THEN CAST(substr(return_number, 5) AS INTEGER)
        ELSE 0
      END) FROM supplier_returns), 0) + 1
      WHERE NOT EXISTS (SELECT 1 FROM supplier_return_number_sequence WHERE id = 1)
    `);

    const categoriesCount = await db.$count(categories);
    if (categoriesCount === 0) {
      await db.insert(categories).values({ id: id(), name: "عام", createdAt: now(), updatedAt: now() }).run();
    }
    // Expense categories seed once per database (ticket 31, greptile round at
    // 38c7adb): atomic + marker-gated self-heal — see seedExpenseCategories.
    seedExpenseCategories(conn);
    const storeName = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "storeName")).limit(1);
    if (storeName.length === 0) {
      await db.insert(settings).values({ key: "storeName", value: "Dokan" }).run();
      await db.insert(settings).values({ key: "storePhone", value: "" }).run();
    }

    // Opening-balance backfill (ticket 27): any item with no ledger history
    // gets exactly one synthetic "opening" movement derived from its current
    // stock/cost. The conditional INSERT..WHERE NOT EXISTS is atomic at the
    // SQLite statement level, so repeated setups (or a second process racing
    // boot) can never double-insert the opening row.
    const ledgerItems = await db.select(itemCols).from(items);
    for (const item of ledgerItems) {
      await db.run(sql`
        INSERT INTO stock_movements (id, item_id, kind, delta, unit_cost, reason, ref, occurred_at, created_at)
        SELECT ${id()}, ${item.id}, 'MANUAL_ADJUSTMENT', ${item.stockOnHand}, ${item.costPrice}, 'opening', NULL, ${item.createdAt}, ${now()}
        WHERE NOT EXISTS (SELECT 1 FROM stock_movements WHERE item_id = ${item.id})
      `);
    }

    // ADR-0008 §4.5: every forward migration above has run; stamp the data
    // format this build writes. The stamp is write-locked and re-reads the
    // version first: a newer build that opened the same file meanwhile must
    // never be overwritten with this build's older version. An interrupted
    // earlier boot left the version unstamped, so the next setup re-runs the
    // (idempotent) migrations.
    stampSchemaVersionLocked(conn.raw);
    // boot migrations write through raw exec and setup's own statements; mark
    // the vault image dirty so the first snapshot materialises even when the
    // store is otherwise only read from
    conn.markDirty();
    await conn.persistIfDirty();
  }

  /**
   * The store-owned identity rule (ADR-0007): a present phone is unique across
   * records. The partial unique indexes in SCHEMA_DDL are the cross-process
   * backstop, but SQLite treats NULLs as distinct and an index violation is
   * not a translated error, so the check runs here for a clear refusal.
   */
  const assertPhoneFree = (role: PartyRole, phone: string | null, excludeId: string | null): void => {
    if (phone === null) return;
    // Canonical-form comparison over the rows, not `WHERE phone = ?`: a row
    // written by a future import/adapter with a raw `0550 12 34 56` must not
    // escape the rule, and the partial unique index only compares raw strings.
    // SAFETY: the table name comes from a closed literal map (never input).
    const rows = conn.raw.query(`SELECT id, phone FROM ${PARTY_TABLES[role]} WHERE phone IS NOT NULL`).all() as Array<{ id: string; phone: string }>;
    if (rows.some((row) => row.id !== excludeId && normalizePartyPhone(row.phone) === phone)) throw new PartyError("PHONE_EXISTS");
  };

  const fetchParty = async (role: PartyRole, partyId: string): Promise<Party | undefined> => {
    if (role === "customer") {
      const rows = await db.select(customerCols).from(customers).where(eq(customers.id, partyId)).limit(1);
      return rows.length === 0 ? undefined : toCustomer(firstRowOf(rows));
    }
    const rows = await db.select(supplierCols).from(suppliers).where(eq(suppliers.id, partyId)).limit(1);
    return rows.length === 0 ? undefined : toSupplier(firstRowOf(rows));
  };

  /** One supplier's account entries, newest first, invoice number joined. */
  const listEntries = async (supplierId: string): Promise<SupplierAccountEntry[]> => {
    const rows = await db
      .select({
        id: supplierAccountEntries.id,
        supplierId: supplierAccountEntries.supplierId,
        kind: supplierAccountEntries.kind,
        amount: supplierAccountEntries.amount,
        direction: supplierAccountEntries.direction,
        invoiceId: supplierAccountEntries.invoiceId,
        invoiceNumber: invoices.invoiceNumber,
        method: supplierAccountEntries.method,
        note: supplierAccountEntries.note,
        ref: supplierAccountEntries.ref,
        occurredAt: supplierAccountEntries.occurredAt,
        createdAt: supplierAccountEntries.createdAt,
      })
      .from(supplierAccountEntries)
      .leftJoin(invoices, eq(invoices.id, supplierAccountEntries.invoiceId))
      .where(eq(supplierAccountEntries.supplierId, supplierId))
      .orderBy(desc(supplierAccountEntries.occurredAt), sql`supplier_account_entries.rowid DESC`);
    return rows.map(toSupplierEntry);
  };

  /** Raw append-only ledger insert. `insertSupplierEntry` and the #177 guarded
   * adjustment path share it. The caller owns the surrounding unit. */
  const insertEntryRow = async (entry: SupplierEntryInsert): Promise<SupplierAccountEntry> => {
    const row = firstRowOf(
      await db
        .insert(supplierAccountEntries)
        .values({
          id: id(),
          supplierId: entry.supplierId,
          kind: entry.kind,
          amount: entry.amount,
          direction: entry.direction ?? null,
          invoiceId: entry.invoiceId,
          method: entry.method ?? null,
          note: entry.note ?? null,
          ref: entry.ref ?? null,
          occurredAt: entry.occurredAt,
          createdAt: now(),
        })
        .returning(),
    );
    // returning() has no joined invoice number; the caller only needs the id
    return { ...toSupplierEntry({ ...row, invoiceNumber: null }) };
  };

  /** The one conditional-write guard for a purchase invoice's debt side: the
   * offset can never push the remaining below zero. Shared by the linked
   * adjustment and `applyDebtOffsetToInvoice` so the money clamp cannot drift. */
  const applyDebtOffset = (invoiceId: string, amount: number): boolean => {
    const result = conn.raw
      .query(`UPDATE invoices SET remaining_amount = remaining_amount - ?, updated_at = ? WHERE id = ? AND remaining_amount >= ?`)
      .run(amount, now(), invoiceId, amount);
    return Number(result.changes) > 0;
  };

  const store: StorePort = {
    setup,

    // --- categories ----------------------------------------------------------
    async listCategories() {
      return db.select(categoryCols).from(categories).orderBy(categories.name);
    },
    async createCategory(input) {
      const row = firstRowOf(await db.insert(categories).values({ id: id(), name: input.name, createdAt: now(), updatedAt: now() }).returning());
      return toCategory(row);
    },

    // --- items ---------------------------------------------------------------
    async listItems(pagination) {
      const query = db
        .select({ ...itemCols, categoryName: categories.name })
        .from(items)
        .leftJoin(categories, eq(items.categoryId, categories.id))
        .orderBy(items.name);
      if (pagination === undefined) {
        const rows = await query;
        return { items: rows, total: rows.length };
      }
      const { limit, offset } = resolvePagination(pagination);
      const [total, rows] = await Promise.all([
        db.$count(items),
        db
          .select({ ...itemCols, categoryName: categories.name })
          .from(items)
          .leftJoin(categories, eq(items.categoryId, categories.id))
          .orderBy(items.name)
          .limit(limit)
          .offset(offset),
      ]);
      return { items: rows, total };
    },
    async listLowStockItems() {
      return db.select(itemCols).from(items).where(sql`${items.stockOnHand} <= ${items.lowStockThreshold}`).orderBy(items.stockOnHand, items.name);
    },
    async getItemsByIds(ids: string[]) {
      if (ids.length === 0) return new Map<string, Item>();
      const found = await db.select(itemCols).from(items).where(inArray(items.id, ids));
      return new Map(found.map((item) => [item.id, item]));
    },
    async getItemByBarcode(barcode) {
      const found = await db.select(itemCols).from(items).where(eq(items.barcode, barcode)).limit(1);
      return found[0];
    },
    async createItem(input: ItemCreate) {
      const row = firstRowOf(
        await db
          .insert(items)
          .values({
            id: id(),
            name: input.name,
            barcode: input.barcode ?? null,
            categoryId: input.categoryId,
            costPrice: input.costPrice,
            sellingPrice: input.sellingPrice,
            lowStockThreshold: input.lowStockThreshold ?? 5,
            stockOnHand: 0,
            createdAt: now(),
            updatedAt: now(),
          })
          .returning(),
      );
      return toItem(row);
    },
    async updateItem(idToUpdate: string, patch: ItemUpdate) {
      const set: Partial<typeof items.$inferInsert> = { updatedAt: now() };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.categoryId !== undefined) set.categoryId = patch.categoryId;
      if (patch.costPrice !== undefined) set.costPrice = patch.costPrice;
      if (patch.sellingPrice !== undefined) set.sellingPrice = patch.sellingPrice;
      if (patch.lowStockThreshold !== undefined) set.lowStockThreshold = patch.lowStockThreshold;
      if (patch.barcode !== undefined) set.barcode = patch.barcode;
      const rows = await db.update(items).set(set).where(eq(items.id, idToUpdate)).returning();
      return rows.length === 0 ? undefined : toItem(firstRowOf(rows));
    },
    async setItemStockAndCost(itemId: string, stockOnHand: number, costPrice: number) {
      await db.update(items).set({ stockOnHand, costPrice, updatedAt: now() }).where(eq(items.id, itemId)).run();
    },

    // --- stock ledger (ticket 27) --------------------------------------------
    async insertStockMovement(movement) {
      const row = firstRowOf(
        await db
          .insert(stockMovements)
          .values({
            id: id(),
            itemId: movement.itemId,
            kind: movement.kind,
            delta: movement.delta,
            unitCost: movement.unitCost ?? null,
            reason: movement.reason ?? null,
            ref: movement.ref ?? null,
            returnMark: movement.returnMark ?? null,
            occurredAt: movement.occurredAt,
            createdAt: now(),
          })
          .returning(),
      );
      return toMovement(row);
    },
    async listStockMovements(itemId) {
      // rowid breaks same-timestamp ties deterministically (insertion order)
      const rows = await db
        .select({ ...movementCols, seq: sql<number>`rowid` })
        .from(stockMovements)
        .where(eq(stockMovements.itemId, itemId))
        .orderBy(stockMovements.occurredAt, sql`rowid`);
      return rows.map((row) => ({ ...toMovement(row), seq: Number(row.seq) }));
    },
    async countStockMovements(itemId) {
      return db.$count(stockMovements, eq(stockMovements.itemId, itemId));
    },

    // --- purchase linkage (ticket 29) ----------------------------------------
    async insertStockLink(link) {
      const row = firstRowOf(
        await db
          .insert(stockLinks)
          .values({ id: id(), invoiceId: link.invoiceId, movementId: link.movementId, quantity: link.quantity, createdAt: now() })
          .returning(),
      );
      return toStockLink(row);
    },
    async listStockLinksByItem(itemId: string) {
      // join through the movement to scope links to one item's ledger
      const rows = await db
        .select({
          id: stockLinks.id,
          invoiceId: stockLinks.invoiceId,
          movementId: stockLinks.movementId,
          quantity: stockLinks.quantity,
          createdAt: stockLinks.createdAt,
        })
        .from(stockLinks)
        .innerJoin(stockMovements, eq(stockMovements.id, stockLinks.movementId))
        .where(eq(stockMovements.itemId, itemId))
        // SAFETY: the join makes a bare `rowid` ambiguous — qualify it with the
        // links table so insertion-order tiebreaks still apply
        .orderBy(stockLinks.createdAt, sql`stock_links.rowid`);
      return rows.map((row) => ({ ...row }) satisfies StockLink);
    },

    // --- expenses + profit report (ticket 31) --------------------------------
    async listExpenseCategories() {
      const rows = await db.select(expenseCategoryCols).from(expenseCategories).orderBy(expenseCategories.name);
      return rows.map((row) => toExpenseCategory(row));
    },
    async createExpenseCategory(input) {
      const row = firstRowOf(
        await db
          .insert(expenseCategories)
          .values({ id: id(), name: input.name, isOwnerWithdrawal: input.isOwnerWithdrawal === true ? 1 : 0, createdAt: now(), updatedAt: now() })
          .returning(),
      );
      return toExpenseCategory(row);
    },
    async insertExpense(input) {
      const row = firstRowOf(
        await db
          .insert(expenses)
          .values({ id: id(), categoryId: input.categoryId, amount: input.amount, note: input.note ?? null, occurredAt: input.occurredAt, createdAt: now() })
          .returning(),
      );
      return toExpense(row);
    },
    async listExpenseRecords(filters) {
      const conds: SQL[] = [];
      if (filters.categoryIds !== undefined && filters.categoryIds.length > 0) {
        conds.push(inArray(expenses.categoryId, filters.categoryIds));
      }
      if (filters.from !== undefined) conds.push(sql`${expenses.occurredAt} >= ${filters.from}`);
      if (filters.to !== undefined) conds.push(sql`${expenses.occurredAt} <= ${filters.to}`);
      const where = conds.length ? and(...conds) : undefined;
      const rows = await db.select(expenseCols).from(expenses).where(where);
      return rows.map((row) => toExpense(row));
    },
    async listSaleLinesForProfit(from, to) {
      // raw line facts only: netTotal (revenue basis), cogsExact (exact COGS
      // basis) and costAtSale (rounded snapshot, kept for the DTO); the pure
      // report module owns the formulas. setup() guarantees the column;
      // the self-healing repair keeps every row honest on every boot.
      // SAFETY: the SELECT aliases exactly produce these camelCase keys from
      // the fixed column list; the raw result's shape is pinned by the literal
      // query, not by any user input.
      const lines = (await db.all(sql`
        SELECT l.invoice_id AS invoiceId, i.invoice_date AS invoiceDate,
               l.id AS lineId, l.quantity AS quantity,
               l.cost_at_sale AS costAtSale, l.cogs_exact AS cogsExact,
               l.net_total AS netTotal
        FROM invoice_lines l
        JOIN invoices i ON i.id = l.invoice_id
        WHERE i.kind = 'SALE'
          AND i.invoice_date >= substr(${from}, 1, 10)
          AND i.invoice_date <= substr(${to}, 1, 10)
      `)) as Array<ProfitSaleLine & { lineId: string }>;
      if (lines.length === 0) return [];
      // per-original-line return aggregates: held (pending/accepted) returns,
      // rejected returns, and — for the rejected ones — the quantity the reject
      // actually SCRAPPED (the MANUAL_ADJUSTMENT outflow amount, i.e. the
      // still-on-hand portion at review time; resold units are never scrapped
      // by the clamp). Each reject movement carries its return line's id as a
      // reason suffix (`#<lineId>`), so a multi-line return of one item
      // attributes the scrap to the exact owning line.
      // SAFETY: the JOIN keys are fixed columns; the aggregation yields one
      // row per invoice line with its three whole-number sums.
      const stats = (await db.all(sql`
        SELECT rl.invoice_line_id AS invoiceLineId,
               COALESCE(SUM(CASE WHEN r.status != 'REJECTED_DAMAGED' THEN rl.quantity ELSE 0 END), 0) AS heldQty,
               COALESCE(SUM(CASE WHEN r.status = 'REJECTED_DAMAGED' THEN rl.quantity ELSE 0 END), 0) AS rejectedQty,
               COALESCE(SUM(CASE WHEN r.status = 'REJECTED_DAMAGED' AND sm.id IS NOT NULL THEN -sm.delta ELSE 0 END), 0) AS rejectedScrapQty
        FROM return_lines rl
        JOIN returns r ON r.id = rl.return_id
        LEFT JOIN stock_movements sm
          ON sm.ref = r.id AND sm.kind = 'MANUAL_ADJUSTMENT' AND sm.delta < 0
         AND substr(sm.reason, -(length(rl.id) + 1)) = '#' || rl.id
        GROUP BY rl.invoice_line_id
      `)) as Array<{ invoiceLineId: string; heldQty: number; rejectedQty: number; rejectedScrapQty: number }>;
      const statsByLine = new Map(stats.map((row) => [row.invoiceLineId, row]));
      const rows: ProfitSaleLine[] = [];
      for (const line of lines) {
        const perLineStats = statsByLine.get(line.lineId);
        if (perLineStats === undefined) {
          rows.push({ invoiceId: line.invoiceId, invoiceDate: line.invoiceDate, quantity: line.quantity, costAtSale: line.costAtSale, cogsExact: line.cogsExact, netTotal: line.netTotal });
          continue;
        }
        const booked = bookSaleLineForReturns(line, perLineStats);
        if (booked.bookedQty <= 0) continue; // fully returned, nothing booked
        rows.push({ invoiceId: line.invoiceId, invoiceDate: line.invoiceDate, quantity: booked.bookedQty, costAtSale: line.costAtSale, cogsExact: booked.cogsExact, netTotal: booked.netTotal });
      }
      return rows;
    },

    // --- parties (issue 120): customers & suppliers share one code path -------
    async listParties(role: PartyRole) {
      const kind = partyInvoiceKind[role];
      // One LEFT JOIN keeps a zero-invoice party on the list with zero stats.
      // Suppliers also carry their signed account balance and entry count
      // (issue 176) so the bulk رصيد افتتاحي screen can show the current
      // balance and ask for confirmation before adding a second entry. The
      // balance uses the shared signed-amount expression, so it can never
      // disagree with the supplier detail or /debts. Customers stay null.
      const accountSelect =
        role === "supplier"
          ? sql`, COALESCE((SELECT SUM(${sql.raw(supplierSignedAmountSql("e"))}) FROM supplier_account_entries e WHERE e.supplier_id = p.id), 0) AS accountBalance,
                  (SELECT COUNT(*) FROM supplier_account_entries e WHERE e.supplier_id = p.id) AS accountEntryCount`
          : sql`, NULL AS accountBalance, NULL AS accountEntryCount`;
      // SAFETY: the table name comes from a closed literal map (never input);
      // each alias lands in PartyAggregateRow before typing.
      const rows = (await db.all(sql`
        SELECT p.id, p.name, p.phone, p.created_at AS createdAt,
               COUNT(i.id) AS invoiceCount,
               COALESCE(SUM(i.total_amount), 0) AS totalAmount,
               COALESCE(SUM(i.paid_amount), 0) AS paidAmount,
               COALESCE(SUM(i.remaining_amount), 0) AS remainingAmount${accountSelect}
        FROM ${sql.raw(PARTY_TABLES[role])} p
        LEFT JOIN invoices i ON i.counterparty_id = p.id AND i.kind = ${kind}
        GROUP BY p.id
        ORDER BY p.name`)) as PartyAggregateRow[];
      return rows.map(toPartyListItem);
    },
    async getParty(role: PartyRole, partyId: string) {
      return fetchParty(role, partyId);
    },
    async createParty(role: PartyRole, input: PartyCreate) {
      const phone = normalizePartyPhone(input.phone);
      assertPhoneFree(role, phone, null);
      if (role === "customer") {
        const row = firstRowOf(await db.insert(customers).values({ id: id(), name: input.name, phone, createdAt: now() }).returning());
        return toCustomer(row);
      }
      const row = firstRowOf(await db.insert(suppliers).values({ id: id(), name: input.name, phone, createdAt: now() }).returning());
      return toSupplier(row);
    },
    async updateParty(role: PartyRole, partyId: string, patch: PartyUpdate) {
      // an empty patch is a no-op, not a raw drizzle UPDATE ... SET {} error
      if (patch.name === undefined && patch.phone === undefined) return fetchParty(role, partyId);
      const phone = patch.phone === undefined ? undefined : normalizePartyPhone(patch.phone);
      if (phone !== undefined) assertPhoneFree(role, phone, partyId);
      const set: PartyUpdate = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (phone !== undefined) set.phone = phone;
      if (role === "customer") {
        const rows = await db.update(customers).set(set).where(eq(customers.id, partyId)).returning();
        return rows.length === 0 ? undefined : toCustomer(firstRowOf(rows));
      }
      const rows = await db.update(suppliers).set(set).where(eq(suppliers.id, partyId)).returning();
      return rows.length === 0 ? undefined : toSupplier(firstRowOf(rows));
    },
    async deleteParty(role: PartyRole, partyId: string): Promise<PartyDeleteResult> {
      const exists = role === "customer"
        ? await db.select({ id: customers.id }).from(customers).where(eq(customers.id, partyId)).limit(1)
        : await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, partyId)).limit(1);
      if (exists.length === 0) return "NOT_FOUND";
      // The rule is enforced by ONE conditional DELETE, so it holds at the
      // statement level even if a future caller forgets the transaction
      // wrapper; the existence read above only classifies NOT_FOUND. A supplier
      // with account entries or purchase returns is also refused: the ledger
      // FKs would otherwise surface a raw constraint error (issue 161).
      // SAFETY: the table name comes from a closed literal map (never input).
      const supplierGuard =
        role === "supplier"
          ? " AND NOT EXISTS (SELECT 1 FROM supplier_account_entries WHERE supplier_id = ?) AND NOT EXISTS (SELECT 1 FROM supplier_returns WHERE supplier_id = ?)"
          : "";
      const deleted = conn.raw
        .query(`DELETE FROM ${PARTY_TABLES[role]} WHERE id = ? AND NOT EXISTS (SELECT 1 FROM invoices WHERE counterparty_id = ?)${supplierGuard}`)
        .run(...(role === "supplier" ? [partyId, partyId, partyId, partyId] : [partyId, partyId]));
      return Number(deleted.changes) > 0 ? "DELETED" : "HAS_INVOICES";
    },
    async partyDetail(role: PartyRole, partyId: string): Promise<PartyDetail | undefined> {
      const party = await fetchParty(role, partyId);
      if (party === undefined) return undefined;
      const kind = partyInvoiceKind[role];
      const [invoiceRows, paymentRows] = await Promise.all([
        db
          .select(invoiceCols)
          .from(invoices)
          .where(and(eq(invoices.counterpartyId, partyId), eq(invoices.kind, kind)))
          .orderBy(desc(invoices.invoiceDate), desc(invoices.createdAt)),
        db
          .select({ ...paymentCols, invoiceNumber: invoices.invoiceNumber })
          .from(payments)
          .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
          .where(and(eq(invoices.counterpartyId, partyId), eq(invoices.kind, kind)))
          .orderBy(desc(payments.paidAt), desc(payments.createdAt)),
      ]);
      // the strip derives from the SAME mapped rows the invoices tab renders:
      // one malformed legacy row cannot make the numbers and the table disagree
      const detailInvoices = mapRecentInvoices(invoiceRows) ?? [];
      const stats = detailInvoices.reduce(
        (acc, invoice) => ({
          invoiceCount: acc.invoiceCount + 1,
          totalAmount: acc.totalAmount + invoice.totalAmount,
          paidAmount: acc.paidAmount + invoice.paidAmount,
          remainingAmount: acc.remainingAmount + invoice.remainingAmount,
        }),
        { invoiceCount: 0, totalAmount: 0, paidAmount: 0, remainingAmount: 0 },
      );
      // Suppliers also carry their signed account (issue 161); customers keep
      // invoice-based debt so their account stays null.
      const entries = role === "supplier" ? await listEntries(partyId) : [];
      return {
        party,
        stats: safePartyStats(stats),
        invoices: detailInvoices,
        payments: paymentRows.map((row) => ({ ...row, invoiceNumber: String(row.invoiceNumber) })),
        account: role === "supplier" ? { balance: supplierBalance(entries), entries } : null,
      } satisfies PartyDetail;
    },

    // --- invoices / payments -------------------------------------------------
    // Explicit BEGIN/COMMIT/ROLLBACK on the single raw connection: drizzle's
    // bun-sqlite transaction committed before awaited callbacks finished
    // (proven by the store transactions test), so units would lose atomicity.
    withTransaction: <T>(fn: (tx: StorePort) => Promise<T>): Promise<T> => runTransaction(false, fn),
    // Money paths (payments) acquire the WRITE lock BEFORE any read: a deferred
    // BEGIN can take a WAL read snapshot that a second process committed over,
    // and the later read-to-write upgrade then fails with SQLITE_BUSY_SNAPSHOT
    // (busy_timeout does not apply) — surfacing as a raw 500 instead of the
    // PAYMENT_EXCEEDS_REMAINING refusal. BEGIN IMMEDIATE waits (busy_timeout)
    // for the concurrent writer, then reads the post-commit state, so the
    // conditional UPDATE simply refuses. This pre-empts the BEGIN IMMEDIATE
    // hardening deferred in issue #43 for the payments path.
    withTransactionImmediate: <T>(fn: (tx: StorePort) => Promise<T>): Promise<T> => runTransaction(true, fn),
    async allocateInvoiceNumber() {
      // SAFETY: this statement has fixed SQL identifiers and no user input;
      // SQLite serializes the UPDATE across database connections. Reading the
      // existing maximum in the same statement also keeps manually inserted
      // INV-* rows from moving the sequence backwards.
      const rows = conn.raw
        .query(`
          UPDATE invoice_number_sequence
          SET next_number = MAX(
            next_number,
            COALESCE((SELECT MAX(CASE
              WHEN invoice_number GLOB 'INV-[0-9]*' THEN CAST(substr(invoice_number, 5) AS INTEGER)
              ELSE 0
            END) FROM invoices), 0) + 1
          ) + 1
          WHERE id = 1
          RETURNING printf('INV-%04d', next_number - 1) AS invoice_number
        `)
        .all() as Array<{ invoice_number: string }>;
      // SAFETY: setup seeds exactly one singleton row before store use; the
      // UPDATE ... RETURNING therefore yields exactly one formatted number.
      return firstRowOf(rows).invoice_number;
    },
    async lastInvoiceNumber() {
      // SAFETY: created_at has second granularity and id is a random UUID, so
      // "latest by row" can return a stale number when several invoices land
      // in the same second — the UNIQUE invoice_number would then 500. Take
      // the numeric maximum of INV-%04d instead.
      const rows = await db.select({ invoiceNumber: invoices.invoiceNumber }).from(invoices);
      let best: string | undefined;
      let bestNum = -1;
      for (const row of rows) {
        const parsed = Number.parseInt(row.invoiceNumber.replace(/^INV-/u, ""), 10);
        if (Number.isSafeInteger(parsed) && parsed > bestNum) {
          bestNum = parsed;
          best = row.invoiceNumber;
        }
      }
      return best;
    },
    async allocateReturnNumber() {
      // SAFETY: this statement has fixed SQL identifiers and no user input;
      // SQLite serializes the UPDATE across database connections. Reading the
      // existing maximum in the same statement also keeps manually inserted
      // RTN-* rows from moving the sequence backwards.
      const rows = conn.raw
        .query(`
          UPDATE return_number_sequence
          SET next_number = MAX(
            next_number,
            COALESCE((SELECT MAX(CASE
              WHEN return_number GLOB 'RTN-[0-9]*' THEN CAST(substr(return_number, 5) AS INTEGER)
              ELSE 0
            END) FROM returns), 0) + 1
          ) + 1
          WHERE id = 1
          RETURNING printf('RTN-%04d', next_number - 1) AS return_number
        `)
        .all() as Array<{ return_number: string }>;
      // SAFETY: setup seeds exactly one singleton row before store use; the
      // UPDATE ... RETURNING therefore yields exactly one formatted number.
      return firstRowOf(rows).return_number;
    },
    async insertReturn(input: ReturnInsert) {
      const row = firstRowOf(
        await db
          .insert(returns)
          .values({
            id: id(),
            returnNumber: input.returnNumber,
            invoiceId: input.invoiceId,
            refundAmount: input.refundAmount,
            cashPaidOut: input.cashPaidOut,
            debtOffset: input.debtOffset,
            debtApplied: 0,
            payoutMethod: input.payoutMethod,
            reason: input.reason ?? null,
            status: input.status,
            occurredAt: input.occurredAt,
            createdAt: now(),
            updatedAt: now(),
          })
          .returning({ id: returns.id }),
      );
      return { id: row.id };
    },
    async insertReturnLine(line: ReturnLineInsert) {
      await db
        .insert(returnLines)
        .values({
          id: id(),
          returnId: line.returnId,
          invoiceLineId: line.invoiceLineId,
          itemId: line.itemId ?? null,
          description: line.description,
          quantity: line.quantity,
          refundUnitPrice: line.refundUnitPrice,
          refundAmount: line.refundAmount,
        })
        .run();
    },
    /** One return header joined to its invoice identity (for the voucher/list).
     * Returns the contract shape with an empty line list — the caller resolves
     * lines when it needs them. */
    async getReturnHeader(returnId: string) {
      const rows = await db
        .select({
          id: returns.id,
          returnNumber: returns.returnNumber,
          invoiceId: returns.invoiceId,
          invoice_number: invoices.invoiceNumber,
          invoice_date: invoices.invoiceDate,
          counterparty_name: invoices.counterpartyName,
          refundAmount: returns.refundAmount,
          cashPaidOut: returns.cashPaidOut,
          debtOffset: returns.debtOffset,
          debtApplied: returns.debtApplied,
          payoutMethod: returns.payoutMethod,
          reason: returns.reason,
          status: returns.status,
          occurredAt: returns.occurredAt,
          createdAt: returns.createdAt,
          updatedAt: returns.updatedAt,
        })
        .from(returns)
        .innerJoin(invoices, eq(invoices.id, returns.invoiceId))
        .where(eq(returns.id, returnId))
        .limit(1);
      const header = rows[0];
      return header === undefined ? undefined : toReturn(header);
    },
    async getReturnDetail(returnId: string) {
      const header = await this.getReturnHeader(returnId);
      if (header === undefined) return undefined;
      const lineRows = await db
        .select(returnLineCols)
        .from(returnLines)
        .where(eq(returnLines.returnId, returnId))
        .orderBy(returnLines.id);
      return { ...header, lines: lineRows.map((row) => toReturnLine(row)) } satisfies ReturnDetail;
    },
    async listReturns(filters: { invoiceId?: string }, pagination?: PaginationInput) {
      const conds: SQL[] = [];
      if (filters.invoiceId !== undefined) conds.push(eq(returns.invoiceId, filters.invoiceId));
      const where = conds.length ? and(...conds) : undefined;
      const rowsQuery = db
        .select({
          id: returns.id,
          returnNumber: returns.returnNumber,
          invoiceId: returns.invoiceId,
          invoice_number: invoices.invoiceNumber,
          invoice_date: invoices.invoiceDate,
          counterparty_name: invoices.counterpartyName,
          refundAmount: returns.refundAmount,
          cashPaidOut: returns.cashPaidOut,
          debtOffset: returns.debtOffset,
          debtApplied: returns.debtApplied,
          payoutMethod: returns.payoutMethod,
          reason: returns.reason,
          status: returns.status,
          occurredAt: returns.occurredAt,
          createdAt: returns.createdAt,
          updatedAt: returns.updatedAt,
        })
        .from(returns)
        .innerJoin(invoices, eq(invoices.id, returns.invoiceId))
        .where(where)
        // pending review first, then newest. The review screen shows pending
        // rows ahead of reviewed ones; with server paging that order must be
        // part of the query, or a pending return could hide on a later page.
        // A paginated read slices in SQL, and `total` keeps the whole filtered
        // count so every return stays reachable.
        .orderBy(sql`CASE WHEN ${returns.status} = 'PENDING_REVIEW' THEN 0 ELSE 1 END`, desc(returns.createdAt), sql`returns.rowid DESC`);
      const headers =
        pagination === undefined
          ? await rowsQuery
          : await rowsQuery.limit(resolvePagination(pagination).limit).offset(resolvePagination(pagination).offset);
      const total = pagination === undefined ? headers.length : await db.$count(returns, where);
      const lineRows =
        headers.length === 0
          ? []
          : await db.select(returnLineCols).from(returnLines).where(inArray(returnLines.returnId, headers.map((header) => header.id))).orderBy(returnLines.id);
      const linesByReturn = new Map<string, ReturnDetail["lines"]>();
      for (const row of lineRows) {
        const list = linesByReturn.get(row.returnId) ?? [];
        list.push(toReturnLine(row));
        linesByReturn.set(row.returnId, list);
      }
      return { items: headers.map((header) => ({ ...toReturn(header), lines: linesByReturn.get(header.id) ?? [] })) satisfies ReturnDetail[], total };
    },
    // --- supplier account (issue 161) ----------------------------------------
    async insertSupplierEntry(entry: SupplierEntryInsert) {
      assertAdjustmentDirection(entry.kind, entry.direction);
      // #177 — a linked ADJUSTMENT must go through insertSupplierAdjustment,
      // which applies the invoice reduction in the same unit. Allowing it here
      // would let a direct seam caller write the entry without the reduction and
      // diverge the account from the invoice.
      if (entry.kind === "ADJUSTMENT" && entry.invoiceId !== null) {
        throw new SupplierAdjustmentError("LINKED_NEEDS_ATOMIC_PATH");
      }
      return insertEntryRow(entry);
    },
    /**
     * #177 — the one guarded write path for a manual adjustment. In order:
     *   1. it must run inside the caller's write unit (BEGIN IMMEDIATE);
     *   2. the amount is re-validated (a non-contract caller must not invert the
     *      reduction with a negative or fractional amount);
     *   3. the duplicate signature (supplier, direction, amount, reason,
     *      invoiceId, occurredAt) is refused before any write — a retry cannot
     *      double-post; a server-stamped timestamp is matched at any time;
     *   4. a linked entry must be THEY_OWE;
     *   5. the linked invoice's conditional reduction runs before the entry is
     *      inserted, so the two can only commit together (the caller's unit rolls
     *      both back when either fails).
     * Account-only (null invoiceId) writes the entry with a null invoice and
     * touches no invoice.
     */
    async insertSupplierAdjustment(input: SupplierAdjustmentInsert) {
      // the invariant only holds inside the caller's unit: outside it the
      // duplicate check races and the entry could commit without its reduction
      if (!conn.inTransaction) throw new SupplierAdjustmentError("OUTSIDE_TRANSACTION");
      assertAdjustmentDirection("ADJUSTMENT", input.direction);
      // never trust the transport contract here: a negative amount would make the
      // conditional UPDATE increase the invoice's remaining, a fractional one
      // would write non-whole DZD
      if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
        throw new SupplierAdjustmentError("INVALID_AMOUNT");
      }
      if (input.invoiceId !== null && input.direction !== "THEY_OWE") {
        throw new SupplierAdjustmentError("LINKED_DIRECTION");
      }
      const signature = [
        eq(supplierAccountEntries.supplierId, input.supplierId),
        eq(supplierAccountEntries.kind, "ADJUSTMENT"),
        eq(supplierAccountEntries.direction, input.direction),
        eq(supplierAccountEntries.amount, input.amount),
        input.reason === null ? isNull(supplierAccountEntries.note) : eq(supplierAccountEntries.note, input.reason),
        input.invoiceId === null ? isNull(supplierAccountEntries.invoiceId) : eq(supplierAccountEntries.invoiceId, input.invoiceId),
      ];
      // a server-stamped timestamp cannot tell a retry apart, so match any time;
      // a caller-supplied one is part of the idempotency signature
      if (input.serverStamped !== true) signature.push(eq(supplierAccountEntries.occurredAt, input.occurredAt));
      const duplicates = await db
        .select({ id: supplierAccountEntries.id })
        .from(supplierAccountEntries)
        .where(and(...signature))
        .limit(1);
      if (duplicates[0] !== undefined) throw new SupplierAdjustmentError("DUPLICATE");
      if (input.invoiceId !== null) {
        // same conditional write returns use: never push an invoice's remaining
        // below zero; the excess is refused, never silently moved to credit
        if (!applyDebtOffset(input.invoiceId, input.amount)) throw new SupplierAdjustmentError("EXCEEDS_REMAINING");
      }
      return insertEntryRow({
        supplierId: input.supplierId,
        kind: "ADJUSTMENT",
        direction: input.direction,
        amount: input.amount,
        invoiceId: input.invoiceId,
        note: input.reason,
        ref: input.ref ?? null,
        occurredAt: input.occurredAt,
      });
    },
    listSupplierEntries(supplierId: string) {
      return listEntries(supplierId);
    },
    async listOutstandingPurchaseInvoices(supplierId: string) {
      const rows = await db
        .select(invoiceCols)
        .from(invoices)
        .where(and(eq(invoices.counterpartyId, supplierId), eq(invoices.kind, "PURCHASE"), sql`${invoices.remainingAmount} > 0`))
        .orderBy(invoices.invoiceDate, invoices.createdAt, sql`invoices.rowid`);
      return rows.map((row) => ({ ...row, ...normalizeInvoiceLegacy(row) }) satisfies Invoice);
    },
    async allocateSupplierReturnNumber() {
      // SAFETY: fixed SQL identifiers and no user input; SQLite serializes the
      // UPDATE across connections, and the MAX() keeps manually inserted PRT-*
      // rows from moving the sequence backwards.
      const rows = conn.raw
        .query(`
          UPDATE supplier_return_number_sequence
          SET next_number = MAX(
            next_number,
            COALESCE((SELECT MAX(CASE
              WHEN return_number GLOB 'PRT-[0-9]*' THEN CAST(substr(return_number, 5) AS INTEGER)
              ELSE 0
            END) FROM supplier_returns), 0) + 1
          ) + 1
          WHERE id = 1
          RETURNING printf('PRT-%04d', next_number - 1) AS return_number
        `)
        .all() as Array<{ return_number: string }>;
      return firstRowOf(rows).return_number;
    },
    async insertSupplierReturn(input: SupplierReturnInsert) {
      const row = firstRowOf(
        await db
          .insert(supplierReturns)
          .values({
            id: id(),
            returnNumber: input.returnNumber,
            supplierId: input.supplierId,
            invoiceId: input.invoiceId,
            kind: input.kind,
            amount: input.amount,
            debtReduction: input.debtReduction,
            credit: input.credit,
            cashBack: input.cashBack,
            reason: input.reason,
            occurredAt: input.occurredAt,
            createdAt: now(),
          })
          .returning({ id: supplierReturns.id }),
      );
      return { id: row.id };
    },
    async insertSupplierReturnLine(line: SupplierReturnLineInsert) {
      await db
        .insert(supplierReturnLines)
        .values({
          id: id(),
          returnId: line.returnId,
          invoiceLineId: line.invoiceLineId,
          itemId: line.itemId,
          description: line.description,
          quantity: line.quantity,
          unitCost: line.unitCost,
          amount: line.amount,
        })
        .run();
    },
    async listSupplierReturns(filters: { supplierId?: string }, pagination?: PaginationInput) {
      const where = filters.supplierId === undefined ? undefined : eq(supplierReturns.supplierId, filters.supplierId);
      const rowsQuery = db
        .select({
          id: supplierReturns.id,
          returnNumber: supplierReturns.returnNumber,
          supplierId: supplierReturns.supplierId,
          supplier_name: suppliers.name,
          invoiceId: supplierReturns.invoiceId,
          invoice_number: invoices.invoiceNumber,
          kind: supplierReturns.kind,
          amount: supplierReturns.amount,
          debtReduction: supplierReturns.debtReduction,
          credit: supplierReturns.credit,
          cashBack: supplierReturns.cashBack,
          reason: supplierReturns.reason,
          occurredAt: supplierReturns.occurredAt,
          createdAt: supplierReturns.createdAt,
        })
        .from(supplierReturns)
        .leftJoin(invoices, eq(invoices.id, supplierReturns.invoiceId))
        .leftJoin(suppliers, eq(suppliers.id, supplierReturns.supplierId))
        .where(where)
        .orderBy(desc(supplierReturns.createdAt), sql`supplier_returns.rowid DESC`);
      const headers =
        pagination === undefined
          ? await rowsQuery
          : await rowsQuery.limit(resolvePagination(pagination).limit).offset(resolvePagination(pagination).offset);
      const total = pagination === undefined ? headers.length : await db.$count(supplierReturns, where);
      const lineRows =
        headers.length === 0
          ? []
          : await db
              .select()
              .from(supplierReturnLines)
              .where(inArray(supplierReturnLines.returnId, headers.map((header) => header.id)))
              .orderBy(supplierReturnLines.id);
      const linesByReturn = new Map<string, SupplierReturnRecord["lines"]>();
      for (const row of lineRows) {
        const list = linesByReturn.get(row.returnId) ?? [];
        list.push(toSupplierReturnLine(row));
        linesByReturn.set(row.returnId, list);
      }
      return { items: headers.map((header) => ({ ...toSupplierReturn(header), lines: linesByReturn.get(header.id) ?? [] })) satisfies SupplierReturnRecord[], total };
    },
    async getSupplierReturn(returnId: string) {
      const rows = await db
        .select({
          id: supplierReturns.id,
          returnNumber: supplierReturns.returnNumber,
          supplierId: supplierReturns.supplierId,
          supplier_name: suppliers.name,
          invoiceId: supplierReturns.invoiceId,
          invoice_number: invoices.invoiceNumber,
          kind: supplierReturns.kind,
          amount: supplierReturns.amount,
          debtReduction: supplierReturns.debtReduction,
          credit: supplierReturns.credit,
          cashBack: supplierReturns.cashBack,
          reason: supplierReturns.reason,
          occurredAt: supplierReturns.occurredAt,
          createdAt: supplierReturns.createdAt,
        })
        .from(supplierReturns)
        .leftJoin(invoices, eq(invoices.id, supplierReturns.invoiceId))
        .leftJoin(suppliers, eq(suppliers.id, supplierReturns.supplierId))
        .where(eq(supplierReturns.id, returnId))
        .limit(1);
      const header = rows[0];
      if (header === undefined) return undefined;
      const lineRows = await db.select().from(supplierReturnLines).where(eq(supplierReturnLines.returnId, returnId)).orderBy(supplierReturnLines.id);
      return { ...toSupplierReturn(header), lines: lineRows.map((row) => toSupplierReturnLine(row)) } satisfies SupplierReturnRecord;
    },
    /** One COUNT for the shell badge and dashboard notice (issue 118): the
     * pending mark lives only in `returns.status`, so a SQL aggregate is the
     * authoritative source and never a filtered client list. */
    async pendingReturnsCount() {
      const rows = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(returns)
        .where(eq(returns.status, "PENDING_REVIEW"));
      return Number(rows[0]?.count ?? 0);
    },
    /** Authoritative review guard: the conditional UPDATE refuses a return that
     * is no longer pending, so two processes can never both consume the mark.
     * Raw SQL is fine here: this file is the driver adapter (ADR-0003), and
     * applyPaymentToInvoice already uses the same raw connection in-tx. */
    async transitionReturnStatus(returnId: string, to: "ACCEPTED" | "REJECTED_DAMAGED") {
      const result = conn.raw
        .query(`UPDATE returns SET status = ?, updated_at = ? WHERE id = ? AND status = 'PENDING_REVIEW'`)
        .run(to, now(), returnId);
      return Number(result.changes) > 0;
    },
    async returnedByLine(invoiceId: string) {
      // SAFETY: the JOIN keys are fixed columns; the aggregation yields one
      // row per invoice line with its summed returned quantity and refund.
      const rows = (await db.all(sql`
        SELECT rl.invoice_line_id AS invoiceLineId, SUM(rl.quantity) AS quantity, SUM(rl.refund_amount) AS refundAmount
        FROM return_lines rl
        JOIN returns r ON r.id = rl.return_id
        WHERE r.invoice_id = ${invoiceId}
        GROUP BY rl.invoice_line_id
      `)) as Array<{ invoiceLineId: string; quantity: number | null; refundAmount: number | null }>;
      const totals = new Map<string, { quantity: number; refundAmount: number }>();
      for (const row of rows) {
        totals.set(row.invoiceLineId, { quantity: Number(row.quantity ?? 0), refundAmount: Number(row.refundAmount ?? 0) });
      }
      return totals;
    },
    async returnedByPurchaseLine(invoiceId: string) {
      // SAFETY: fixed columns; one row per original purchase line with its
      // summed already-returned quantity (the supplier-return cap key).
      const rows = (await db.all(sql`
        SELECT srl.invoice_line_id AS invoiceLineId, SUM(srl.quantity) AS quantity
        FROM supplier_return_lines srl
        JOIN supplier_returns sr ON sr.id = srl.return_id
        WHERE sr.invoice_id = ${invoiceId}
        GROUP BY srl.invoice_line_id
      `)) as Array<{ invoiceLineId: string; quantity: number | null }>;
      const totals = new Map<string, number>();
      for (const row of rows) totals.set(row.invoiceLineId, Number(row.quantity ?? 0));
      return totals;
    },
    /** same conditional-write guard as applyPaymentToInvoice for the debt side:
     * the offset can never push an invoice's remaining debt below zero, even
     * across two processes on the same file. Raw SQL is the driver's job. */
    async applyDebtOffsetToInvoice(invoiceId: string, amount: number) {
      return applyDebtOffset(invoiceId, amount);
    },
    /** Record how much of a return's promised debtOffset was actually applied
     * (#68). Written in the same unit as the accept, so the review card and
     * voucher can show the real relieved amount, and a later re-review never
     * double-relieves (the refund math reads debtOffset − debtApplied). */
    async setDebtApplied(returnId: string, amount: number) {
      await db.update(returns).set({ debtApplied: amount, updatedAt: now() }).where(eq(returns.id, returnId)).run();
    },
    /** Consume the pending review tag on every movement a return created. The
     * flat ledger facts stay untouched; only the review tag transitions. */
    async setReturnMarks(returnId: string, mark: Exclude<ReturnMark, "PENDING">) {
      await db
        .update(stockMovements)
        .set({ returnMark: mark })
        .where(and(eq(stockMovements.ref, returnId), eq(stockMovements.returnMark, "PENDING")))
        .run();
    },
    /** Record the review annotation on the return (the rejection note). */
    async setReturnReason(returnId: string, reason: string) {
      await db.update(returns).set({ reason, updatedAt: now() }).where(eq(returns.id, returnId)).run();
    },
    async insertInvoice(inv: InvoiceInsert) {
      const row = firstRowOf(
        await db
          .insert(invoices)
          .values({
            id: id(),
            ...inv,
            subtotalAmount: inv.subtotalAmount ?? inv.totalAmount,
            discountType: inv.discountType ?? null,
            discountValue: inv.discountValue ?? null,
            discountAmount: inv.discountAmount ?? 0,
            createdAt: now(),
            updatedAt: now(),
          })
          .returning(),
      );
      return toInvoice(row);
    },
    async insertInvoiceLine(line: InvoiceLineInsert) {
      const row = firstRowOf(
        await db
          .insert(invoiceLines)
          .values({
            id: id(),
            ...line,
            defaultUnitPrice: line.defaultUnitPrice ?? line.unitPrice,
            discountAllocated: line.discountAllocated ?? 0,
            netTotal: line.netTotal ?? line.total,
            // Write-seam fallback for legacy callers: quantity × the rounded
            // cost snapshot is the documented approximation (exact on PURCHASE
            // rows where cost was the unit cost). The sale router always
            // passes the true layer-sum snapshot.
            cogsExact: line.cogsExact ?? line.quantity * line.costAtSale,
          })
          .returning(),
      );
      return toInvoiceLine(row);
    },
    async insertPayment(p: Omit<Payment, "id" | "createdAt">) {
      const row = firstRowOf(await db.insert(payments).values({ id: id(), ...p, createdAt: now() }).returning());
      return toPayment(row);
    },
    async applyPaymentToInvoice(invoiceId: string, amount: number) {
      // One conditional UPDATE is atomic at the SQLite statement level, so the
      // boundary "instalment may never exceed remaining" holds across separate
      // connections too (two processes cannot both pass a check-then-act read).
      // Raw SQL is fine here: this file is the driver adapter (ADR-0003), and
      // allocateInvoiceNumber already uses the same raw connection in-tx.
      const result = conn.raw
        .query(`UPDATE invoices SET paid_amount = paid_amount + ?, remaining_amount = remaining_amount - ?, updated_at = ? WHERE id = ? AND remaining_amount >= ?`)
        .run(amount, amount, now(), invoiceId, amount);
      return Number(result.changes) > 0;
    },
    async getInvoiceDetail(invoiceId: string) {
      const [invoice, lines, paymentsRows, creditRows, supplierCreditRows, adjustmentRows] = await Promise.all([
        db.select(invoiceCols).from(invoices).where(eq(invoices.id, invoiceId)).limit(1),
        db.select(lineCols).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.id),
        db.select(paymentCols).from(payments).where(eq(payments.invoiceId, invoiceId)).orderBy(payments.paidAt, sql`rowid`),
        // the return credit the header reconciles with: `debtApplied` is
        // already 0 for pending (#68 defers it) and rejected returns, so the
        // sum is the money the invoice genuinely stopped owing
        db
          .select({ credit: sql<SqlScalar>`coalesce(sum(${returns.debtApplied}), 0)` })
          .from(returns)
          .where(eq(returns.invoiceId, invoiceId)),
        // supplier purchase returns reduce a PURCHASE invoice's debt the same
        // way; without this the printed header would not add up after a
        // return (total − paid − remaining = returnCreditAmount)
        db
          .select({ credit: sql<SqlScalar>`coalesce(sum(${supplierReturns.debtReduction}), 0)` })
          .from(supplierReturns)
          .where(eq(supplierReturns.invoiceId, invoiceId)),
        // an invoice-linked adjustment (تسوية, issue 176) reduces a PURCHASE
        // invoice's remaining the same way a return does; without this the
        // header would not add up (total − paid − remaining = returnCreditAmount)
        db
          .select({ credit: sql<SqlScalar>`coalesce(sum(${supplierAccountEntries.amount}), 0)` })
          .from(supplierAccountEntries)
          .where(and(eq(supplierAccountEntries.invoiceId, invoiceId), eq(supplierAccountEntries.kind, "ADJUSTMENT"), eq(supplierAccountEntries.direction, "THEY_OWE"))),
      ]);
      const header = invoice[0];
      if (header === undefined) return undefined;
      const normalizedLines = lines.map((line) => ({
        ...line,
        defaultUnitPrice: line.defaultUnitPrice ?? line.unitPrice,
        discountAllocated: line.discountAllocated ?? 0,
        netTotal: line.netTotal ?? line.total,
      }));
      return {
        ...header,
        ...normalizeInvoiceLegacy(header),
        lines: normalizedLines,
        payments: paymentsRows,
        returnCreditAmount: safeWhole(creditRows[0]?.credit ?? 0) + safeWhole(supplierCreditRows[0]?.credit ?? 0) + safeWhole(adjustmentRows[0]?.credit ?? 0),
      } satisfies InvoiceDetail;
    },
    async getInvoiceLine(lineId: string) {
      const rows = await db.select(lineCols).from(invoiceLines).where(eq(invoiceLines.id, lineId)).limit(1);
      return rows.length === 0 ? undefined : toInvoiceLine(firstRowOf(rows));
    },
    async listInvoices(filters: InvoiceListFilters) {
      const conds: SQL[] = [];
      if (filters.kind) conds.push(sql`${invoices.kind} = ${filters.kind}`);
      if (filters.status === "PAID") conds.push(sql`${invoices.remainingAmount} = 0`);
      // remaining > 0 excludes fully-discounted/free invoices (total 0):
      // nothing is owed, so they are never "unpaid"
      else if (filters.status === "UNPAID") conds.push(sql`${invoices.remainingAmount} > 0 AND ${invoices.remainingAmount} = ${invoices.totalAmount}`);
      else if (filters.status === "PARTIAL") conds.push(sql`${invoices.remainingAmount} > 0 AND ${invoices.remainingAmount} < ${invoices.totalAmount}`);
      if (filters.fromDate) conds.push(sql`${invoices.invoiceDate} >= ${filters.fromDate}`);
      if (filters.toDate) conds.push(sql`${invoices.invoiceDate} <= ${filters.toDate}`);
      const where = conds.length ? and(...conds) : undefined;

      // no pagination keys = an internal full read (tests, aggregates); a
      // concrete limit/offset comes from resolvePagination at the router
      if (filters.limit === undefined && filters.offset === undefined) {
        const rows = await db.select(invoiceCols).from(invoices).where(where).orderBy(desc(invoices.invoiceDate), desc(invoices.createdAt), sql`invoices.rowid DESC`);
        return { items: rows.map((row) => ({ ...row, ...normalizeInvoiceLegacy(row) })), total: rows.length };
      }
      const { limit, offset } = resolvePagination(filters);
      const [total, itemsRows] = await Promise.all([
        db.$count(invoices, where),
        db.select(invoiceCols).from(invoices).where(where).orderBy(desc(invoices.invoiceDate), desc(invoices.createdAt), sql`invoices.rowid DESC`).limit(limit).offset(offset),
      ]);
      return {
        items: itemsRows.map((row) => ({ ...row, ...normalizeInvoiceLegacy(row) })),
        total,
      };
    },
    async setInvoicePaidAmounts(invoiceId: string, paidAmount: number, remainingAmount: number) {
      await db.update(invoices).set({ paidAmount, remainingAmount, updatedAt: now() }).where(eq(invoices.id, invoiceId)).run();
    },
    async listUnpaidInvoicesByParty(kind: Invoice["kind"], counterpartyId: string | null, counterpartyName: string | null): Promise<Invoice[]> {
      // SAFETY: the identity rule mirrors debtSummaries' GROUP BY key exactly:
      // a known party matches by id (never by a name that happens to equal a
      // typed name), and a typed-only query matches by trimmed name only when
      // the invoice carries no id — so the two identities never cross-pollinate,
      // and a padded stored name (store-seam inserts, seeds) is not orphaned
      // from its summary row.
      const conds: SQL[] = [
        sql`${invoices.kind} = ${kind}`,
        sql`${invoices.remainingAmount} > 0`,
        counterpartyId !== null
          ? sql`${invoices.counterpartyId} = ${counterpartyId}`
          : sql`${invoices.counterpartyId} IS NULL AND TRIM(${invoices.counterpartyName}) = TRIM(${counterpartyName})`,
      ];
      const rows = await db
        .select(invoiceCols)
        .from(invoices)
        .where(and(...conds))
        .orderBy(desc(invoices.invoiceDate), desc(invoices.createdAt));
      return rows.map((row) => ({ ...row, ...normalizeInvoiceLegacy(row) }));
    },
    async debtSummaries(): Promise<DebtSummary[]> {
      // The label for an id-backed group is the party's CURRENT name (joined
      // from the role's table), never the historical counterparty_name an
      // invoice snapshotted — a renamed party must not keep its old label on
      // the debts screen. Typed-only groups still use their invoice name.
      // SAFETY: GROUP BY yields one row per (kind, party); the keys below
      // match the alias names, columns are TEXT/INTEGER per db/schema.ts.
      const aggregated = (await db.all(sql`
        SELECT invoices.kind AS kind,
               invoices.counterparty_id AS counterparty_id,
               CASE
                 WHEN invoices.counterparty_id IS NOT NULL THEN COALESCE(customers.name, suppliers.name, invoices.counterparty_name)
                 ELSE invoices.counterparty_name
               END AS counterparty_name,
               SUM(invoices.remaining_amount) AS remaining_total,
               COUNT(*) AS invoice_count,
               MIN(invoices.invoice_date) AS oldest_date,
               MAX(invoices.invoice_date) AS latest_date,
               CASE WHEN invoices.kind = 'PURCHASE' AND invoices.counterparty_id IS NOT NULL
                 THEN COALESCE((SELECT SUM(${sql.raw(supplierSignedAmountSql("e"))})
                                FROM supplier_account_entries e WHERE e.supplier_id = invoices.counterparty_id), 0)
                 ELSE NULL END AS account_balance
        FROM invoices
        LEFT JOIN customers ON invoices.counterparty_id = customers.id
        LEFT JOIN suppliers ON invoices.counterparty_id = suppliers.id
        WHERE invoices.remaining_amount > 0 AND (invoices.counterparty_id IS NOT NULL OR invoices.counterparty_name IS NOT NULL)
        GROUP BY invoices.kind, COALESCE(invoices.counterparty_id, invoices.counterparty_name)
        ORDER BY remaining_total DESC`)) as DebtSummaryRow[];
      const summaries = aggregated.map((r) => {
        const kind =
          r.kind === "SALE"
            ? ("SALE" as const)
            : r.kind === "PURCHASE"
              ? ("PURCHASE" as const)
              : (() => {
                  // SAFETY: invoices.kind is enum-constrained; other values mean corruption
                  throw new Error(`unexpected invoice kind in debt summary: ${String(r.kind)}`);
                })();
        return {
          counterpartyId: r.counterparty_id == null ? null : String(r.counterparty_id),
          counterpartyName: r.counterparty_name == null ? null : String(r.counterparty_name),
          kind,
          remainingTotal: Number(r.remaining_total),
          invoiceCount: Number(r.invoice_count),
          oldestInvoiceDate: r.oldest_date == null ? null : String(r.oldest_date),
          latestInvoiceDate: r.latest_date == null ? null : String(r.latest_date),
          accountBalance: r.account_balance == null ? null : Number(r.account_balance),
        } satisfies DebtSummary;
      });
      // A supplier whose invoices are all settled but whose account still holds
      // a credit (or a positive balance with no unpaid invoice) has no row in
      // the invoice aggregate; add it from the signed ledger so /debts shows the
      // net balance the ADR promises.
      // SAFETY: the SELECT aliases exactly these columns; the counts and the
      // balance are SQLite INTEGERs, the id/name/date columns TEXT.
      const creditOnly = (await db.all(sql`
        SELECT s.id AS counterparty_id, s.name AS counterparty_name,
               COALESCE((SELECT SUM(${sql.raw(supplierSignedAmountSql("e"))})
                         FROM supplier_account_entries e WHERE e.supplier_id = s.id), 0) AS account_balance,
               (SELECT COUNT(*) FROM invoices i WHERE i.counterparty_id = s.id AND i.kind = 'PURCHASE') AS invoice_count,
               (SELECT MIN(i.invoice_date) FROM invoices i WHERE i.counterparty_id = s.id AND i.kind = 'PURCHASE') AS oldest_date,
               (SELECT MAX(i.invoice_date) FROM invoices i WHERE i.counterparty_id = s.id AND i.kind = 'PURCHASE') AS latest_date
        FROM suppliers s
        WHERE EXISTS (SELECT 1 FROM supplier_account_entries e WHERE e.supplier_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.counterparty_id = s.id AND i.kind = 'PURCHASE' AND i.remaining_amount > 0)
          AND COALESCE((SELECT SUM(${sql.raw(supplierSignedAmountSql("e"))})
                        FROM supplier_account_entries e WHERE e.supplier_id = s.id), 0) <> 0
      `)) as Array<{ counterparty_id: unknown; counterparty_name: unknown; account_balance: unknown; invoice_count: unknown; oldest_date: unknown; latest_date: unknown }>;
      for (const row of creditOnly) {
        summaries.push({
          counterpartyId: String(row.counterparty_id),
          counterpartyName: row.counterparty_name == null ? null : String(row.counterparty_name),
          kind: "PURCHASE",
          remainingTotal: 0,
          invoiceCount: Number(row.invoice_count),
          oldestInvoiceDate: row.oldest_date == null ? null : String(row.oldest_date),
          latestInvoiceDate: row.latest_date == null ? null : String(row.latest_date),
          accountBalance: Number(row.account_balance),
        } satisfies DebtSummary);
      }
      return summaries;
    },
    async dashboardSummary(day: string): Promise<DashboardAggregates> {
      // One aggregate read for the landing screen (issue 84). The day's sales
      // are summed in SQL (never a capped invoicesList page), both debt
      // directions and the low-stock count are aggregates, and the newest
      // invoices are ordered by creation time — the api's business-date-first
      // order would push a just-created backdated invoice off the page. The
      // debt predicates mirror debtSummaries() exactly (kind + unpaid +
      // attributed to a party), so the card agrees with the /debts screen it
      // links to and never claims a debt nobody can follow up.
      // The three money reads are the headline figures. If one of them cannot
      // be read the whole answer is unavailable, and the caller shows its error
      // state rather than a page of numbers it cannot vouch for.
      const [salesRows, owedRows, supplierLedgerRows, typedWeOweRows] = await Promise.all([
        db
          .select({ total: sql<number>`COALESCE(SUM(${invoices.totalAmount}), 0)`, count: sql<number>`COUNT(*)` })
          .from(invoices)
          .where(and(eq(invoices.kind, "SALE"), eq(invoices.invoiceDate, day))),
        db
          .select({ total: sql<number>`COALESCE(SUM(${invoices.remainingAmount}), 0)` })
          .from(invoices)
          .where(
            and(
              eq(invoices.kind, "SALE"),
              sql`${invoices.remainingAmount} > 0`,
              sql`(${invoices.counterpartyId} IS NOT NULL OR ${invoices.counterpartyName} IS NOT NULL)`,
            ),
          ),
        // "we owe" is the supplier NET account balance, exactly what /debts
        // shows: a migrated opening balance with no invoice would otherwise be
        // invisible on the dashboard (issue 176). The signed SUM spans every
        // supplier, so a credit offsets a debt the same way the /debts group
        // total does.
        db.all(sql`SELECT COALESCE(SUM(${sql.raw(supplierSignedAmountSql("e"))}), 0) AS total FROM supplier_account_entries e`),
        // typed-name purchases have no account; their unpaid remainder still
        // counts (the invoice-based path ADR-0009 left untouched)
        db
          .select({ total: sql<number>`COALESCE(SUM(${invoices.remainingAmount}), 0)` })
          .from(invoices)
          .where(
            and(
              eq(invoices.kind, "PURCHASE"),
              sql`${invoices.remainingAmount} > 0`,
              sql`${invoices.counterpartyId} IS NULL`,
              sql`${invoices.counterpartyName} IS NOT NULL`,
            ),
          ),
      ]);

      // The remaining sections degrade on their own. A single Promise.all over
      // all six reads meant one failing low-stock read blanked the sales and
      // debt figures that had already succeeded.
      const [lowStockCountResult, lowStockRowsResult, recentRowsResult] = await Promise.allSettled([
        db
          .select({ count: sql<number>`COUNT(*)` })
          .from(items)
          .where(sql`${items.stockOnHand} <= ${items.lowStockThreshold}`),
        db
          .select(itemCols)
          .from(items)
          .where(sql`${items.stockOnHand} <= ${items.lowStockThreshold}`)
          .orderBy(items.stockOnHand, items.name),
        db.select(invoiceCols).from(invoices).orderBy(desc(invoices.createdAt), sql`rowid DESC`).limit(5),
      ]);

      // A rejected read is reported here: the partial response still succeeds at
      // the RPC layer, so without this the cause would leave no trace anywhere.
      for (const [section, result] of [
        ["lowStockCount", lowStockCountResult],
        ["lowStockItems", lowStockRowsResult],
        ["recentInvoices", recentRowsResult],
      ] as const) {
        if (result.status === "rejected") {
          logger?.warn("DASHBOARD_SECTION_FAILED", `${section} read failed: ${String(result.reason)}`);
        }
      }

      return {
        salesTotal: Number(salesRows[0]?.total ?? 0),
        salesCount: Number(salesRows[0]?.count ?? 0),
        owedToUs: Number(owedRows[0]?.total ?? 0),
        // SAFETY: the raw SELECT aliases one column `total` (a SQLite INTEGER),
        // so the first row, when present, has that shape
        weOwe: Number((supplierLedgerRows as Array<{ total: number }>)[0]?.total ?? 0) + Number(typedWeOweRows[0]?.total ?? 0),
        lowStockCount:
          lowStockCountResult.status === "fulfilled" ? Number(lowStockCountResult.value[0]?.count ?? 0) : null,
        lowStockItems: lowStockRowsResult.status === "fulfilled" ? lowStockRowsResult.value : null,
        recentInvoices: recentRowsResult.status === "fulfilled" ? mapRecentInvoices(recentRowsResult.value) : null,
      };
    },

    async onboardingProgress(): Promise<OnboardingProgress> {
      // One EXISTS read for the getting-started checklist (issue 97). Each flag
      // names a real record — an item, a purchase invoice, a sale invoice, a
      // party-attributed unpaid SALE debt — so no client-settable flag can mark
      // a step done. The debt predicate mirrors the SALE direction of
      // dashboardSummary/debtSummaries, so the step agrees with the "owed to us"
      // group on the /debts screen it links to.
      // SAFETY: the SELECT is four EXISTS subqueries, so sqlite always returns
      // exactly one row carrying these aliases as INTEGER 0/1 values.
      const rows = (await db.all(sql`
        SELECT
          EXISTS(SELECT 1 FROM items) AS has_items,
          EXISTS(SELECT 1 FROM invoices WHERE kind = 'SALE') AS has_sale,
          EXISTS(SELECT 1 FROM invoices WHERE kind = 'PURCHASE') AS has_purchase,
          EXISTS(
            SELECT 1 FROM invoices
            WHERE kind = 'SALE' AND remaining_amount > 0
              AND (counterparty_id IS NOT NULL OR counterparty_name IS NOT NULL)
          ) AS has_debt`)) as Array<{
        has_items: number;
        has_sale: number;
        has_purchase: number;
        has_debt: number;
      }>;
      const row = rows[0];
      return {
        hasItems: row?.has_items === 1,
        hasPurchase: row?.has_purchase === 1,
        hasSale: row?.has_sale === 1,
        hasDebt: row?.has_debt === 1,
      };
    },

    async recordOnboardingCompletion(): Promise<boolean> {
      // Idempotent and re-checked: the milestone is written only while every
      // real record still exists, so a retry can never mark a half-done
      // checklist. Runs inside the caller's queue slot (this.* is the raw
      // object), so the read and the write cannot interleave with a rival.
      const progress = await this.onboardingProgress();
      const completed = progress.hasItems && progress.hasPurchase && progress.hasSale && progress.hasDebt;
      if (!completed) return false;
      await this.setPreference(ONBOARDING_COMPLETED_PREFERENCE_KEY, "true");
      return true;
    },
    // --- activities + settings ----------------------------------------------
    async insertActivity(activity: { type: Activity["type"]; summary: string; ref?: string | null }) {
      const value: (typeof activities.$inferInsert) & { ref: string | null } = {
        id: id(),
        at: now(),
        type: activity.type,
        summary: activity.summary,
        ref: activity.ref ?? null,
      };
      await db.insert(activities).values(value).run();
    },
    async listActivities(pagination?: PaginationInput) {
      // same-second entries break alphabetical id tiebreaks; rowid keeps
      // insertion order, so newest written comes first within a second
      const rowsQuery = db.select(activityCols).from(activities).orderBy(desc(activities.at), sql`rowid DESC`);
      if (pagination === undefined) {
        const items = await rowsQuery;
        return { items, total: items.length };
      }
      const { limit, offset } = resolvePagination(pagination);
      const [items, total] = await Promise.all([
        rowsQuery.limit(limit).offset(offset),
        db.$count(activities),
      ]);
      return { items, total };
    },
    async databaseIsEmpty() {
      // The tables a provisioned shop writes to. Seed rows (categories,
      // expense categories, settings, sequences, migration markers) and the
      // activity log are deliberately excluded: a startup DAILY_BACKUP
      // activity row must not read as "the shop already has data".
      const counts = await Promise.all([
        db.$count(items),
        db.$count(invoices),
        db.$count(invoiceLines),
        db.$count(payments),
        db.$count(customers),
        db.$count(suppliers),
        db.$count(expenses),
        db.$count(returns),
        db.$count(returnLines),
        db.$count(stockMovements),
        db.$count(stockLinks),
        db.$count(supplierAccountEntries),
        db.$count(supplierReturns),
        db.$count(supplierReturnLines),
      ]);
      if (counts.some((count) => count > 0)) return false;

      // Shop records can be gone while the database is still a previously
      // provisioned shop: a tampered or half-restored folder. The identity
      // marker and a used number sequence prove it was claimed, so first-run
      // setup must refuse (ADR-0008 §4.1).
      // SAFETY: settings.key is the primary key; the literal SELECT yields one
      // string value per row
      const adminMarker = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "adminUserId")).limit(1);
      if (adminMarker.length > 0) return false;
      const sequences = await Promise.all([
        db.select({ next: invoiceNumberSequence.nextNumber }).from(invoiceNumberSequence).limit(1),
        db.select({ next: returnNumberSequence.nextNumber }).from(returnNumberSequence).limit(1),
      ]);
      // A fresh setup seeds both sequences at 1; any allocation moves one
      // past 1 (allocateInvoiceNumber / allocateReturnNumber).
      return sequences.every((rows) => (rows[0]?.next ?? 1) <= 1);
    },
    async getSetting(key: string) {
      const row = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
      return row[0]?.value;
    },
    async setSetting(key: string, value: string) {
      await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
    },
    async getSettings(): Promise<Settings> {
      const name = await this.getSetting("storeName");
      const phone = await this.getSetting("storePhone");
      const address = await this.getSetting("storeAddress");
      return { storeName: name ?? "Dokan", storePhone: phone ? phone : null, storeAddress: address ? address : null };
    },
    async updateSettings(patch: SettingsUpdate): Promise<Settings> {
      if (patch.storeName !== undefined) await this.setSetting("storeName", patch.storeName);
      if (patch.storePhone !== undefined) await this.setSetting("storePhone", patch.storePhone ?? "");
      if (patch.storeAddress !== undefined) await this.setSetting("storeAddress", patch.storeAddress ?? "");
      return this.getSettings();
    },

    // --- UI preferences ------------------------------------------------------
    async getPreferences(): Promise<Record<string, string>> {
      // A handful of rows (sidebar + onboarding); a plain scan is cheapest and
      // needs no index beyond the primary key.
      const rows = await db.select({ key: preferences.key, value: preferences.value }).from(preferences);
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },
    async setPreference(key: string, value: string) {
      await db
        .insert(preferences)
        .values({ key, value })
        .onConflictDoUpdate({ target: preferences.key, set: { value } })
        .run();
    },

    // --- backup --------------------------------------------------------------
    async copyDatabaseTo(destPath: string) {
      conn.checkpoint();
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      // the encrypted store writes a self-contained bundle (key wraps +
      // snapshot) so an exported backup can be unlocked on another install;
      // the legacy file-backed database copies its plain SQLite file
      if (conn.writeBackupTo !== undefined) {
        await conn.writeBackupTo(destPath);
        return;
      }
      await fs.promises.copyFile(conn.dbPath, destPath);
    },
    dbPath() {
      return conn.dbPath;
    },
  };

  return serializeStore(store);
}