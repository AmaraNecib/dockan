import { describe, expect, it } from "bun:test";

import type { Expense, ExpenseCategory } from "@dokan/contracts";

import { computeProfitReport, sortExpenses } from "./profit-report";

/**
 * Profit math is whole-DZD integer arithmetic over RAW records (SALE invoice
 * lines + expense rows). Every figure on the report must reconcile exactly:
 * result = revenue − COGS − operatingExpenses − ownerWithdrawals, with the
 * category breakdown summing back to the expense lines.
 */

const opCategory: ExpenseCategory = {
  id: "cat-rent",
  name: "كراء",
  isOwnerWithdrawal: false,
  createdAt: "2026-01-01T00:00:00",
  updatedAt: "2026-01-01T00:00:00",
};
const withdrawalCategory: ExpenseCategory = {
  id: "cat-withdraw",
  name: "سحوبات المالك",
  isOwnerWithdrawal: true,
  createdAt: "2026-01-01T00:00:00",
  updatedAt: "2026-01-01T00:00:00",
};

const range = { preset: "CURRENT_MONTH" as const, from: "2026-02-01T00:00:00", to: "2026-02-28T23:59:59" };

function expense(partial: Partial<Expense> & { categoryId: string; amount: number }): Expense {
  return {
    id: "exp-" + partial.categoryId + "-" + partial.amount,
    categoryId: partial.categoryId,
    amount: partial.amount,
    note: partial.note ?? null,
    occurredAt: partial.occurredAt ?? "2026-02-10T12:00:00",
    createdAt: partial.createdAt ?? "2026-02-10T12:00:00",
  };
}

describe("profit report — reconciliation on a worked example", () => {
  it("revenue − COGS − expenses = result, with category totals summing exactly", () => {
    // Sales in range: 3 × 1000 (100-DZD discount) and 2 × 1500, no discount.
    // Revenue = netTotals 2900 + 3000 = 5900; COGS = 3×400 + 2×700 = 2600.
    const saleLines = [
      { invoiceId: "inv-1", invoiceDate: "2026-02-05", quantity: 3, costAtSale: 400, netTotal: 2_900 },
      { invoiceId: "inv-2", invoiceDate: "2026-02-20", quantity: 2, costAtSale: 700, netTotal: 3_000 },
    ];
    // Expenses in range: rent 500 + electricity 200 operating, 300 withdrawal.
    const expenses = [
      expense({ categoryId: opCategory.id, amount: 500, occurredAt: "2026-02-01T09:00:00" }),
      expense({ categoryId: opCategory.id, amount: 200, occurredAt: "2026-02-15T18:00:00" }),
      expense({ categoryId: withdrawalCategory.id, amount: 300, occurredAt: "2026-02-25T20:00:00" }),
    ];
    const report = computeProfitReport({ saleLines, expenses, categories: [opCategory, withdrawalCategory], range });

    expect(report.range).toEqual(range);
    expect(report.revenue).toBe(5_900);
    expect(report.cogs).toBe(2_600);
    expect(report.grossProfit).toBe(3_300);
    expect(report.operatingExpenses).toBe(700);
    expect(report.ownerWithdrawals).toBe(300);
    expect(report.resultAfterExpenses).toBe(2_300); // 5900 − 2600 − 700 − 300
    // the acceptance identity: revenue − COGS − expenses = reported result
    expect(report.revenue - report.cogs - report.operatingExpenses - report.ownerWithdrawals).toBe(report.resultAfterExpenses);

    const byCategory = report.byCategory;
    expect(byCategory).toHaveLength(2);
    expect(byCategory.find((row) => row.categoryId === opCategory.id)).toMatchObject({
      categoryName: "كراء",
      isOwnerWithdrawal: false,
      total: 700,
      count: 2,
    });
    expect(byCategory.find((row) => row.categoryId === withdrawalCategory.id)).toMatchObject({
      categoryName: "سحوبات المالك",
      isOwnerWithdrawal: true,
      total: 300,
      count: 1,
    });
    // breakdown sums reconcile to the expense lines
    expect(byCategory.reduce((sum, row) => sum + row.total, 0)).toBe(report.operatingExpenses + report.ownerWithdrawals);
  });

  it("rejects a report that would not reconcile (guard against future drift)", () => {
    const report = computeProfitReport({
      saleLines: [{ invoiceId: "inv-1", invoiceDate: "2026-02-05", quantity: 1, costAtSale: 100, netTotal: 250 }],
      expenses: [],
      categories: [opCategory],
      range,
    });
    expect(report.revenue).toBe(250);
    expect(report.cogs).toBe(100);
    expect(report.grossProfit).toBe(150);
    expect(report.revenue - report.cogs - report.operatingExpenses - report.ownerWithdrawals).toBe(report.resultAfterExpenses);
    expect(report.byCategory).toHaveLength(0);
  });
});

describe("profit report — range slicing", () => {
  it("excludes invoices and expenses outside the window", () => {
    const report = computeProfitReport({
      saleLines: [
        { invoiceId: "in", invoiceDate: "2026-03-01", quantity: 1, costAtSale: 100, netTotal: 200 }, // next month
        { invoiceId: "in", invoiceDate: "2026-02-01", quantity: 1, costAtSale: 100, netTotal: 200 }, // first day
        { invoiceId: "in", invoiceDate: "2026-02-28", quantity: 1, costAtSale: 100, netTotal: 200 }, // last day
      ],
      expenses: [
        expense({ categoryId: opCategory.id, amount: 999, occurredAt: "2026-01-31T23:59:59" }), // just before
        expense({ categoryId: opCategory.id, amount: 100, occurredAt: "2026-02-01T00:00:00" }), // exactly from
        expense({ categoryId: opCategory.id, amount: 100, occurredAt: "2026-02-28T23:59:59" }), // exactly to
      ],
      categories: [opCategory],
      range,
    });
    expect(report.revenue).toBe(400);
    expect(report.cogs).toBe(200);
    expect(report.operatingExpenses).toBe(200);
  });
});

