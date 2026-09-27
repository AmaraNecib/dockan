import type {
  Activity,
  ActivityType,
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
  ItemListItem,
  ItemUpdate,
  OnboardingProgress,
  PartyCreate,
  Payment,
  ReturnDetail,
  ReturnMark,
  ReturnPayoutMethod,
  ReturnStatus,
  Settings,
  SettingsUpdate,
  StockMovement,
  Supplier,
} from "@dokan/contracts";

export type { Category, Item, Customer, Supplier, Invoice, InvoiceLine, Payment, Activity, Settings, Expense, ExpenseCategory };

/**
 * One raw SALE invoice line fact the profit report sums. Read via a JOIN of
 * invoice_lines × invoices (kind=SALE) inside the window; the pure report
 * module (profit-report.ts) owns the formulas, this seam only carries facts.
 */
export interface ProfitSaleLine {
  invoiceId: string;
  invoiceDate: string;
  quantity: number;
  costAtSale: number;
  /** exact total COGS of the layers this line consumed (unrounded FIFO sum) */
  cogsExact: number;
  netTotal: number;
}

/**
 * Minimal logging seam for degraded reads. Structural on purpose: the store
 * reports a failure without importing the app logger, so it stays testable.
 */
export type StoreLogger = {
  warn(event: string, message: string): void;
};

/**
 * Landing-screen aggregates (issue 84) computed in one store read. The day is
 * supplied by the caller (the router's server clock), so the store stays
 * clock-free; every money figure is a SQL aggregate over the raw rows.
 */
export interface DashboardAggregates {
  /** exact sum of SALE invoice totals dated the supplied day */
  salesTotal: number;
  salesCount: number;
  /** party-attributed remaining debt across unpaid SALE invoices (agrees with the debts screen) */
  owedToUs: number;
  /** party-attributed remaining debt across unpaid PURCHASE invoices */
  weOwe: number;
  lowStockCount: number | null;
  /** low-stock rows for the detail list, ordered by on-hand then name */
  lowStockItems: Item[] | null;
  /** five newest invoices by creation time, newest first */
  recentInvoices: Invoice[] | null;
}

/** Additive invoice fields are optional at the write seam so older adapters and
 * migration tests can keep inserting the pre-discount shape. The adapter
 * returns the complete historical response shape with safe zero defaults. */
export type InvoiceInsert = Omit<Invoice, "id" | "createdAt" | "updatedAt" | "subtotalAmount" | "discountType" | "discountValue" | "discountAmount"> &
  Partial<Pick<Invoice, "subtotalAmount" | "discountType" | "discountValue" | "discountAmount">>;
export type InvoiceLineInsert = Omit<InvoiceLine, "id" | "defaultUnitPrice" | "discountAllocated" | "netTotal" | "cogsExact"> &
  Partial<Pick<InvoiceLine, "defaultUnitPrice" | "discountAllocated" | "netTotal" | "cogsExact">>;

export interface StockLink {
  id: string;
  invoiceId: string;
  movementId: string;
  quantity: number;
  createdAt: string;
}

/** Raw return facts the adapter persists; the router owns review-state rules. */
export type ReturnInsert = {
  returnNumber: string;
  invoiceId: string;
  refundAmount: number;
  /** cash handed back now (whole DZD) */
  cashPaidOut: number;
  /** deducted from the invoice's remaining debt; cashPaidOut + debtOffset = refundAmount */
  debtOffset: number;
  payoutMethod: ReturnPayoutMethod;
  reason: string | null;
  status: ReturnStatus;
  occurredAt: string;
};

export type ReturnLineInsert = {
  returnId: string;
  invoiceLineId: string;
  itemId: string | null;
  description: string;
  quantity: number;
  refundUnitPrice: number;
  refundAmount: number;
};

/** Summed returned quantity per invoice line (the refund cap key). */
export type ReturnedQuantityByLine = Map<string, number>;

/**
 * StorePort — the persistence seam. Procedures and use cases depend on this
 * interface and nothing else; no SQL or driver names escape it (ADR-0003).
 * `createDrizzleStore` implements it over bun:sqlite today; a postgres adapter
 * implements the same interface behind the DOKAN_DB_DRIVER config switch.
 */
