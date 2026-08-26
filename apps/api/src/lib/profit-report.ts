import type { Expense, ExpenseCategory, ExpenseCategoryTotal, ProfitReport, ReportRangePreset } from "@dokan/contracts";

/**
 * Profit report math (ticket 31). Pure whole-DZD integer sums over RAW
 * records — SALE invoice lines (persisted netTotal/costAtSale snapshots from
 * ticket #30) and append-only expense rows. Nothing here reads the database
 * and nothing stores a precomputed total: formulas change without touching
 * history (backward compatibility), because the report is recomputed from
 * immutable facts every time.
 *
 * Accrual semantics: revenue/COGS belong to the invoice's business date
 * (invoiceDate), expenses to their occurredAt. Unpaid sales are still revenue;
 * cash/paid/remaining amounts stay debt territory (#8/#9).
 */

export interface ProfitSaleLine {
  invoiceId: string;
  /** business date "YYYY-MM-DD" (Algeria local) of the SALE invoice */
  invoiceDate: string;
  quantity: number;
  /** per-unit FIFO cost snapshot (ADR-0005), whole DZD */
  costAtSale: number;
  /** exact total COGS of the layers this line consumed (unrounded FIFO sum) */
  cogsExact: number;
  /** line revenue after its allocated share of the invoice discount */
  netTotal: number;
}

/** The raw expense facts the report sums (a subset of the stored row). */
export interface ProfitExpense {
  categoryId: string;
  amount: number;
  occurredAt: string;
}

export interface ProfitReportRange {
  preset: ReportRangePreset;
  from: string;
  to: string;
}

export type { ExpenseCategoryTotal };

/** True when a full local datetime lies inside the inclusive window. */
function datetimeInRange(moment: string, range: ProfitReportRange): boolean {
  return moment >= range.from && moment <= range.to;
}

/** True when a date-only field lies inside the window (day-level granularity
 * is the resolution of invoiceDate; custom mid-day bounds include the whole
 * boundary days). */
function dateInRange(date: string, range: ProfitReportRange): boolean {
  return date >= range.from.slice(0, 10) && date <= range.to.slice(0, 10);
}

/**
 * Compute the full profit report for one window. Every figure is derived at
 * read time; the only "totals" produced are the sums below.
 *
 * - revenue = Σ line.netTotal over SALE lines in range (#30 allocation makes
 *   Σ netTotal ≡ invoice.totalAmount, so discounts already reduce revenue)
 * - cogs = Σ line.cogsExact (exact per-line layer sum, not the rounded
 *   quantity × costAtSale product — see docs/adr/0005 for the drift)
 * - operatingExpenses = Σ expenses in range except owner-withdrawal categories
 * - ownerWithdrawals = Σ expenses in range flagged as owner withdrawals
 * - result = grossProfit − operatingExpenses − ownerWithdrawals
 * - byCategory reconciles exactly to the expense lines above
 */
export function computeProfitReport(input: {
  saleLines: readonly ProfitSaleLine[];
  expenses: readonly ProfitExpense[];
  categories: readonly ExpenseCategory[];
  range: ProfitReportRange;
}): ProfitReport {
  const { saleLines, expenses, categories, range } = input;
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  let revenue = 0;
  let cogs = 0;
  for (const line of saleLines) {
    if (!dateInRange(line.invoiceDate, range)) continue;
    // SAFETY: money is whole DZD integers from the persisted line snapshots;
    // revenue sums netTotal and cogs sums cogsExact — both safe integers at
    // realistic shop volumes
    revenue += line.netTotal;
    cogs += line.cogsExact;
  }

  const buckets = new Map<string, { total: number; count: number }>();
  let operatingExpenses = 0;
  let ownerWithdrawals = 0;
  for (const entry of expenses) {
    if (!datetimeInRange(entry.occurredAt, range)) continue;
    if (categoryById.get(entry.categoryId)?.isOwnerWithdrawal === true) {
      ownerWithdrawals += entry.amount;
      continue;
    }
    operatingExpenses += entry.amount;
    const bucket = buckets.get(entry.categoryId) ?? { total: 0, count: 0 };
    bucket.total += entry.amount;
    bucket.count += 1;
    buckets.set(entry.categoryId, bucket);
  }

  // operating categories alphabetically first, then owner-withdrawal
  // categories; the final array is re-sorted once after the withdrawal rows
  // are appended so the order never depends on two separate sort passes
  const byCategory: ExpenseCategoryTotal[] = [...buckets.entries()]
    .map(([categoryId, bucket]) => {
      const category = categoryById.get(categoryId);
      return {
        categoryId,
        categoryName: category?.name ?? "—",
        isOwnerWithdrawal: category?.isOwnerWithdrawal === true,
        total: bucket.total,
        count: bucket.count,
      };
    })
    .sort((a, b) => Number(a.isOwnerWithdrawal) - Number(b.isOwnerWithdrawal) || a.categoryName.localeCompare(b.categoryName));

  // flagged withdrawal categories with money spent inside the window belong in
  // the traceable breakdown too (the report's ownerWithdrawals line is their sum)
  for (const category of categories) {
    if (category.isOwnerWithdrawal !== true) continue;
    let total = 0;
    let count = 0;
    for (const entry of expenses) {
      if (entry.categoryId !== category.id || !datetimeInRange(entry.occurredAt, range)) continue;
      total += entry.amount;
      count += 1;
    }
    if (total > 0) byCategory.push({ categoryId: category.id, categoryName: category.name, isOwnerWithdrawal: true, total, count });
  }
  // SAFETY: the appended rows are name-members of the same contract shape, so
  // re-sorting the whole array once keeps one canonical order in all cases
  byCategory.sort((a, b) => Number(a.isOwnerWithdrawal) - Number(b.isOwnerWithdrawal) || a.categoryName.localeCompare(b.categoryName));

  const grossProfit = revenue - cogs;
  const resultAfterExpenses = grossProfit - operatingExpenses - ownerWithdrawals;
  return {
    range,
    revenue,
    cogs,
    grossProfit,
    operatingExpenses,
    ownerWithdrawals,
    resultAfterExpenses,
    byCategory,
  };
}

/** Immutable sort for expense history: occurredAt (newest first by default) or
 * amount, each asc/desc. Fully deterministic from row data alone: equal sort
 * keys break on occurredAt (newest first), then createdAt (insertion order),
 * so history order never depends on unspecified database row order. */
export function sortExpenses(
  expenses: readonly Expense[],
  sortBy: "occurredAt" | "amount" = "occurredAt",
  sortDir: "asc" | "desc" = "desc",
): Expense[] {
  const direction = sortDir === "asc" ? 1 : -1;
  return expenses
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      if (sortBy === "amount") {
        if (a.entry.amount !== b.entry.amount) return (a.entry.amount - b.entry.amount) * direction;
        if (a.entry.occurredAt !== b.entry.occurredAt) return a.entry.occurredAt < b.entry.occurredAt ? 1 : -1;
        if (a.entry.createdAt !== b.entry.createdAt) return a.entry.createdAt < b.entry.createdAt ? 1 : -1;
        return a.index - b.index;
      }
      if (a.entry.occurredAt !== b.entry.occurredAt) {
        return (a.entry.occurredAt < b.entry.occurredAt ? -1 : 1) * direction;
      }
      if (a.entry.createdAt !== b.entry.createdAt) return a.entry.createdAt < b.entry.createdAt ? 1 : -1;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}