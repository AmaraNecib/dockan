import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type {
  Activity,
  Category,
  Customer,
  DebtSummary,
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
  Supplier,
} from "@dokan/contracts";

import type { Connection } from "../db/connection";
import { SCHEMA_DDL, activities, categories, customers, invoiceLines, invoices, items, payments, settings, suppliers } from "../db/schema";
import { localDateTime } from "../lib/logger";
import type { StorePort } from "./port";

const now = () => localDateTime();
const id = () => randomUUID();

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
  unitPrice: invoiceLines.unitPrice,
  costAtSale: invoiceLines.costAtSale,
  total: invoiceLines.total,
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

// returning() yields snake_case rows; these mappers convert the seven shapes
// we write back into their contract camelCase forms, checked with satisfies.
const toCategory = (r: typeof categories.$inferSelect): Category =>
  ({ id: r.id, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt }) satisfies Category;
const toItem = (r: typeof items.$inferSelect): Item =>
  ({ id: r.id, name: r.name, categoryId: r.categoryId, costPrice: r.costPrice, sellingPrice: r.sellingPrice, lowStockThreshold: r.lowStockThreshold, stockOnHand: r.stockOnHand, createdAt: r.createdAt, updatedAt: r.updatedAt }) satisfies Item;
const toCustomer = (r: typeof customers.$inferSelect): Customer =>
  ({ id: r.id, name: r.name, phone: r.phone, createdAt: r.createdAt }) satisfies Customer;
const toSupplier = (r: typeof suppliers.$inferSelect): Supplier =>
  ({ id: r.id, name: r.name, phone: r.phone, createdAt: r.createdAt }) satisfies Supplier;
const toInvoice = (r: typeof invoices.$inferSelect): Invoice =>
  ({ id: r.id, invoiceNumber: r.invoiceNumber, kind: r.kind, counterpartyId: r.counterpartyId, counterpartyName: r.counterpartyName, invoiceDate: r.invoiceDate, totalAmount: r.totalAmount, paidAmount: r.paidAmount, remainingAmount: r.remainingAmount, notes: r.notes, createdAt: r.createdAt, updatedAt: r.updatedAt }) satisfies Invoice;
const toInvoiceLine = (r: typeof invoiceLines.$inferSelect): InvoiceLine =>
  ({ id: r.id, invoiceId: r.invoiceId, itemId: r.itemId, description: r.description, quantity: r.quantity, unitPrice: r.unitPrice, costAtSale: r.costAtSale, total: r.total }) satisfies InvoiceLine;
