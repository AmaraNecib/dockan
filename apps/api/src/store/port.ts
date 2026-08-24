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

  listCustomers(): Promise<Customer[]>;
  createCustomer(input: PartyCreate): Promise<Customer>;
  listSuppliers(): Promise<Supplier[]>;
  createSupplier(input: PartyCreate): Promise<Supplier>;

  /** Runs an atomic unit; the callback receives the same store with the queue
   * bypassed for its own calls, so nested operations never deadlock and no
   * external call can ever land inside this transaction. */
  withTransaction<T>(fn: (tx: StorePort) => Promise<T>): Promise<T>;
  lastInvoiceNumber(): Promise<string | undefined>;
  insertInvoice(inv: Omit<Invoice, "id" | "createdAt" | "updatedAt">): Promise<Invoice>;
  insertInvoiceLine(line: Omit<InvoiceLine, "id">): Promise<InvoiceLine>;
  insertPayment(p: Omit<Payment, "id" | "createdAt">): Promise<Payment>;
  getInvoiceDetail(id: string): Promise<InvoiceDetail | undefined>;
  listInvoices(filters: InvoiceListFilters): Promise<{ items: Invoice[]; totalCount: number }>;
  setInvoicePaidAmounts(id: string, paidAmount: number, remainingAmount: number): Promise<void>;
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