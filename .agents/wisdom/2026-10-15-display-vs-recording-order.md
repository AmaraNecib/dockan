# Wisdom: display order vs ledger recording order (issue 151)

## A date-ordered view cannot infer replay precedence from dates (🟠 Major)

Issue #151: the item history is drawn in business-date order
(`listStockMovements` orders by `occurredAt, rowid`), but weighted-average
replay splits the ledger by **recording order** (`seq`) at each cost
correction. A future-dated purchase recorded *before* a correction therefore
draws *below* it, so the owner reads it as "a purchase that did not move the
average" when the correction actually overwrote what it produced.

The display fix must not reorder rows (that would sacrifice the ordinary
date-ordered case) and must not touch the money path. The version that shipped
annotates the rows the correction supersedes, keyed on `createdAt`:

```ts
row.createdAt < correction.createdAt && correction drawn above row
```

**Always**: when a view must explain replay precedence but the contract only
carries business dates, check whether the row's insert timestamp (`createdAt`)
exposes recording order before reaching for `seq`. `createdAt` is fixed-width
`YYYY-MM-DDTHH:mm:ss`, so the compare is lexical and total. Two limits are
inherent and must be documented, not hidden:

- **same-second tie** — use strict `>` and leave the row unannotated rather
  than guess; in e2e, wait out the second boundary before the second insert;
- **page-local** — the predicate sees only the returned page, so a correction on
  a prior page cannot badge a superseded row on a later page. Fixing that needs
  `seq` (or the governing correction) on the wire, which a display-only ticket
  forbids.

Under-annotate, never over-annotate: a false positive would claim a number was
replaced when it was not, which is worse than silence in an audit trail.

## e2e seeding over the authenticated RPC wire needs its own typed envelope (🟡 Minor)

The local `rpc<T>(page, {procedure,input})` helper now exists in three specs
(`pagination`, `supplier-adjustment`, `stock-ledger`). Anti-slop
`no-unknown-parameters` rejects `json: unknown`, so each copy declares a named
`SeedRequest` union. Extracting one `seedRpc` into `tests/e2e/rpc-helpers.ts`
would keep the envelope in one place — a worthwhile follow-up, not a per-ticket
fix.
