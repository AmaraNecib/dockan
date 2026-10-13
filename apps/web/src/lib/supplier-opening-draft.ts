import { normalizeTextKey } from "@dokan/contracts";

import { parseWholeAmount } from "@/components/ui/amount-percentage-input";

/**
 * #176 — pure draft readers for the bulk opening-balance screen. They exist so
 * the row filter is testable without a DOM and so an invalid or incomplete
 * draft is BLOCKED rather than silently dropped (Greptile round 1: a "1,000"
 * amount was rejected and its row skipped, so the batch saved one amount short).
 */

/** Thousands separators the owner may type between valid 3-digit groups
 * (comma, whitespace, Arabic thousands separator, non-breaking space). */
const STRIP_GROUPING = /[,\s\u066C\u00A0]/gu;
const ARABIC_INDIC_DIGITS = /[\u0660-\u0669]/gu;
const EXTENDED_ARABIC_INDIC_DIGITS = /[\u06F0-\u06F9]/gu;

/**
 * A whole-DZD draft. Accepts plain digits and VALID thousands grouping
 * (`1 000`, `1,000`, `٢٥٬٠٠٠`) plus Arabic-Indic digits. A decimal or a
 * malformed separators draft (`1 000,00`, `1,5`, `1 00`, `1,0000`) is REJECTED
 * instead of deleting the separator and returning a different number
 * (Greptile round 2: `1 000,00` used to parse as 100000 — a silent 100×).
 */
export function parseBulkAmount(draft: string): number | null {
  const normalized = draft
    .replace(ARABIC_INDIC_DIGITS, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC_DIGITS, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .trim();
  if (normalized === "") return null;
  // valid grouping: an optional 1-3 digit lead, then groups of exactly 3
  const plain = /^\d+$/u.test(normalized);
  const grouped = /^\d{1,3}(?:[,\s\u066C\u00A0]\d{3})+$/u.test(normalized);
  if (!plain && !grouped) return null;
  return parseWholeAmount(normalized.replace(STRIP_GROUPING, ""));
}

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
  const amount = parseBulkAmount(raw);
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
  const amount = parseBulkAmount(input.amount);
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
