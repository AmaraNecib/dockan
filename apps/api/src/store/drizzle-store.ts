import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
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
  PartyCreate,
  Payment,
  Settings,
  SettingsUpdate,
  StockMovement,
  Supplier,
} from "@dokan/contracts";
import type { Connection } from "../db/connection";
import { SCHEMA_DDL, activities, categories, customers, expenseCategories, expenses, invoiceLines, invoices, items, payments, settings, stockLinks, stockMovements, suppliers } from "../db/schema";
import { localDateTime } from "../lib/logger";
import type { InvoiceInsert, InvoiceLineInsert, ProfitSaleLine, StockLink, StorePort } from "./port";

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
const lineCols = {
  id: invoiceLines.id,
  invoiceId: invoiceLines.invoiceId,
  itemId: invoiceLines.itemId,
  description: invoiceLines.description,
  quantity: invoiceLines.quantity,
  defaultUnitPrice: invoiceLines.defaultUnitPrice,
  unitPrice: invoiceLines.unitPrice,
  costAtSale: invoiceLines.costAtSale,
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
  occurredAt: stockMovements.occurredAt,
  createdAt: stockMovements.createdAt,
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
    total: r.total,
    discountAllocated: r.discountAllocated ?? 0,
    netTotal: r.netTotal ?? r.total,
  }) satisfies InvoiceLine;
const toPayment = (r: typeof payments.$inferSelect): Payment =>
  ({ id: r.id, invoiceId: r.invoiceId, amount: r.amount, method: r.method, note: r.note, paidAt: r.paidAt, createdAt: r.createdAt }) satisfies Payment;
const toMovement = (r: typeof stockMovements.$inferSelect): StockMovement =>
  ({ id: r.id, itemId: r.itemId, kind: r.kind, delta: r.delta, unitCost: r.unitCost, reason: r.reason, ref: r.ref, occurredAt: r.occurredAt, createdAt: r.createdAt }) satisfies StockMovement;
const toExpenseCategory = (r: typeof expenseCategories.$inferSelect): ExpenseCategory =>
  ({ id: r.id, name: r.name, isOwnerWithdrawal: r.isOwnerWithdrawal === 1, createdAt: r.createdAt, updatedAt: r.updatedAt }) satisfies ExpenseCategory;
const toExpense = (r: typeof expenses.$inferSelect): Expense =>
  ({ id: r.id, categoryId: r.categoryId, amount: r.amount, note: r.note, occurredAt: r.occurredAt, createdAt: r.createdAt }) satisfies Expense;
const toStockLink = (r: typeof stockLinks.$inferSelect): StockLink =>
  ({ id: r.id, invoiceId: r.invoiceId, movementId: r.movementId, quantity: r.quantity, createdAt: r.createdAt }) satisfies StockLink;

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

type DebtSummaryRow = {
  kind: unknown;
  counterparty_id: unknown;
  counterparty_name: unknown;
  remaining_total: unknown;
  invoice_count: unknown;
  oldest_date: unknown;
  latest_date: unknown;
};

/**
 * SQLite adapter for StorePort, built on Drizzle + bun:sqlite.
 * This file is the only place that knows the driver; everything above it
 * speaks StorePort (ADR-0003). A postgres adapter replaces this file, not
 * anything above it.
 */