export interface StorePort {
  /** idempotent: create tables, seed the default category + settings */
  setup(): Promise<void>;

  listCategories(): Promise<Category[]>;
  createCategory(input: { name: string }): Promise<Category>;

  listItems(): Promise<ItemListItem[]>;
  listLowStockItems(): Promise<Item[]>;
  getItemsByIds(ids: string[]): Promise<Map<string, Item>>;
  /** exact normalized-barcode lookup; undefined when no item carries it */
  getItemByBarcode(barcode: string): Promise<Item | undefined>;
  createItem(input: ItemCreate): Promise<Item>;
  updateItem(id: string, patch: ItemUpdate): Promise<Item | undefined>;
  /** stock + average cost kept atomic; used inside invoice transactions */
  setItemStockAndCost(id: string, stockOnHand: number, costPrice: number): Promise<void>;

  // --- stock ledger (ticket 27) --------------------------------------------
  /** append-only; no update or delete exists by design */
  insertStockMovement(movement: Omit<StockMovement, "id" | "createdAt" | "returnMark"> & Partial<Pick<StockMovement, "returnMark">>): Promise<StockMovement>;
  /** ordered by occurred_at, then insertion order (seq = rowid tiebreaker) */
  listStockMovements(itemId: string): Promise<Array<StockMovement & { seq: number }>>;
  countStockMovements(itemId: string): Promise<number>;

  // --- purchase linkage (ticket 29) ----------------------------------------
  /** appends an attribution record between a purchase invoice and an earlier
   * uninvoiced movement; the ledger itself is never rewritten */
  insertStockLink(link: { invoiceId: string; movementId: string; quantity: number }): Promise<StockLink>;
  /** all links whose movement belongs to the item (link consumption audit) */
  listStockLinksByItem(itemId: string): Promise<StockLink[]>;

  // --- expenses + profit report (ticket 31) --------------------------------
  listExpenseCategories(): Promise<ExpenseCategory[]>;
  /** names are UNIQUE; the adapter surfaces the violation as EXPENSE_CATEGORY_EXISTS */
  createExpenseCategory(input: { name: string; isOwnerWithdrawal?: boolean }): Promise<ExpenseCategory>;
  insertExpense(input: { categoryId: string; amount: number; note?: string | null; occurredAt: string }): Promise<Expense>;
  /** raw rows inside the optional category/range filters (ordering happens in
   * the pure module, so sort behavior is unit-tested without SQL) */
  listExpenseRecords(filters: { categoryIds?: string[]; from?: string; to?: string }): Promise<Expense[]>;
  /** raw SALE line facts (netTotal/costAtSale/cogsExact) for invoices dated in [from, to] */
  listSaleLinesForProfit(from: string, to: string): Promise<ProfitSaleLine[]>;

  listCustomers(): Promise<Customer[]>;
  createCustomer(input: PartyCreate): Promise<Customer>;
  listSuppliers(): Promise<Supplier[]>;
  createSupplier(input: PartyCreate): Promise<Supplier>;

