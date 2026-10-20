# #317 — One rule decides what a supplier balance means

Base: `develop` @ `ae9e416a` (merge-base, fetched). Tier: High-assurance, because the
change decides the sign of money owed to a supplier.

## The two readers

`apps/api/src/lib/supplier-ledger.ts` folds a supplier's entries in TypeScript;
`apps/api/src/store/drizzle-store.ts` sums them in SQL for the list, the summaries, the
`/debts` groups and the dashboard. Before this ticket each carried its own hand-written
list of kinds and signs. They agreed on every row a store seam can write, and disagreed on
a row only a migrated database can hold: SQL signed a direction-less `ADJUSTMENT`
negative, the fold threw.

## Decision 1 — the table is the data, and both readers are derived from it

`SUPPLIER_ENTRY_RULES` holds one rule per kind: the sign a fixed kind always carries, or —
for `ADJUSTMENT` — the sign per direction plus the fact that a direction is required.
`SUPPLIER_ENTRY_KINDS` is derived from the table's keys and asserted equal to the
contracts' `supplierEntryKinds`, so a new kind fails on a diff that names it.

The store generates its SQL from the same table at module load: a `CASE` arm per rule plus
an `ELSE NULL`, and the aggregate every reader uses — `0` for an account with no rows, the
signed total when every row is signable, `NULL` when any row is not. Two fragments, one
per concern (the signable predicate and the signed amount), because folding them into one
`COUNT(signed)` expression was measured at +14.7% emitted size (600 → 688 characters) and
slower at every row count, and bought no property the two did not already have.

A row the table cannot sign therefore has one meaning in both readers: unknown kind, or a
direction-required kind with no usable direction. The fold throws; SQL returns `NULL`.

## Decision 2 — refuse, do not skip

A row that cannot be signed stops the read. Skipping is the silent-wrong-number failure
this ticket exists to kill: `/debts` would show a smaller debt than the account holds, and
the owner would pay the wrong amount believing the list. So every balance read refuses
together — the fold, the party list, the account summaries, both `/debts` arms and the
dashboard net — with one class, `UnsignableSupplierEntryError`.

Each refusal names only what its reader observed. The fold has the row, so it carries the
kind, the direction, the entry id and the supplier id. The SQL aggregate never surfaced a
row, so it carries the supplier id and nothing else; `kind` and `direction` stay absent and
the message says `(unread by this read)` rather than inventing a kind or claiming the row
carried no direction.

## Decision 3 — a typed RPC code, because the screen must say something useful

`SUPPLIER_ENTRY_UNSIGNABLE` (`apps/web/src/lib/i18n.ts`), carrying `supplierId`, `entryId`
and `kind` in `data`. Unmapped, the refusal reached the owner as the generic internal error
on a screen whose whole point is naming the broken account.

The mapping belongs at the procedure wrapper, not inside handlers, because the refusal is
raised by reads as well as writes — `guarded` / `guardedInput` translate it once, and
`SupplierAdjustmentError` moved there too so the router keeps one convention instead of two.
The original error is logged with its ids before the replacement is thrown, because
`app.ts` saves the replacement's stack and name and the replacement has no ids.

Two consequences landed with it. The Arabic copy names the supplier's ledger, not a
"movement mentioned in the log": `tError` renders `message` only, so the sentence is true
for every reader and the ids are for the diagnostics. And `/debts` checks `isError` before
`isPending || !data`, because `!data` is also true for a rejected query and the old order
showed loading placeholders forever.

## Tests

- `supplier-ledger.test.ts` — the sign per kind from the table, a direction-less
  `ADJUSTMENT` and an unknown kind refused as the typed class, and a direction named
  `toString` refused rather than answered from `Object.prototype`.
- `drizzle-store.test.ts` — one fixture row set folded through every reader and compared per
  kind, in total and per account; the same fixture plus a direction-less row and a
  non-`ADJUSTMENT` unknown kind, where every reader refuses (the direction-less row is
  inserted with `PRAGMA ignore_check_constraints`, standing in for a migrated database); and
  an account with no entries reading `0` rather than a refusal.
- `router.test.ts` — the refusal reaching the wire as `SUPPLIER_ENTRY_UNSIGNABLE` for a read
  and for a write that folds, the write's unit rolled back, and the ids present in the saved
  diagnostics.
- `apps/web/src/pages/debts.test.tsx` — a rejected read renders the refusal, not skeletons.

## Risks

A corrupt supplier entry now blanks the supplier list, `/debts` and the dashboard instead of
showing a guessed number. Intentional. The blank screens name the account in the log, which
is the data the fix needs; they do not name it on the screen, because the payload that
reaches `tError` is the stable key alone.
