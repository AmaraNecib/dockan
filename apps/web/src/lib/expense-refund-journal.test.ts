import { describe, expect, it } from "bun:test";
import { clearExpenseRefundRequest, expenseRefundJournalKey, persistExpenseRefundRequest, readExpenseRefundRequest, type ExpenseRefundRequest } from "./expense-refund-journal";

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

  it("keeps a newer refund or compensation journal when an older reply finishes", () => {
    const storage = memoryStorage();
    const old: ExpenseRefundRequest = { kind: "refund", input: { expenseId, amount: 300, occurredAt: "2020-02-12T10:00:00", idempotencyKey: crypto.randomUUID() } };
    for (const newer of [
      { kind: "refund", input: { ...old.input, amount: 100, idempotencyKey: crypto.randomUUID() } },
      { kind: "undo", input: { refundId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() } },
    ] satisfies ExpenseRefundRequest[]) {
      const oldEntry = persistExpenseRefundRequest(storage, key, old);
      clearExpenseRefundRequest(storage, key, oldEntry);
      expect(storage.getItem(key)).toBeNull();
      const newerEntry = persistExpenseRefundRequest(storage, key, newer);
      // The original editor's success or definitive refusal arrives after a new scope retried A and began B.
      clearExpenseRefundRequest(storage, key, oldEntry);
      expect(readExpenseRefundRequest(storage, key, expenseId)).toEqual(newer);
      clearExpenseRefundRequest(storage, key, newerEntry);
      expect(storage.getItem(key)).toBeNull();
    }
  });

  it("isolates dispatch generations without changing the immutable retry payload", () => {
    const storage = memoryStorage();
    const request: ExpenseRefundRequest = { kind: "undo", input: { refundId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() } };
    const first = persistExpenseRefundRequest(storage, key, request);
    const retry = persistExpenseRefundRequest(storage, key, request);
    expect(first).not.toBe(retry);
    clearExpenseRefundRequest(storage, key, first);
    expect(readExpenseRefundRequest(storage, key, expenseId)).toEqual(request);
    clearExpenseRefundRequest(storage, key, retry);
    expect(storage.getItem(key)).toBeNull();
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
