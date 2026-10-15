# #183 test-audit evidence (PR #203 rebase round)

- Issue: #183, names-only supplier lookup for the opening-balance conflict check
- Reviewed head: `67691951a9a59def8b8213d973795d54e1b24af9`
- Base: `origin/develop` `3c3abcf` (post-#184)
- Scope: the merged test file `apps/web/src/pages/supplier-opening-balance.test.tsx`
  plus the API tests the rebase touched
- Verdict: both branches' suites still bite after the merge.

## What the rebase did to the tests

The merged file now carries #184's server-resolve mock (`resolveByKey`,
`resolveFails`, `resolveCalls`, `rejectTargetChanged`, `resolveHold`,
`mutationHold`) and #183's read-failure flags (`suppliersListUsed`,
`accountsShouldFail`, `namesShouldFail`). #183's manual `invalidateQueries`
blocks were dropped because #184's refusal recovery is the mechanism that
refreshes the reads; develop's `BATCH_LIMIT_TEST_TIMEOUT_MS` is kept.

One #183 test needed a real fix, not a merge: `folds a typed name onto an
existing supplier from the names-only list` seeded the fold from
`matchByNormalizedName`, which #184 deleted. With the server resolver as the
only resolver the mock answered `null`, so the dialog never opened. Commit
`6769195` reseeds the mock's server answer for the folded name and asserts the
merged behaviour (dialog names the stored text; payload carries
`expectedSupplierId: "s-3"`).

## Mutation proof that the #183 gate still bites

Removed both `listFailed` branch guards (`|| listFailed` in `submit()` and the
`if (listFailed) { ... return; }` block in `save()`), then ran the file:

```
(fail) blocks the save when the account summary fails instead of skipping the confirmation gate (#183)
(fail) blocks the save when the names read fails instead of skipping the conflict check (#183)
  49 pass
   2 fail
```

Exactly the two named tests fail, so the merged `listFailed` gate is still
discriminating. The page was restored and the clean tree re-verified.

`blocks the confirm-save when the account summary fails after the dialog opens`
still passes under the mutation; that is the documented exception from the
previous round — `save(true)` is only reachable through a control the same
`listFailed` flag disables, and the `disabled` assertion is the user-visible
guard.

## #184 acceptance still covered

- `resolves a folded typed name to the server's existing account and confirms
  it` (adapted): server text in the dialog, `expectedSupplierId` in the payload.
- `names the destination supplier in the confirmation dialog`,
  `renders the server-resolved destination name, not the typed text`, and
  `names and confirms a raced named row only after the refusal refreshes it`
  are #184's and pass unchanged.
- `apps/api/src/rpc/opening-balance-resolver.test.ts` (10/0) proves the tie-break
  lives only in the resolver module and that the page no longer re-implements it.
- `tests/e2e/supplier-adjustment.spec.ts` (12 tests) and
  `tests/e2e/no-write-window.spec.ts` pass in the full e2e run.

## Not re-audited

The report's earlier mutation proofs (blockedReason sweep, requestSubmit sweep)
are on tests this merge did not change and were not re-run. The two named
read-failure tests were re-proven above because the page changed around them.
