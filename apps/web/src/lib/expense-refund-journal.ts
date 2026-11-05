import { z } from "zod";
import { expenseRefundInputSchema, expenseRefundUndoInputSchema, type ExpenseRefundInput, type ExpenseRefundUndoInput } from "@dokan/contracts";

export type ExpenseRefundRequest = { kind: "refund"; input: ExpenseRefundInput } | { kind: "undo"; input: ExpenseRefundUndoInput };

/** Tab-local recovery survives reload without retaining money data after tab closure.
 * Origin, authenticated actor and immutable expense UUID isolate the journal. */
export function expenseRefundJournalKey(actorId: string, expenseId: string): string {
  return JSON.stringify(["expense-refund-pending", actorId, expenseId]);
}

const requestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("refund"), input: expenseRefundInputSchema }),
  z.object({ kind: z.literal("undo"), input: expenseRefundUndoInputSchema }),
]);

export function readExpenseRefundRequest(storage: Storage, key: string, expenseId: string): ExpenseRefundRequest | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const request = requestSchema.parse(JSON.parse(raw));
  if (request.kind === "refund" && request.input.expenseId !== expenseId) throw new Error("refund journal expense mismatch");
  return request;
}
