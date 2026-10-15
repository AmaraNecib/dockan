# #183 test-audit evidence (review-fix round 2)

- Issue: #183, names-only supplier lookup for the opening-balance conflict check
- Base: `f75721133f25bfe29766266381893520e48d6bb0` (`origin/develop` at round 1; develop has since moved, see the guard file)
- Head under review: `cbd2337c71efdb9bb999941f922e7e39b22299c7`
- Round: review-fix 2
- Audited file: `apps/web/src/pages/supplier-opening-balance.test.tsx` (test-only diff)
- Verdict: Greptile's finding is closed and mutation-proven. The class sweep found six more masked assertions; five are fixed and one is documented as unreachable through the UI.

## Greptile finding and fix

Greptile (5/5): both read-failure tests submitted an EMPTY form. `totalRows === 0` stopped the request on its own, so `captured` stayed `null` even if the `listFailed` guards in `submit()` and `save()` were deleted. The assertion did not test the guard.

Fix in `cbd2337`:

1. `blocks the save when the account summary fails ...` and `blocks the save when the names read fails ...` now fill a valid typed-name row (`مورد بلا حركات`, `400`, which resolves to `s-2` with `accountEntryCount: 0` so no confirmation dialog can intercept) while the table is rendered.
2. They then flip the failure flag and fail the read on refetch (`invalidateQueries`), then `requestSubmit()`. React Query keeps last-good `data` on an errored refetch, so `suppliers` and the drafts survive, `totalRows` stays 1, and only `listFailed` can block.
3. Filling before the failure is required: `listError !== null` swaps the table for `opening-balance-error`, so the typed inputs are gone after the read fails.

### Mutation proof (required by the brief)

Temporarily removed both `listFailed` guards from the page: `|| listFailed` in `submit()` and the `if (listFailed) { ... return; }` block in `save()`. Ran the file.

```
(fail) blocks the save when the account summary fails instead of skipping the confirmation gate (#183)
(fail) blocks the save when the names read fails instead of skipping the conflict check (#183)
  23 pass
   2 fail
```

The two named tests fail; the page was restored and the clean tree re-verified.

Both branch guards are removed for the proof because the page implements one logical check in two places. Removing only one leaves the other to block, which is expected and noted below.

## The class, checked deliberately

Every test in the file that asserts "nothing was sent" (`captured === null`; there is no `mutationCalls`/`resolveCalls` sentinel) was classified by asking what else could make the assertion true.

| Test | Mask before this round | Fix | What makes it discriminate now |
|---|---|---|---|
| asks for confirmation before adding an opening balance ... | none (valid row, enabled control) | none | deleting the `needsConfirmation` early-return sends the batch |
| refuses to save when no row carries an amount | subject is the empty guard | none | deleting `totalRows === 0` POSTs an empty batch and the error text disappears |
| blocks the save and marks the row when an amount draft is invalid | empty batch (only row invalid, so `totalRows === 0`) plus disabled control | valid `s-2` row added, `requestSubmit()` | deleting the invalid-row branch sends `s-2` |
| rejects a decimal-grouped amount ... | same | valid `s-2` row added, `requestSubmit()` | deleting the branch sends `300` |
| blocks an incomplete inline supplier ... | empty batch plus disabled control | valid `s-2` row added, `requestSubmit()` | deleting `newRowError` sends `s-2` |
| blocks two outgoing rows folding to one name ... | confirmation precondition (`s-1` has entries) plus disabled control | filled row retargeted to `s-2`, `requestSubmit()` | deleting `typedNameConflict` sends two rows for `s-2` |
| blocks a batch over the 200-row contract limit ... | disabled control | `requestSubmit()` (plus a `60_000` timeout) | deleting `overLimit` sends the 201-row batch |
| blocks the save when the account summary fails ... | empty batch | valid typed row, refetch failure, `requestSubmit()` | mutation-proven above |
| blocks the save when the names read fails ... | empty batch | valid typed row, refetch failure, `requestSubmit()` | mutation-proven above |
| blocks the confirm-save when the account summary fails after the dialog opens | disabled control | none, documented exception | see below |
| blocks a typed name whose supplier already has a filled row ... | confirmation precondition (`s-1`) plus disabled control | retargeted to `s-2`, `requestSubmit()` | deleting `typedNameConflict` sends the pair |
| counts a typed name toward the batch limit ... | none (already `requestSubmit()` with 201 rows) | none | deleting `overLimit` sends 201 rows |
| names and confirms a raced named row ... (`null` after the first confirm) | server refusal (mock throws) | none | a wrong `confirmExisting` on the first attempt lets the mock accept, so `captured` is non-null |

