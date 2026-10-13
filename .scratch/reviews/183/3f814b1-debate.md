# #183 — debate evidence

- **Issue:** #183 — Names-only supplier lookup for the opening-balance conflict check
- **Tier:** Standard (read path feeding a money screen; debate run because the brief mandates it)
- **Base:** `origin/develop` @ `da44b502d39c79a1368e9848542d9a25fac301fc`
- **Head:** `3f814b13fdb96fd0578b3151804b6b55ad095e1f` (see `git rev-parse HEAD`)
- **Critic/defender rounds:** `f590c32` (round 1), `45ae313` (round 2), `2594889` (round 3)
- **Verdict:** no blockers; every finding fixed or dismissed with a reason.

## What was reviewed

`git diff da44b50...HEAD`. The opening-balance page stops loading the full party
list (`store.listParties` / `suppliersList`) and reads two lean seams instead:
`suppliersListNames` (`store.listPartyNames`, `{id,name}`) for the name-fold
conflict check, and `suppliersAccountSummaries`
(`store.listSupplierAccountSummaries`, `{id,accountBalance,accountEntryCount}`)
for the balance/entry columns. The page merges them by id.

## Round 1 — critic findings and disposition

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | 7 | A failed `suppliersAccountSummaries` read left rows with `accountEntryCount: 0`, so `needsConfirmation` was false and Save stayed enabled — the confirmation gate could be skipped. | **Fixed** `45ae313`: `listFailed` blocks `submit` and the Save button. Test added. |
| 2 | 4 | Two endpoints + 4 schemas + a client merge where one lean projection would do. | **Dismissed**: the issue requires a names-only lookup for the conflict check; the survivor balance/entry columns are a different concern. Documented in the design. |
| 3 | 3 | Names and counts come from two snapshots (torn read). | **Accepted risk**: `OPENING_BALANCE_EXISTS` is the server backstop; the failed-read branch is closed by fix 1. Documented. |
| 4 | 2 | `orpc.suppliersList.queryKey()` was no longer invalidated while `parties.tsx`/`party-picker.tsx` still read it. | **Fixed** `45ae313`: re-added on success and refusal paths. |
| 5 | 1 | `partyNameSchema.name` was looser than `partySchema.name`. | **Fixed** `2594889`: `partyNameSchema = partySchema.pick({ id, name })`. |

Critic verified (a) the duplicate-name guard, fold detection and confirmation gate
are all still fed, (b) behaviour against `git show da44b50:.../supplier-opening-balance.tsx`,
and (c) the account summary uses the one `supplierSignedAmountSql` sign expression.

## Round 2 — critic findings and disposition

Round-1 fixes confirmed. One residual survived and was picked up by all five reviewers:

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | 4 | The confirm-dialog button and `save()` still bypassed `listFailed`. | **Fixed** `2594889`: `save()` returns early and the confirm button is disabled on `listFailed`. Test added. |
| 2 | 3 | Third unscoped supplier seam grows with supplier count. | **Dismissed**: bounded by the same screen the issue targets; the alternative re-introduces balances onto the conflict-check seam. |
| 3 | 2 | Error path blanks a table that has cached data. | **Accepted**: matches the pre-existing list-error behaviour; the save is blocked, which is the money-safe direction. |
| 6 | 1 | The 3-key invalidation array was duplicated. | **Fixed** `d7e1663`: one `supplierReadQueryKeys` list. |

## Round 3 — verification

- All six fixes present and correct (`supplier-opening-balance.tsx` `listFailed`
  at `submit`/`save`/both buttons; invalidation on success and refusal; contract
  `.pick`; tightened `matchByNormalizedName`).
- New-code money-path risk scored 2/10; no path found where error state skips
  confirmation while a save is submitted.
- Residual notes (not blockers): `submit()` on a failed read returns silently
  (the error is already rendered by the form); the two reads are not one
  snapshot; the dialog-gate test asserts the disabled attribute rather than the
  defensive `save()` guard.

## Post-review commits

- `d7e1663` — invalidation-array dedup (round-3 standards note).
- `3f814b1` — moved the read-key array from module scope into the component. The
  module-level version evaluated `orpc.suppliersListNames.queryKey()` at import
  time and broke `router.test.tsx`, which mocks a smaller rpc surface. Covered by
  the full unit suite (`apps/web`: 852 pass) and the isolated e2e run.

## Tests run by reviewers

`apps/web/src/pages/supplier-opening-balance.test.tsx`: 24 pass / 0 fail.
`apps/api/src/store/drizzle-store.test.ts`: #183 test pass.
