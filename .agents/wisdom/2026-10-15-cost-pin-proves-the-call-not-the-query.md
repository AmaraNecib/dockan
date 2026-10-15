# A cost pin proves the call, not the query — pair it with a shape assertion (🟠 Major)

**Date:** 2026-10-15 · **Ticket:** 213 · **Area:** apps/api/src/rpc/router.ts, apps/api/src/store/

#213 swapped a heavy read for two lean ones inside `suppliersResolveName`:

```ts
// before
const candidates = (await deps.store.listParties("supplier")) ...
// after
const [names, summaries] = await Promise.all([
  deps.store.listPartyNames("supplier"),
  deps.store.listSupplierAccountSummaries(),
]);
```

The acceptance test "pin that the resolve path no longer calls `listParties`"
was satisfied with a counting `StorePort` plus a booby-trap that throws if
`listParties` is reached. That is necessary but not sufficient, and the
test-audit named the gap: **a call-count pin only proves one method name is
absent.** A regression that re-joins the invoice aggregate *inside* the lean
read — or a renamed aggregate seam — passes it unchanged. The suite would look
cheaper without being cheaper.

What actually closes the gap is a second, independent assertion at the seam that
owns the query: `drizzle-store.test.ts` pins `listPartyNames` to exactly
`{ id, name }` keys, so no aggregate field can ride along. Together they prove
the aggregate is gone.

**Always**: when a ticket's goal is "stop paying for query X", the test must
combine (a) the caller never reaches the old read, and (b) the replacement read
cannot carry X. If the repo forbids SQL assertions (this one does: "verified
through StorePort against sqlite, never SQL" in `drizzle-store.test.ts`), the
shape assertion is the substitute — do not add a `db.all` spy that violates the
stated testing decision.

Two smaller lessons from the same audit:

- **The two-read equivalence test owes the boundary row.** Replacing one read
  with two needs the same account/entry-count the old read produced; the row
  that breaks it is the **net-zero account** (count 2, balance 0), which a
  `HAVING balance <> 0` regression silently drops to 0 and thereby disables the
  confirmation gate. Pin the count, not the balance.
- **Do not pin `Promise.all` argument order.** `expect(reads).toEqual([a, b])`
  fails on a cost-neutral swap. Assert the read *set* (`length` + set equality)
  and the invariant (`listParties === 0`); the ordering is an implementation
  detail.
