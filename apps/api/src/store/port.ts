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
  InvoiceKind,
  InvoiceLine,
  InvoiceListFilters,
  Item,
  ItemCreate,
  ItemListItem,
  ItemUpdate,
  OnboardingProgress,
  PaginationInput,
  Party,
  PartyCreate,
  PartyDetail,
  PartyListItem,
  PartyName,
  PartyPayment,
  PartyRole,
  PartyUpdate,
  Payment,
  PaymentMethod,
  ReturnDetail,
  ReturnMark,
  ReturnPayoutMethod,
  ReturnStatus,
  Settings,
  SettingsUpdate,
  StockMovement,
  Supplier,
  SupplierAccountEntry,
  SupplierAccountSummary,
  SupplierAdjustmentDirection,
  SupplierEntryKind,
  SupplierReturnLine,
  SupplierReturnRecord,
} from "@dokan/contracts";

export type { Category, Item, Customer, Supplier, Invoice, InvoiceLine, Payment, Activity, Settings, Expense, ExpenseCategory, SupplierAccountEntry, SupplierAccountSummary, SupplierReturnRecord, SupplierReturnLine, SupplierEntryKind, PartyName };

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
 * `error` is optional so existing test loggers keep compiling; the store uses
 * it for the fatal snapshot-persistence path.
 */
