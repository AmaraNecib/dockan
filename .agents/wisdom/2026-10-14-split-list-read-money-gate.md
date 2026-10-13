# Splitting one list read into two: the confirmation-gate hole and the import-time rpc trap

**Date:** 2026-10-14 · **Ticket:** 183 · **Area:** apps/web supplier-opening-balance, apps/api store seams

Follow-up to #176/#184. The opening-balance page stopped loading full party rows
(`listParties` / `suppliersList`) and read two lean seams instead: a names-only
list for the name-fold conflict check and a supplier account summary for the
balance/entry columns, merged by id. Two traps surfaced in review.

## 1. A partial read failure can silently disable a confirmation gate (🔴)

The old single read made `suppliers` empty on failure, so a filled batch looked
empty and the save was blocked. With two reads, `listError` was the OR, but the
Save button was not gated on it: when only the account summary failed, the merge
still produced rows with `accountEntryCount: 0`, `needsConfirmation` went false,
and the duplicate-opening-balance dialog was skipped. The names-only read
succeeding hid the failure.

**Always**: after splitting a read that feeds a write gate, block the write on
`isError` of *every* read, not just the primary one. Add a test that fails one
read while the other succeeds and asserts the save is disabled. Gate the
confirm-dialog button and the `save()` helper too, not only the outer submit —
round 2 of review found the dialog path still open after the first fix.

## 2. Do not touch the rpc surface at module load (🟠)

Deriving `[orpc.a.queryKey(), orpc.b.queryKey(), ...]` at module scope broke
`router.test.tsx`, which mocks a *subset* of `@/lib/rpc`: the page module is
imported when the route tree is built, so the missing key threw during import and
aborted the whole file (`undefined is not an object`). The full web suite went
from green to 2 file errors.

**Always**: build query-key lists inside the component (or a function), never at
module scope, so importing a page never depends on the mocked rpc surface being
complete. If a test file mocks `@/lib/rpc`, add the new keys there too.

## 3. A two-read merge owes the single read an equivalence test (🟡)

The merge defaulted a supplier absent from the summary to `0/0` — exactly the
supplier-only nulls/`COALESCE(...,0)` the old list produced. That equivalence is
the whole safety argument, so it is pinned: a store test asserts the summary
agrees with `listParties` for the same supplier, including a **net-zero** account
(balance 0, count 2), which is the case a `HAVING balance <> 0` regression would
silently drop.

**Always**: when replacing one read with two, test the merged value against the
old read for the boundary row (empty, net-zero, missing summary), not just the
happy path.