Not a sentinel test but related: `never loads the full party list` asserts `suppliersListUsed === false`, which the page can only satisfy by not calling `suppliersList`.

### Second mutation proof

Temporarily set `blockedReason` to `null` (removed the `overLimit`, `invalidExisting`, `typedNameConflict`, and `newRowError` branches). Seven tests failed, exactly the seven whose guard is in `blockedReason`:

```
(fail) blocks the save and marks the row when an amount draft is invalid
(fail) rejects a decimal-grouped amount with a row error instead of saving 100x
(fail) blocks an incomplete inline supplier instead of dropping it
(fail) blocks a batch over the 200-row contract limit before saving
(fail) blocks two outgoing rows folding to one name before the server
(fail) blocks a typed name whose supplier already has a filled row instead of double-posting
(fail) counts a typed name toward the batch limit and blocks before the server
  18 pass
   7 fail
```

Page restored afterwards.

### Documented exception: the confirm-save test

`blocks the confirm-save when the account summary fails after the dialog opens` asserts `confirm-save` is `disabled` and that `captured` stays `null`. The same `listFailed` flag both disables that control and backs the `save()` guard. `clickOn` on a disabled button is a no-op in jsdom. I tried stripping the `disabled` attribute first: React still suppresses `onClick` from a control whose memoized `props.disabled` is true, so my forced click never reached `save()` (verified with a temporary page log, no `save` call). `save(true)` is only reachable from that control, so with `listFailed` true it cannot be exercised through the UI. The `disabled` assertion is the user-visible guard and fails if `listFailed` is dropped from the control. The `save()` branch is defense-in-depth behind it. Removing only that branch is behaviourally inert, which is why this one null is left as is and documented here rather than faked.

## Sub-agent findings and dispositions

Three test-audit sub-agents (edge-case hunter, coverage analyst, quality reviewer) and two code-review sub-agents ran read-only against the uncommitted diff.

| Finding | Source | Disposition |
|---|---|---|
| Remaining masked `captured === null` on over-200, double-post, confirm-save | all three | over-200 and double-post fixed; confirm-save documented above |
| Zero/negative amount untested in the page test | edge-case hunter (red) | Zero is pinned at the unit level in `apps/web/src/lib/supplier-opening-draft.test.ts` (`"0"` -> invalid). Negative is deferred; the shared `<= 0` branch is the same one the unit test exercises |
| Date field and `occurredAt === null` silent return uncovered | edge-case hunter (orange) | Deferred, pre-existing, unrelated to this round |
| Exactly-200 boundary (cap allowed) untested | edge-case hunter (orange) | Deferred; the 201-row test pins the over side and `isOpeningBatchOverLimit` has a unit test |
| Direction `THEY_OWE` payload uncovered | edge-case hunter (orange) | Deferred, pre-existing |
| Non-`OPENING_BALANCE_EXISTS` mutation error path uncovered | edge-case hunter (orange) | Deferred, pre-existing |
| `requestSubmit()` block duplicated 6 times; a `submitForm()` helper would hide it | standards + quality reviewer | Deferred style nit. The helper would be a clean-up, not a correctness fix |
| Raw string query keys in `invalidateQueries` duplicate the mock and page keys | standards reviewer | Deferred. Pre-existing shape in this test file; the mock already exports `DEBTS_BY_PARTY_QUERY_KEY` where it mattered |
| No assertion that `mutateAsync` is never called, only that `captured` is null | coverage analyst | Deferred. `captured` is set inside the mock's `mutationFn`, so a null `captured` and an uncalled mutation are the same observation at this seam |
| `listPending` never asserted | coverage analyst | Deferred, pre-existing |

No sub-agent found a test that still passes vacuously for its targeted guard, apart from the confirm-save exception.

## Tests executed

- `cd apps/web && bun test --max-concurrency=2 src/pages/supplier-opening-balance.test.tsx` -> exit 0, 25 pass / 0 fail.
- `bun run test` -> exit 0, api 888/0, web 963/0, desktop 57/0.

Guard 1 and Guard 2 commands and exit codes are in `cbd2337-guard.md`.