  /** Runs an atomic unit; the callback receives the same store with the queue
   * bypassed for its own calls, so nested operations never deadlock and no
   * external call can ever land inside this transaction. */
  withTransaction<T>(fn: (tx: StorePort) => Promise<T>): Promise<T>;
  /** Like withTransaction but BEGIN IMMEDIATE — the write lock is taken before
   * the first read so money units never deadlock on a stale WAL read snapshot
   * (SQLITE_BUSY_SNAPSHOT) against a second process writing the same file.
   * Use for money-math units (payments); plain reads keep withTransaction. */
  withTransactionImmediate<T>(fn: (tx: StorePort) => Promise<T>): Promise<T>;
  /** Reserves the next invoice number atomically in the database. */
  allocateInvoiceNumber(): Promise<string>;
  /** Reserves the next return number (RTN-%04d) atomically in the database. */
  allocateReturnNumber(): Promise<string>;
  insertReturn(input: ReturnInsert): Promise<{ id: string }>;
  insertReturnLine(line: ReturnLineInsert): Promise<void>;
  /** full return with lines, newest-first; optional invoice scope */
  listReturns(filters: { invoiceId?: string }): Promise<ReturnDetail[]>;
  getReturnDetail(returnId: string): Promise<ReturnDetail | undefined>;
  /** return header joined to its invoice identity (internal + diagnostics) */
  getReturnHeader(returnId: string): Promise<ReturnDetail | undefined>;
  /** authoritative review guard: true only when the return was still pending */
  transitionReturnStatus(returnId: string, to: "ACCEPTED" | "REJECTED_DAMAGED"): Promise<boolean>;
  /** per-line already-returned totals for this invoice (quantity for the cap,
   * refundAmount for the sequence-aware refund remainder) */
  returnedByLine(invoiceId: string): Promise<Map<string, { quantity: number; refundAmount: number }>>;
  /** Atomic debt settlement: debits remainingAmount by amount ONLY while it
   * still covers the offset. Returns true when the debt moved, false when the
   * boundary was violated — the caller rolls the unit back in that case. */
  applyDebtOffsetToInvoice(invoiceId: string, amount: number): Promise<boolean>;
  /** record how much of a return's promised debtOffset was actually applied (#68) */
  setDebtApplied(returnId: string, amount: number): Promise<void>;
  /** consume the pending review tag on every movement a return created */
  setReturnMarks(returnId: string, mark: Exclude<ReturnMark, "PENDING">): Promise<void>;
  /** Record the review annotation on the return (the rejection note). */
  setReturnReason(returnId: string, reason: string): Promise<void>;
  /** Legacy read seam retained for diagnostics and existing callers. */
  lastInvoiceNumber(): Promise<string | undefined>;
  insertInvoice(inv: InvoiceInsert): Promise<Invoice>;
  insertInvoiceLine(line: InvoiceLineInsert): Promise<InvoiceLine>;
  insertPayment(p: Omit<Payment, "id" | "createdAt">): Promise<Payment>;
  /** Atomic instalment application: debits remainingAmount by amount ONLY while
   * it still covers the payment (single conditional UPDATE). Returns true when
   * the money moved, false when the boundary was violated — the caller rolls
   * the whole unit back in that case. DB-level guard: two processes on the
   * same file can never both overpay an invoice. */
  applyPaymentToInvoice(invoiceId: string, amount: number): Promise<boolean>;
  getInvoiceDetail(id: string): Promise<InvoiceDetail | undefined>;
  /** single line lookup; entry point for purchase corrections */
  getInvoiceLine(lineId: string): Promise<InvoiceLine | undefined>;
  listInvoices(filters: InvoiceListFilters): Promise<{ items: Invoice[]; totalCount: number }>;
  setInvoicePaidAmounts(id: string, paidAmount: number, remainingAmount: number): Promise<void>;
  /** unpaid invoices for one person (debts-screen drill-down). Matches the
   * debtSummaries grouping key: id for a known party, typed name otherwise,
   * so the two seams never disagree on identity. */
  listUnpaidInvoicesByParty(kind: Invoice["kind"], counterpartyId: string | null, counterpartyName: string | null): Promise<Invoice[]>;
  debtSummaries(): Promise<DebtSummary[]>;
  /** one aggregate read for the landing screen (issue 84): the day's sales
   * summed in SQL, both debt directions, low stock, and the newest invoices
   * by creation time — never a capped list re-summed or re-sorted client-side. */
  dashboardSummary(day: string): Promise<DashboardAggregates>;

  /** one EXISTS read for the getting-started checklist (issue 97): whether the
   * shop has an item, a purchase, a sale, and a party-attributed SALE debt. */
  onboardingProgress(): Promise<OnboardingProgress>;

  insertActivity(activity: { type: ActivityType; summary: string; ref?: string | null }): Promise<void>;
  listActivities(limit: number): Promise<Activity[]>;
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;
  getSettings(): Promise<Settings>;

  /** every client UI preference as one key/value map (sidebar, onboarding) */
  getPreferences(): Promise<Record<string, string>>;
  /** upsert one preference; deliberately separate from store-identity settings */
  setPreference(key: string, value: string): Promise<void>;
  updateSettings(patch: SettingsUpdate): Promise<Settings>;

  /** driver-specific: checkpoint then copy the database file to destPath */
  copyDatabaseTo(destPath: string): Promise<void>;
  /** absolute path of the live database file (for the backup report) */
  dbPath(): string;
}