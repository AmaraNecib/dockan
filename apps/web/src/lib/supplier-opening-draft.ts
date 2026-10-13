import { normalizeTextKey } from "@dokan/contracts";

import { parseGroupedAmount } from "@/lib/amount-parse";

/**
 * #176 — pure draft readers for the bulk opening-balance screen. They exist so
 * the row filter is testable without a DOM and so an invalid or incomplete
 * draft is BLOCKED rather than silently dropped (Greptile round 1: a "1,000"
 * amount was rejected and its row skipped, so the batch saved one amount short).
 *
 * #180 — the amount reader is the shared `parseGroupedAmount` (see
 * `@/lib/amount-parse`), the same one the single-entry money fields use, so a
 * grouped string can never mean two numbers.
 */

export type OpeningRowStatus =
  | { status: "untouched" }
  | { status: "invalid" }
  | { status: "filled"; amount: number };

/** One existing supplier's row: untouched when its amount is empty, invalid
 * when it carries a draft that is not a positive whole amount, filled
 * otherwise. */
export function openingRowStatus(draft: { amount: string } | undefined): OpeningRowStatus {
  const raw = draft?.amount ?? "";
  if (raw.trim() === "") return { status: "untouched" };
  const amount = parseGroupedAmount(raw);
  if (amount === null || amount <= 0) return { status: "invalid" };
  return { status: "filled", amount };
}

export type NewOpeningRowStatus =
  | { status: "untouched" }
  | { status: "incomplete" }
  | { status: "invalid" }
  | { status: "duplicate" }
  | { status: "filled"; name: string; amount: number };

/** The inline new-supplier row: empty is untouched; a name XOR an amount is
 * incomplete; a bad amount is invalid; a name that folds to an existing
 * supplier is a duplicate; otherwise filled. */
export function newOpeningRowStatus(input: { name: string; amount: string; existingNames: readonly string[] }): NewOpeningRowStatus {
  const name = input.name.trim();
  const amountFilled = input.amount.trim() !== "";
  if (name === "" && !amountFilled) return { status: "untouched" };
  if (name === "" || !amountFilled) return { status: "incomplete" };
  const amount = parseGroupedAmount(input.amount);
  if (amount === null || amount <= 0) return { status: "invalid" };
  const folded = normalizeTextKey(name);
  if (input.existingNames.some((existing) => normalizeTextKey(existing) === folded)) return { status: "duplicate" };
  return { status: "filled", name, amount };
}

/** The contract's row cap (`supplierOpeningBalancesInputSchema.rows.max(200)`). */
export const MAX_OPENING_BALANCE_ROWS = 200;

/** True when a batch of `totalRows` would exceed the contract cap. Exactly the
 * cap is allowed; only a larger batch is blocked. */
export function isOpeningBatchOverLimit(totalRows: number): boolean {
  return totalRows > MAX_OPENING_BALANCE_ROWS;
}
