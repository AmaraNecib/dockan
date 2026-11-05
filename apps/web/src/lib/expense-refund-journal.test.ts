import { describe, expect, it } from "bun:test";
import { expenseRefundJournalKey, readExpenseRefundRequest, type ExpenseRefundRequest } from "./expense-refund-journal";

const expenseId = "87a6df8a-309e-433c-b5dd-044b92b9c361";
const key = expenseRefundJournalKey("actor-1", expenseId);

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() { return entries.size; },
    clear() { entries.clear(); },
    getItem(name) { return entries.get(name) ?? null; },
    key(index) { return [...entries.keys()][index] ?? null; },
    removeItem(name) { entries.delete(name); },
    setItem(name, value) { entries.set(name, value); },
  };
}

describe("expense refund reload journal", () => {
  it("restores exact refund and compensation payloads; clears only acknowledged identity", () => {
    const storage = memoryStorage();
    const requests: ExpenseRefundRequest[] = [
      { kind: "refund", input: { expenseId, amount: 300, occurredAt: "2020-02-12T10:00:00", reason: "cash", idempotencyKey: crypto.randomUUID() } },
      { kind: "undo", input: { refundId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() } },
    ];
    for (const request of requests) {
      storage.setItem(key, JSON.stringify(request));
      expect(readExpenseRefundRequest(storage, key, expenseId)).toEqual(request);
      expect(readExpenseRefundRequest(storage, expenseRefundJournalKey("actor-2", expenseId), expenseId)).toBeNull();
      storage.removeItem(key);
      expect(readExpenseRefundRequest(storage, key, expenseId)).toBeNull();
    }
    expect(expenseRefundJournalKey("actor-1", expenseId)).not.toBe(expenseRefundJournalKey("actor-1", "other-expense"));
  });

  it("fails closed on corrupt, wrong-expense, invalid and inaccessible journals", () => {
    const storage = memoryStorage();
    for (const raw of ["invalid json", "{}", JSON.stringify({ kind: "refund", input: { expenseId: crypto.randomUUID(), amount: 300, occurredAt: "2020-02-12T10:00:00", idempotencyKey: crypto.randomUUID() } }), JSON.stringify({ kind: "undo", input: {} })]) {
      storage.setItem(key, raw);
      expect(() => readExpenseRefundRequest(storage, key, expenseId)).toThrow();
    }
    storage.getItem = () => { throw new Error("storage denied"); };
    expect(() => readExpenseRefundRequest(storage, key, expenseId)).toThrow("storage denied");
  });
});
