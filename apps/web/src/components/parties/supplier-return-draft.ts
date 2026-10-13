import { parseWholeAmount } from "@/components/ui/amount-percentage-input";

/**
 * #161 — the pure half of the supplier-return form's draft validation. A draft
 * the owner typed must be REJECTED, never silently dropped: dropping an invalid
 * quantity would submit a different return than the preview promised.
 */

export interface ReturnLineDraft {
  invoiceLineId: string;
  quantity: number;
}

/**
 * Every NONEMPTY quantity draft must be a positive whole number; an empty draft
 * is an untouched line. Returns the parsed lines, or an error when a draft is
 * invalid or nothing was selected at all.
 */
export function parseReturnQuantities(
  quantities: Readonly<Record<string, string>>,
): { lines: ReturnLineDraft[] } | { error: true } {
  const lines: ReturnLineDraft[] = [];
  for (const [invoiceLineId, draft] of Object.entries(quantities)) {
    const trimmed = draft.trim();
    if (trimmed === "") continue;
    const quantity = parseWholeAmount(trimmed);
    if (quantity === null || quantity <= 0) return { error: true };
    lines.push({ invoiceLineId, quantity });
  }
  return lines.length === 0 ? { error: true } : { lines };
}

/**
 * The cash-back draft: empty means zero, otherwise a non-negative whole amount.
 * A malformed or negative draft returns null (an error), never a silent zero.
 */
export function parseCashBackDraft(draft: string): number | null {
  const trimmed = draft.trim();
  if (trimmed === "") return 0;
  return parseWholeAmount(trimmed);
}
