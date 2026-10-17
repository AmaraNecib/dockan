import { normalizeTextKey } from "@dokan/contracts";

import { draftBlank, parseGroupedAmount } from "@/lib/amount-parse";

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
  if (draftBlank(raw)) return { status: "untouched" };
  const amount = parseGroupedAmount(raw);
  if (amount === null || amount <= 0) return { status: "invalid" };
  return { status: "filled", amount };
}

/**
 * #204 — a background refresh can remove a supplier whose draft the owner already
 * filled. Reconcile the drafts against the fresh id set here: a filled draft whose
 * supplier is gone is returned so the page can name the loss (and block the save
 * until acknowledged), while an untouched draft drops silently. The remembered
 * `name` is the identity the draft was typed against, so a vanished supplier can
 * still be named after it leaves the list.
 */
export type RemovedFilledDraft = { supplierId: string; name: string; amount: number };

export function droppedFilledDrafts(input: {
  drafts: Readonly<Record<string, { name?: string; amount: string }>>;
  presentSupplierIds: readonly string[];
}): RemovedFilledDraft[] {
  const present = new Set(input.presentSupplierIds);
  const dropped: RemovedFilledDraft[] = [];
  for (const [supplierId, draft] of Object.entries(input.drafts)) {
    if (present.has(supplierId)) continue;
    const status = openingRowStatus(draft);
    if (status.status !== "filled") continue;
    dropped.push({ supplierId, name: draft.name ?? "", amount: status.amount });
  }
  return dropped;
}

export type NewOpeningRowStatus =
  | { status: "untouched" }
  | { status: "incomplete" }
  | { status: "invalid" }
  // #255 — the name folds onto a supplier that already exists. Not an error: the
  // server resolves such a row onto that account, which is exactly what
  // `newSupplierName` means. It carries the parsed fields because the row is still
  // a usable outgoing row.
  | { status: "duplicate"; name: string; amount: number }
  | { status: "filled"; name: string; amount: number };

/** The inline new-supplier row: empty is untouched; a name XOR an amount is
 * incomplete; a bad amount is invalid; a name that folds to an existing
 * supplier is a duplicate; otherwise filled. */
export function newOpeningRowStatus(input: { name: string; amount: string; existingNames: readonly string[] }): NewOpeningRowStatus {
  const name = input.name.trim();
  // The name's IDENTITY is the fold key, not the raw string. Bidi/zero-width
  // controls (RLM U+200F, ALM U+061C, ...) are Unicode Cf, not whitespace, so
  // `trim()` keeps them while `normalizeTextKey` folds them to "". A name that
  // folds to "" names nobody: sending it made the api normalize the whole batch
  // to one empty key and refuse it (DUPLICATE_OPENING_BALANCE_ROW), losing every
  // amount in it (Greptile round 3 finding 2). Treat it exactly as an empty name.
  const folded = normalizeTextKey(name);
  const amountFilled = !draftBlank(input.amount);
  if (folded === "" && !amountFilled) return { status: "untouched" };
  if (folded === "" || !amountFilled) return { status: "incomplete" };
  const amount = parseGroupedAmount(input.amount);
  if (amount === null || amount <= 0) return { status: "invalid" };
  if (input.existingNames.some((existing) => normalizeTextKey(existing) === folded)) return { status: "duplicate", name, amount };
  return { status: "filled", name, amount };
}

/**
 * #255 — two typed (new-supplier) rows whose names fold to one key are one
 * supplier entered twice: the api refuses that batch outright
 * (`DUPLICATE_OPENING_BALANCE_ROW`), so every amount in it is lost at once. The
 * page blocks the same shape on the client, off this one predicate, so the
 * client and the server agree by construction on what "the same name" means
 * (`normalizeTextKey`, ADR-0007).
 *
 * A blank name carries no identity: blank and mark-only drafts all fold to `""`
 * and are NOT duplicates of each other. Such a row can no longer be a READY row
 * at all — `newOpeningRowStatus` refuses a name that folds to "" (Greptile round
 * 3 finding 2) — so the empty-key skip here is the last defence, keeping a
 * not-yet-filled row out of a duplicate report.
 * Every member of a clash is returned, not just the later one, because either
 * side is the row the owner can edit.
 */
export function duplicateTypedRowIds(rows: readonly { id: string; name: string }[]): string[] {
  const idsByKey = new Map<string, string[]>();
  for (const row of rows) {
    const key = normalizeTextKey(row.name);
    if (key === "") continue;
    const ids = idsByKey.get(key);
    if (ids === undefined) idsByKey.set(key, [row.id]);
    else ids.push(row.id);
  }
  return [...idsByKey.values()].flatMap((ids) => (ids.length > 1 ? ids : []));
}

/** The contract's row cap (`supplierOpeningBalancesInputSchema.rows.max(200)`). */
export const MAX_OPENING_BALANCE_ROWS = 200;

/** True when a batch of `totalRows` would exceed the contract cap. Exactly the
 * cap is allowed; only a larger batch is blocked. */
export function isOpeningBatchOverLimit(totalRows: number): boolean {
  return totalRows > MAX_OPENING_BALANCE_ROWS;
}
