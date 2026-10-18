# #183 code-review evidence (PR #203 rebase round)

- Issue: #183, names-only supplier lookup for the opening-balance conflict check
- Reviewed head: `67691951a9a59def8b8213d973795d54e1b24af9`
- Diff reviewed: `git diff origin/develop...HEAD` (the #183 delta on top of the
  merged #184 `develop` `3c3abcf`), plus the conflict-resolution deltas against
  the pre-rebase head `608f863`
- Axes: Standards and Spec

## Standards

Sources: `AGENTS.md` (search scope only) and the repo's oxlint config; Guard 1
lint is clean.

- No new duplication of the resolver rule: `matchByNormalizedName` is gone and
  the tie-break lives only in `apps/api/src/rpc/opening-balance-resolver.ts`
  (enforced by the structural test).
- One invalidation list per screen (`supplierReadQueryKeys`), used by both the
  success path and the refusal recovery, so the two cannot drift.
- No dead branch left behind: the #183 `OPENING_BALANCE_EXISTS` catch block was
  removed in favour of #184's richer recovery rather than kept alongside it.
- Style: the page keeps #184's `navigatesCurrentTab` predicate and dismissal
  primitive; #183's additions sit inside the existing handlers. No long
  functions were grown further.

Worst item: `supplierReadQueryKeys` is recomputed every render (a new array
each time). It is only read inside handlers, so this is a non-issue; a
module-level constant would reintroduce the import-time `orpc` trap that #183's
`eb686d7` fixed. Accepted.

## Spec

Spec sources: issue #183 (names-only lookup + failed-read money gate) and the
rebase directive to keep both sides' intent and prefer #184's resolver.

Correct:

- The screen no longer reads `suppliersList`; it reads `suppliersListNames`
  (identity only) and `suppliersAccountSummaries` (balance + entry count), then
  merges by id with a 0/0 default. `never loads the full party list` still
  asserts `suppliersListUsed === false`.
- The failed-read gate is kept in full: `listFailed` blocks `submit()`, blocks
  `save()`, and disables both save buttons; mutation-proven in
  `6769195-test-audit.md`.
- The server-resolved destination is authoritative: the dialog renders the
  server's text and the write sends `expectedSupplierId`, with #184's
  `OPENING_BALANCE_TARGET_CHANGED` guard intact.
- The refusal recovery refreshes all three supplier reads (the two lean seams
  the screen renders and the full list other screens read) before re-asking for
  the destination.

Partial / deliberate:

- `suppliersResolveName` (landed in #184) still builds its candidates from
  `deps.store.listParties("supplier")`, which pays for the invoice aggregate
  #183 added the lean seams to avoid. The resolver needs name + entry count, so
  reusing it is correct; switching it to `listPartyNames` +
  `listSupplierAccountSummaries` is a follow-up optimisation, not a correctness
  gap. Not changed in a rebase round.

Scope creep: none. The only post-merge code edit is the test adaptation in
`6769195` plus the conflict resolutions.

## Summary

Standards: 0 violations, 1 accepted nit. Spec: #183's two deliverables and
#184's resolver are both present; the only partial is the deferred resolver-read
optimisation. No blockers.
