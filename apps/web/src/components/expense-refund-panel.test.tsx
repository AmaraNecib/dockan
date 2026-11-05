import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { act } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ExpenseRefund, ExpenseRefundInput } from "@dokan/contracts";
import "../lib/i18n";
import { SessionCacheScopeProvider } from "../lib/session-query-scope";
import { expenseRefundJournalKey, readExpenseRefundRequest } from "../lib/expense-refund-journal";
import { mountWithProviders, unmountAllMountedPages } from "../tests/page-harness";

const expenseId = "87a6df8a-309e-433c-b5dd-044b92b9c361";
const actorId = "87a6df8a-309e-433c-b5dd-044b92b9c362";
const journalKey = expenseRefundJournalKey(actorId, expenseId);
let refunds: ExpenseRefund[] = [];
let inputs: ExpenseRefundInput[] = [];
let delayed: (input: ExpenseRefundInput) => Promise<ExpenseRefund>;

function saved(input: ExpenseRefundInput): ExpenseRefund {
  const existing = refunds.find((row) => row.reason === input.idempotencyKey);
  if (existing !== undefined) return existing;
  const row: ExpenseRefund = { id: crypto.randomUUID(), expenseId, difference: -input.amount, occurredAt: input.occurredAt, recordedAt: "2026-10-28T13:34:56", actorId, actorName: "Owner", reason: input.idempotencyKey, reversesRefundId: null };
  refunds.push(row);
  return row;
}

mock.module("../lib/rpc", () => ({ orpc: {
  expenseRefundHistory: { queryOptions: () => ({ queryKey: ["refund-history", expenseId], queryFn: async () => ({ requestActorId: actorId, refundableAmount: 1000 + refunds.reduce((sum, row) => sum + row.difference, 0), refunds: refunds.map((row) => ({ ...row, reversedByRefundId: null })) }) }) },
  expensesRefund: { mutationOptions: () => ({ mutationFn: (input: ExpenseRefundInput) => { inputs.push(input); return delayed(input); } }) },
  expensesRefundUndo: { mutationOptions: () => ({ mutationFn: async () => { throw new Error("unexpected compensation"); } }) },
} }));
const { ExpenseRefundPanel } = await import("./expense-refund-panel");

beforeEach(() => { refunds = []; inputs = []; sessionStorage.clear(); });
afterEach(async () => { await unmountAllMountedPages(); sessionStorage.clear(); });

for (const outcome of ["success", "definitive refusal"] as const) {
  it(`retains B across a scope change and reload when A's old ${outcome} arrives`, async () => {
    let finishA: (() => void) | undefined;
    let finishB: (() => void) | undefined;
    delayed = (input) => {
      const row = saved(input);
      if (inputs.length === 1) return new Promise((resolve, reject) => {
        finishA = () => outcome === "success" ? resolve(row) : reject(new Error("EXPENSE_REFUND_EXCEEDS_BALANCE"));
      });
      if (inputs.length === 3) return new Promise((resolve) => { finishB = () => resolve(row); });
      return Promise.resolve(row);
    };
    const page = await mountWithProviders(<SessionCacheScopeProvider scopeId="before-lock"><ExpenseRefundPanel expenseId={expenseId} /></SessionCacheScopeProvider>);
    expect(page.query("expense-refund-open")).not.toBeNull();
    const click = async (id: string) => act(async () => page.query<HTMLButtonElement>(id)?.click());
    const open = async () => {
      await click("expense-refund-open");
      await page.poll(() => page.query<HTMLButtonElement>("expense-refund-save")?.disabled === false, "refund editor ready");
    };
    const fill = async (amount: string) => act(async () => {
      const input = page.query<HTMLInputElement>("expense-refund-amount");
      expect(input).not.toBeNull();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, amount);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = async () => act(async () => { page.query<HTMLFormElement>("expense-refund-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    const remount = async (scopeId: string) => act(async () => {
      page.root.render(<QueryClientProvider client={page.queryClient}><SessionCacheScopeProvider scopeId={scopeId}><ExpenseRefundPanel key={scopeId} expenseId={expenseId} /></SessionCacheScopeProvider></QueryClientProvider>);
    });
    await open();
    await fill("300");
    await submit();
    await page.poll(() => inputs.length === 1, "original A pending");
    const originalA = inputs[0];
    expect(originalA).toMatchObject({ expenseId, amount: 300 });
    await remount("after-unlock");
    await open();
    await submit();
    await page.poll(() => inputs.length === 2 && page.query<HTMLButtonElement>("expense-refund-save")?.disabled === false, "retry A acknowledged");
    expect(inputs[1]).toEqual(originalA);
    await fill("100");
    await submit();
    await page.poll(() => inputs.length === 3, "B pending");
    const newB = inputs[2];
    if (newB === undefined) throw new Error("B was not dispatched");
    expect(newB).toMatchObject({ expenseId, amount: 100 });
    await act(async () => { finishA?.(); });
    expect(readExpenseRefundRequest(sessionStorage, journalKey, expenseId)).toEqual({ kind: "refund", input: newB });
    await remount("reloaded");
    await open();
    expect(page.query("expense-refund-uncertain")).not.toBeNull();
    await submit();
    await page.poll(() => inputs.length === 4 && sessionStorage.getItem(journalKey) === null, "B retry acknowledged");
    expect(inputs[3]).toEqual(newB);
    expect(refunds.map((row) => row.difference)).toEqual([-300, -100]);
    await act(async () => { finishB?.(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(sessionStorage.getItem(journalKey)).toBeNull();
  });
}