export function createDrizzleStore(conn: Connection): StorePort {
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
      try {
        const result = await fn(tx);
        conn.raw.exec("COMMIT");
        return result;
      } catch (err) {
        conn.raw.exec("ROLLBACK");
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
      // SAFETY: value is the raw method this key names (its result type is R);
      // .bind fixes the receiver, so this.*-style methods keep working; the
      // cast keeps the same call signature
      const wrapped = <R,>(...args: never[]): Promise<R> =>
        runSerialized(() => (value as (...a: never[]) => Promise<R>).bind(raw)(...args));
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
      // SAFETY: PRAGMA table_info returns rows shaped { name, type, ... }
      const rows = conn.raw.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const names = new Set(rows.map((row) => row.name));
      return names.has("account_id") || names.has("provider_id") || names.has("user_id") || names.has("expires_at");
    };
    const legacyTables = tables.filter(looksLegacy);
    const occupied = legacyTables.filter((table) => {
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
    for (const ddl of SCHEMA_DDL) await db.run(sql.raw(ddl));
    ensureSaleColumns();

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
  }

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
    async listItems() {
      return db.select(itemCols).from(items).orderBy(items.name);
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
      // raw line facts only: netTotal (revenue basis) and costAtSale×quantity
      // (COGS basis); the pure report module owns the formulas
      // SAFETY: the SELECT aliases exactly produce these camelCase keys from
      // the fixed column list; the raw result's shape is pinned by the literal
      // query, not by any user input
      const rows = (await db.all(sql`
        SELECT l.invoice_id AS invoiceId, i.invoice_date AS invoiceDate,
               l.quantity AS quantity, l.cost_at_sale AS costAtSale,
               l.net_total AS netTotal
        FROM invoice_lines l
        JOIN invoices i ON i.id = l.invoice_id
        WHERE i.kind = 'SALE'
          AND i.invoice_date >= substr(${from}, 1, 10)
          AND i.invoice_date <= substr(${to}, 1, 10)
      `)) as Array<ProfitSaleLine>;
      return rows;
    },

    // --- parties -------------------------------------------------------------
    async listCustomers() {
      return db.select(customerCols).from(customers).orderBy(customers.name);
    },
    async createCustomer(input: PartyCreate) {
      const row = firstRowOf(await db.insert(customers).values({ id: id(), name: input.name, phone: input.phone ?? null, createdAt: now() }).returning());
      return toCustomer(row);
    },
    async listSuppliers() {
      return db.select(supplierCols).from(suppliers).orderBy(suppliers.name);
    },
    async createSupplier(input: PartyCreate) {
      const row = firstRowOf(await db.insert(suppliers).values({ id: id(), name: input.name, phone: input.phone ?? null, createdAt: now() }).returning());
      return toSupplier(row);
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
      const [invoice, lines, paymentsRows] = await Promise.all([
        db.select(invoiceCols).from(invoices).where(eq(invoices.id, invoiceId)).limit(1),
        db.select(lineCols).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.id),
        db.select(paymentCols).from(payments).where(eq(payments.invoiceId, invoiceId)).orderBy(payments.paidAt, sql`rowid`),
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

      const [totalCount, itemsRows] = await Promise.all([
        db.$count(invoices, where),
        db.select(invoiceCols).from(invoices).where(where).orderBy(desc(invoices.invoiceDate), desc(invoices.createdAt)).limit(200),
      ]);
      return {
        items: itemsRows.map((row) => ({ ...row, ...normalizeInvoiceLegacy(row) })),
        totalCount,
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
      // SAFETY: GROUP BY yields one row per (kind, party); the keys below
      // match the alias names, columns are TEXT/INTEGER per db/schema.ts.
      const aggregated = (await db.all(sql`
        SELECT kind, counterparty_id, counterparty_name,
               SUM(remaining_amount) AS remaining_total,
               COUNT(*) AS invoice_count,
               MIN(invoice_date) AS oldest_date,
               MAX(invoice_date) AS latest_date
        FROM invoices
        WHERE remaining_amount > 0 AND (counterparty_id IS NOT NULL OR counterparty_name IS NOT NULL)
        GROUP BY kind, COALESCE(counterparty_id, counterparty_name)
        ORDER BY remaining_total DESC`)) as DebtSummaryRow[];
      return aggregated.map((r) => {
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
        } satisfies DebtSummary;
      });
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
    async listActivities(limit: number) {
      // same-second entries break alphabetical id tiebreaks; rowid keeps
      // insertion order, so newest written comes first within a second
      return db.select(activityCols).from(activities).orderBy(desc(activities.at), sql`rowid DESC`).limit(limit);
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
      return { storeName: name ?? "Dokan", storePhone: phone ? phone : null };
    },
    async updateSettings(patch: SettingsUpdate): Promise<Settings> {
      if (patch.storeName !== undefined) await this.setSetting("storeName", patch.storeName);
      if (patch.storePhone !== undefined) await this.setSetting("storePhone", patch.storePhone ?? "");
      return this.getSettings();
    },

    // --- backup --------------------------------------------------------------
    async copyDatabaseTo(destPath: string) {
      conn.checkpoint();
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.copyFile(conn.dbPath, destPath);
    },
    dbPath() {
      return conn.dbPath;
    },
  };

  return serializeStore(store);
}