const toPayment = (r: typeof payments.$inferSelect): Payment =>
  ({ id: r.id, invoiceId: r.invoiceId, amount: r.amount, method: r.method, note: r.note, paidAt: r.paidAt, createdAt: r.createdAt }) satisfies Payment;

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

  const serializeStore = (raw: StorePort): StorePort => {
    // SAFETY: a port object exposes only documented members
    const entries = Object.entries(raw) as Array<[keyof StorePort, unknown]>;
    const wrapEntry = ([key, value]: readonly [keyof StorePort, unknown]): readonly [string, StorePort[keyof StorePort]] => {
      if (key === "withTransaction") {
        // SAFETY: withTransaction keeps its own serialization; no wrapper needed
        return [key, value as StorePort["withTransaction"]];
      }
      // args are never[] (the object shape opaques them); R is resolved at
      // each call site to the raw method's real result type
      // SAFETY: every call queues behind open transactions; nothing can ever
      // execute inside another unit's BEGIN/COMMIT window
      const wrapped = <R,>(...args: never[]): Promise<R> =>
        runSerialized(() => (value as (...a: never[]) => Promise<R>)(...args));
      // SAFETY: wrapped implements the raw method named by key via its generic R
      return [key, wrapped as StorePort[keyof StorePort]];
    };
    // SAFETY: fromEntries returns a plain dictionary keyed by the exact names,
    // so the value type is the method union indexed by those same keys
    const built = Object.fromEntries(entries.map(wrapEntry)) as Record<keyof StorePort, StorePort[keyof StorePort]>;
    // SAFETY: built mirrors raw's exact key set; every member is present
    return built as StorePort;
  };

  async function setup(): Promise<void> {
    for (const ddl of SCHEMA_DDL) await db.run(sql.raw(ddl));

    const categoriesCount = await db.$count(categories);
    if (categoriesCount === 0) {
      await db.insert(categories).values({ id: id(), name: "عام", createdAt: now(), updatedAt: now() }).run();
    }
    const storeName = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "storeName")).limit(1);
    if (storeName.length === 0) {
      await db.insert(settings).values({ key: "storeName", value: "Dokan" }).run();
      await db.insert(settings).values({ key: "storePhone", value: "" }).run();
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
    async createItem(input: ItemCreate) {
      const row = firstRowOf(
        await db
          .insert(items)
          .values({
            id: id(),
            name: input.name,
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
      const rows = await db.update(items).set(set).where(eq(items.id, idToUpdate)).returning();
      return rows.length === 0 ? undefined : toItem(firstRowOf(rows));
    },
    async setItemStockAndCost(itemId: string, stockOnHand: number, costPrice: number) {
      await db.update(items).set({ stockOnHand, costPrice, updatedAt: now() }).where(eq(items.id, itemId)).run();
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
    withTransaction: <T>(fn: (tx: StorePort) => Promise<T>): Promise<T> => {
      // serialized against every other store call; the unit keeps the queue
      // for its whole run so no second BEGIN can appear mid-transaction. The
      // callback receives an unqueued store (directSeed) so its internal calls
      // never deadlock, while every EXTERNAL operation queues behind the unit
      // and can never land inside this transaction (greptile P1).
      return runSerialized(async () => {
        const tx = directSeed(store);
        conn.raw.exec("BEGIN");
        try {
          const result = await fn(tx);
          conn.raw.exec("COMMIT");
          return result;
        } catch (err) {
          conn.raw.exec("ROLLBACK");
          throw err;
        }
      });
    },
    async lastInvoiceNumber() {
      const latest = await db.select({ invoiceNumber: invoices.invoiceNumber }).from(invoices).orderBy(desc(invoices.createdAt), desc(invoices.id)).limit(1);
      return latest[0]?.invoiceNumber;
    },
    async insertInvoice(inv: Omit<Invoice, "id" | "createdAt" | "updatedAt">) {
      const row = firstRowOf(await db.insert(invoices).values({ id: id(), ...inv, createdAt: now(), updatedAt: now() }).returning());
      return toInvoice(row);
    },
    async insertInvoiceLine(line: Omit<InvoiceLine, "id">) {
      const row = firstRowOf(await db.insert(invoiceLines).values({ id: id(), ...line }).returning());
      return toInvoiceLine(row);
    },
    async insertPayment(p: Omit<Payment, "id" | "createdAt">) {
      const row = firstRowOf(await db.insert(payments).values({ id: id(), ...p, createdAt: now() }).returning());
      return toPayment(row);
    },
    async getInvoiceDetail(invoiceId: string) {
      const [invoice, lines, paymentsRows] = await Promise.all([
        db.select(invoiceCols).from(invoices).where(eq(invoices.id, invoiceId)).limit(1),
        db.select(lineCols).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.id),
        db.select(paymentCols).from(payments).where(eq(payments.invoiceId, invoiceId)).orderBy(payments.paidAt, payments.id),
      ]);
      const header = invoice[0];
      if (header === undefined) return undefined;
      return { ...header, lines, payments: paymentsRows } satisfies InvoiceDetail;
    },
    async listInvoices(filters: InvoiceListFilters) {
      const conds: SQL[] = [];
      if (filters.kind) conds.push(sql`${invoices.kind} = ${filters.kind}`);
      if (filters.status === "PAID") conds.push(sql`${invoices.remainingAmount} = 0`);
      else if (filters.status === "UNPAID") conds.push(sql`${invoices.remainingAmount} = ${invoices.totalAmount}`);
      else if (filters.status === "PARTIAL") conds.push(sql`${invoices.remainingAmount} > 0 AND ${invoices.remainingAmount} < ${invoices.totalAmount}`);
      if (filters.fromDate) conds.push(sql`${invoices.invoiceDate} >= ${filters.fromDate}`);
      if (filters.toDate) conds.push(sql`${invoices.invoiceDate} <= ${filters.toDate}`);
      const where = conds.length ? and(...conds) : undefined;

      const [totalCount, itemsRows] = await Promise.all([
        db.$count(invoices, where),
        db.select(invoiceCols).from(invoices).where(where).orderBy(desc(invoices.invoiceDate), desc(invoices.createdAt)).limit(200),
      ]);
      return { items: itemsRows, totalCount };
    },
    async setInvoicePaidAmounts(invoiceId: string, paidAmount: number, remainingAmount: number) {
      await db.update(invoices).set({ paidAmount, remainingAmount, updatedAt: now() }).where(eq(invoices.id, invoiceId)).run();
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