export type StoreLogger = {
  warn(event: string, message: string): void;
  error?(event: string, message: string, error: Error): void;
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
  /** signed supplier net position (#260): positive = the suppliers owe us (a
   * credit), negative = we owe them. Spans the supplier accounts plus any
   * typed-name purchase remainder (always a debt, so it subtracts). */
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

/** Raw supplier-account entry the adapter persists. `amount` is always positive;
 * the kind carries the sign. */
export type SupplierEntryInsert = {
  supplierId: string;
  kind: SupplierEntryKind;
  amount: number;
  /** ADJUSTMENT only (issue 176): WE_OWE / THEY_OWE carry the sign */
  direction?: SupplierAdjustmentDirection | null;
  invoiceId: string | null;
  method?: PaymentMethod | null;
  note?: string | null;
  ref?: string | null;
  occurredAt: string;
};

/**
 * #177 — one manual adjustment through the guarded store path. A null
 * `invoiceId` is account-only (touches no invoice); a non-null one links a
 * purchase invoice and the store applies its reduction in the same unit, so
 * the account entry and the invoice's remaining can never diverge.
 */
export type SupplierAdjustmentInsert = {
  supplierId: string;
  direction: SupplierAdjustmentDirection;
  amount: number;
  reason: string | null;
  occurredAt: string;
  invoiceId: string | null;
  ref?: string | null;
  /**
   * #177 — true when the router stamped `occurredAt` because the caller omitted
   * it. A retry then cannot be told apart by time, so the duplicate signature
   * ignores `occurredAt` (same supplier/direction/amount/reason/invoiceId at any
   * time is a duplicate). A caller that wants a genuinely distinct entry must
   * change the signature (direction/amount/reason/invoiceId, or a *different*
   * explicit `occurredAt`) and, when it sends a key, also a new key.
   */
  serverStamped?: boolean;
  /**
   * #181 — an explicit client idempotency key. When present it is the primary
   * dedup key (scoped to the supplier): a row with the same key is the same
   * logical request whatever its other fields. The #177 signature stays in force
   * as a backstop, so the key can only add refusals. When absent the signature
   * alone decides.
   */
  idempotencyKey?: string | null;
};

/** The idempotency key of a manual adjustment (#177 signature, or the #181
 * explicit client key), shared by the guarded write, the duplicate guard, and
 * the opening-balance confirmation so they can never disagree. */
export type SupplierAdjustmentSignature = Pick<
  SupplierAdjustmentInsert,
  "supplierId" | "direction" | "amount" | "reason" | "occurredAt" | "invoiceId" | "serverStamped" | "idempotencyKey"
>;

/** Typed refusal from the #177 supplier-adjustment guard. The router maps these
 * to stable ORPC errors; the store never throws a transport error. */
export class SupplierAdjustmentError extends Error {
  constructor(
    public readonly code:
      | "DUPLICATE"
      | "INVALID_AMOUNT"
      | "OUTSIDE_TRANSACTION"
      | "LINKED_DIRECTION"
      | "INVOICE_MISMATCH"
      | "EXCEEDS_REMAINING"
      | "LINKED_NEEDS_ATOMIC_PATH",
  ) {
    super(code);
    this.name = "SupplierAdjustmentError";
  }
}

export type SupplierReturnInsert = {
  returnNumber: string;
  supplierId: string;
  invoiceId: string | null;
  kind: "INVOICE_LINKED" | "FREE_STANDING";
  amount: number;
  debtReduction: number;
  credit: number;
  cashBack: number;
  reason: string | null;
  occurredAt: string;
};

export type SupplierReturnLineInsert = {
  returnId: string;
  invoiceLineId: string | null;
  itemId: string | null;
  description: string;
  quantity: number;
  unitCost: number;
  amount: number;
};

/** Typed refusal from the store's party identity rule (phone uniqueness or phone text). */
export class PartyError extends Error {
  constructor(public readonly code: "PHONE_EXISTS" | "INVALID_PHONE") {
    super(code);
    this.name = "PartyError";
  }
}

/** Hard-delete outcome; the delete rule allows only zero-invoice parties. */
export type PartyDeleteResult = "DELETED" | "HAS_INVOICES" | "NOT_FOUND";

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

  listItems(pagination?: PaginationInput): Promise<{ items: ItemListItem[]; total: number }>;
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

  /**
   * Party rules (issue 120). Customers and suppliers share one seam because
   * they share one code path (ADR-0007); `role` picks the table.
   */
  /** list + one aggregate per party (invoice count / total / paid / remaining) */
  listParties(role: PartyRole): Promise<PartyListItem[]>;
  /**
   * #183 — names-only party identity for name-conflict checks. Deliberately not
   * `listParties`: the check folds two names and nothing else, so it must not pay
   * for the list seam's invoice join, phone, or timestamps. Ordered by name, the
   * same order `listParties` uses.
   */
  listPartyNames(role: PartyRole): Promise<PartyName[]>;
  /**
   * #183 — the bulk opening-balance screen's supplier projection: the signed
   * account balance and entry count per supplier, read from
   * `supplier_account_entries` alone (no invoice join). Only suppliers that carry
   * an entry appear; the caller defaults a missing id to 0/0. Uses the same sign
   * expression as `listParties`/`supplierBalance`, so the two cannot disagree.
   */
  listSupplierAccountSummaries(): Promise<SupplierAccountSummary[]>;
  getParty(role: PartyRole, partyId: string): Promise<Party | undefined>;
  /** phone uniqueness when present; throws PartyError("PHONE_EXISTS") */
  createParty(role: PartyRole, input: PartyCreate): Promise<Party>;
  /** undefined when the party does not exist; same phone rule as create.
   * An empty patch is a no-op and returns the current party. */
  updateParty(role: PartyRole, partyId: string, patch: PartyUpdate): Promise<Party | undefined>;
  /** hard delete, allowed only at zero invoices (the delete rule) */
  deleteParty(role: PartyRole, partyId: string): Promise<PartyDeleteResult>;
  /** header + stats + every invoice + every payment, one call for the page */
  partyDetail(role: PartyRole, partyId: string): Promise<PartyDetail | undefined>;

  /**
   * Issue 174 — the party-detail TAB reads. `partyDetail` stays the full,
   * unpaginated read the settle/pay money distribution and the delete guard
   * need; only the tables page. `unpaidOnly` matches the customer tab's
   * `unpaidInvoices` (remaining > 0). The router always resolves concrete
   * pagination, so it is required here.
   */
  partyInvoices(role: PartyRole, partyId: string, filters: { unpaidOnly?: boolean }, pagination: PaginationInput): Promise<{ items: Invoice[]; total: number }>;
  /** the customer payments tab (a supplier's tab is `supplierEntries`) */
  partyPayments(partyId: string, pagination: PaginationInput): Promise<{ items: PartyPayment[]; total: number }>;

  // --- supplier account (issue 161) ----------------------------------------
  /** append-only signed entry; never updated or deleted. A linked ADJUSTMENT
   * (non-null invoiceId) is REFUSED here — it must go through
   * `insertSupplierAdjustment`, which applies the invoice reduction in the same
   * unit. An account-only ADJUSTMENT is still keyed with the #181 dedup key, so a
   * repeated one is refused by the partial unique index (there is no separate
   * in-process guard on this raw seam). */
  insertSupplierEntry(entry: SupplierEntryInsert): Promise<SupplierAccountEntry>;
  /**
   * #177 — the single guarded write path for a manual adjustment (تسوية). It
   * refuses a duplicate submission (the #181 explicit `idempotencyKey` is the
   * primary identity when the caller sent one, and the #177 signature stays a
   * backstop), refuses a linked entry signed the wrong way or one the invoice
   * cannot cover, and applies the linked invoice's reduction in the same unit as
   * the entry. Call inside a `withTransactionImmediate` unit so the entry and the
   * invoice's remaining can never diverge. Account-only (null invoiceId) never
   * touches an invoice. */
  insertSupplierAdjustment(input: SupplierAdjustmentInsert): Promise<SupplierAccountEntry>;
  /** True when an ADJUSTMENT with this key or signature already exists. Exposed
   * so the bulk opening-balance confirmation can tell an exact resend from a
   * genuinely new entry without duplicating the key. */
  hasSupplierAdjustment(input: SupplierAdjustmentSignature): Promise<boolean>;
  /** every entry of one supplier, newest first, invoice number joined */
  listSupplierEntries(supplierId: string): Promise<SupplierAccountEntry[]>;
  /** issue 174 — the account-entries tab: same select as `listSupplierEntries`,
   * sliced, with `total` the whole filtered count. The unpaginated read above
   * stays for the money paths (balance derivation). */
  supplierEntries(supplierId: string, pagination: PaginationInput): Promise<{ items: SupplierAccountEntry[]; total: number }>;
  /** outstanding PURCHASE invoices of one supplier, oldest first (allocation) */
  listOutstandingPurchaseInvoices(supplierId: string): Promise<Invoice[]>;
  allocateSupplierReturnNumber(): Promise<string>;
  insertSupplierReturn(input: SupplierReturnInsert): Promise<{ id: string }>;
  insertSupplierReturnLine(line: SupplierReturnLineInsert): Promise<void>;
  /** supplier purchase-return history, newest first; optional supplier scope */
  listSupplierReturns(filters: { supplierId?: string }, pagination?: PaginationInput): Promise<{ items: SupplierReturnRecord[]; total: number }>;
  getSupplierReturn(returnId: string): Promise<SupplierReturnRecord | undefined>;

  /** Runs an atomic unit; the callback receives the same store with the queue
   * bypassed for its own calls, so nested operations never deadlock and no
   * external call can ever land inside this transaction. */
  withTransaction<T>(fn: (tx: StorePort) => Promise<T>): Promise<T>;
  /** Like withTransaction but BEGIN IMMEDIATE — the write lock is taken before
   * the first read so money units never deadlock on a stale WAL read snapshot
   * (SQLITE_BUSY_SNAPSHOT) against a second process writing the same file.
   * Use for money-math units (payments); plain reads keep withTransaction. */
  withTransactionImmediate<T>(fn: (tx: StorePort) => Promise<T>): Promise<T>;
  /** Reserves the next invoice number for `kind` atomically in the database:
   * INV-%04d for a sale, SUP-%04d for a supplier purchase (#258). Each kind
   * owns its own counter, so one kind's documents never consume the other's
   * numbers. */
  allocateInvoiceNumber(kind: InvoiceKind): Promise<string>;
  /** Reserves the next return number (RET-%04d) atomically in the database. */
  allocateReturnNumber(): Promise<string>;
  insertReturn(input: ReturnInsert): Promise<{ id: string }>;
  insertReturnLine(line: ReturnLineInsert): Promise<void>;
  /** full return with lines; optional invoice scope. `total` is the count for
   * the filters, independent of the page. */
  listReturns(filters: { invoiceId?: string }, pagination?: PaginationInput): Promise<{ items: ReturnDetail[]; total: number }>;
  /** count of PENDING_REVIEW returns (issue 118); a SQL aggregate, never a list sum */
  pendingReturnsCount(): Promise<number>;
  getReturnDetail(returnId: string): Promise<ReturnDetail | undefined>;
  /** return header joined to its invoice identity (internal + diagnostics) */
  getReturnHeader(returnId: string): Promise<ReturnDetail | undefined>;
  /** authoritative review guard: true only when the return was still pending */
  transitionReturnStatus(returnId: string, to: "ACCEPTED" | "REJECTED_DAMAGED"): Promise<boolean>;
  /** per-line already-returned totals for this invoice (quantity for the cap,
   * refundAmount for the sequence-aware refund remainder) */
  returnedByLine(invoiceId: string): Promise<Map<string, { quantity: number; refundAmount: number }>>;
  /** per-line already-returned quantity of a PURCHASE invoice (supplier return cap) */
  returnedByPurchaseLine(invoiceId: string): Promise<Map<string, number>>;
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
  listInvoices(filters: InvoiceListFilters): Promise<{ items: Invoice[]; total: number }>;
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
  /** idempotently record the completed milestone once every record exists;
   * returns whether the milestone is (now) recorded. */
  recordOnboardingCompletion(): Promise<boolean>;

  insertActivity(activity: { type: ActivityType; summary: string; ref?: string | null }): Promise<void>;
  listActivities(pagination?: PaginationInput): Promise<{ items: Activity[]; total: number }>;
  /** true only when no shop record exists (seed rows and settings excluded).
   * The first-run provisioning gate uses this: a non-empty database with no
   * owner refuses to create one (ADR-0008 §4.1). */
  databaseIsEmpty(): Promise<boolean>;
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