describe("COGS vs expenses separation", () => {
  it("a SALE invoice contributes revenue/COGS only; an expense contributes nothing to COGS", () => {
    // A purchase invoice never appears in the report at all.
    const report = computeProfitReport({
      saleLines: [{ invoiceId: "sale-1", invoiceDate: "2026-02-10", quantity: 4, costAtSale: 150, netTotal: 1_000 }],
      expenses: [expense({ categoryId: opCategory.id, amount: 700 })],
      categories: [opCategory],
      range,
    });
    expect(report.revenue).toBe(1_000);
    expect(report.cogs).toBe(600); // 4 × 150
    expect(report.operatingExpenses).toBe(700);
    expect(report.grossProfit).toBe(400);
    // COGS and expenses are independent numbers over different record sets
    expect(report.cogs).not.toBe(report.operatingExpenses + report.ownerWithdrawals);
  });

  it("revenue is derived from post-discount netTotals (discounts shrink profit, not COGS)", () => {
    const report = computeProfitReport({
      saleLines: [
        { invoiceId: "a", invoiceDate: "2026-02-10", quantity: 3, costAtSale: 400, netTotal: 2_900 }, // 100 discount
      ],
      expenses: [],
      categories: [opCategory],
      range,
    });
    expect(report.revenue).toBe(2_900);
    expect(report.cogs).toBe(1_200);
    expect(report.grossProfit).toBe(1_700); // discount already reduced revenue
    expect(report.resultAfterExpenses).toBe(1_700);
  });
});

describe("profit report — withdrawals and orphan categories", () => {
  it("an owner-withdrawal expense shows under ownerWithdrawals, never operatingExpenses", () => {
    const report = computeProfitReport({
      saleLines: [],
      expenses: [expense({ categoryId: withdrawalCategory.id, amount: 5_000 })],
      categories: [opCategory, withdrawalCategory],
      range,
    });
    expect(report.operatingExpenses).toBe(0);
    expect(report.ownerWithdrawals).toBe(5_000);
    expect(report.resultAfterExpenses).toBe(-5_000);
    expect(report.byCategory[0]).toMatchObject({ isOwnerWithdrawal: true, total: 5_000 });
  });

  it("an orphan expense (unknown category) still counts as operating with a placeholder name", () => {
    const report = computeProfitReport({
      saleLines: [],
      expenses: [expense({ categoryId: "cat-gone", amount: 250 })],
      categories: [opCategory],
      range,
    });
    expect(report.operatingExpenses).toBe(250);
    expect(report.ownerWithdrawals).toBe(0);
    expect(report.byCategory[0]).toMatchObject({ categoryId: "cat-gone", total: 250, count: 1 });
  });

  it("empty window yields zeros and an empty breakdown", () => {
    const report = computeProfitReport({ saleLines: [], expenses: [], categories: [], range });
    expect(report).toMatchObject({
      revenue: 0,
      cogs: 0,
      grossProfit: 0,
      operatingExpenses: 0,
      ownerWithdrawals: 0,
      resultAfterExpenses: 0,
    });
    expect(report.byCategory).toEqual([]);
  });
});

describe("sortExpenses", () => {
  const base = expense({ categoryId: opCategory.id, amount: 100, occurredAt: "2026-02-10T12:00:00" });
  const earlier = expense({ categoryId: opCategory.id, amount: 50, occurredAt: "2026-02-01T12:00:00" });
  const later = expense({ categoryId: opCategory.id, amount: 900, occurredAt: "2026-02-20T12:00:00" });
  const rows = [base, later, earlier];

  it("defaults to newest-first by occurredAt", () => {
    expect(sortExpenses(rows).map((row) => row.occurredAt)).toEqual(["2026-02-20T12:00:00", "2026-02-10T12:00:00", "2026-02-01T12:00:00"]);
  });

  it("sorts by date both directions", () => {
    expect(sortExpenses(rows, "occurredAt", "asc").map((row) => row.amount)).toEqual([50, 100, 900]);
    expect(sortExpenses(rows, "occurredAt", "desc").map((row) => row.amount)).toEqual([900, 100, 50]);
  });

  it("sorts by amount both directions, date descending as the tiebreak", () => {
    const tieA = expense({ categoryId: opCategory.id, amount: 100, occurredAt: "2026-02-05T12:00:00" });
    const tieB = expense({ categoryId: opCategory.id, amount: 100, occurredAt: "2026-02-15T12:00:00" });
    const mixed = [base, tieB, earlier, tieA, later];
    expect(sortExpenses(mixed, "amount", "asc").map((row) => row.amount)).toEqual([50, 100, 100, 100, 900]);
    // equal amounts: the later date wins (descending date tiebreak) for both directions
    expect(sortExpenses(mixed, "amount", "asc").slice(1, 4).map((row) => row.occurredAt)).toEqual(["2026-02-15T12:00:00", "2026-02-10T12:00:00", "2026-02-05T12:00:00"]);
    expect(sortExpenses(mixed, "amount", "desc").slice(1, 4).map((row) => row.occurredAt)).toEqual(["2026-02-15T12:00:00", "2026-02-10T12:00:00", "2026-02-05T12:00:00"]);
  });

  it("does not mutate its input", () => {
    const copy = [...rows];
    sortExpenses(rows);
    expect(rows).toEqual(copy);
  });
});