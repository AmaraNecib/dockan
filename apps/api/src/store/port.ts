import type {
  Activity,
  ActivityType,
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
  StockMovement,
  Supplier,
} from "@dokan/contracts";

export type { Category, Item, Customer, Supplier, Invoice, InvoiceLine, Payment, Activity, Settings };

/** Additive invoice fields are optional at the write seam so older adapters and
 * migration tests can keep inserting the pre-discount shape. The adapter
 * returns the complete historical response shape with safe zero defaults. */
export type InvoiceInsert = Omit<Invoice, "id" | "createdAt" | "updatedAt" | "subtotalAmount" | "discountType" | "discountValue" | "discountAmount"> &
  Partial<Pick<Invoice, "subtotalAmount" | "discountType" | "discountValue" | "discountAmount">>;
export type InvoiceLineInsert = Omit<InvoiceLine, "id" | "defaultUnitPrice" | "discountAllocated" | "netTotal"> &
  Partial<Pick<InvoiceLine, "defaultUnitPrice" | "discountAllocated" | "netTotal">>;

/** Attribution record between a purchase invoice and earlier uninvoiced stock. */
export interface StockLink {
  id: string;
  invoiceId: string;
  movementId: string;
  quantity: number;
  createdAt: string;
}

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

  listItems(): Promise<Item[]>;
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
  insertStockMovement(movement: Omit<StockMovement, "id" | "createdAt">): Promise<StockMovement>;
  /** ordered by occurred_at, then insertion order (seq = rowid tiebreaker) */
  listStockMovements(itemId: string): Promise<Array<StockMovement & { seq: number }>>;
  countStockMovements(itemId: string): Promise<number>;

  // --- purchase linkage (ticket 29) ----------------------------------------
  /** appends an attribution record between a purchase invoice and an earlier
   * uninvoiced movement; the ledger itself is never rewritten */
  insertStockLink(link: { invoiceId: string; movementId: string; quantity: number }): Promise<StockLink>;
  /** all links whose movement belongs to the item (link consumption audit) */
  listStockLinksByItem(itemId: string): Promise<StockLink[]>;

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

  insertActivity(activity: { type: ActivityType; summary: string; ref?: string | null }): Promise<void>;
  listActivities(limit: number): Promise<Activity[]>;
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsUpdate): Promise<Settings>;

  /** driver-specific: checkpoint then copy the database file to destPath */
  copyDatabaseTo(destPath: string): Promise<void>;
  /** absolute path of the live database file (for the backup report) */
  dbPath(): string;
}