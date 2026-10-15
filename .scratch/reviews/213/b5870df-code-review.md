# Code review — #213 at `b5870df1cc3c1a69a8844dc8bb904261acbde217`

Two-axis review (Standards + Spec) of `git diff 8a7a7fa...8d9d9bd`, run as two
parallel read-only sub-agents. Commits reviewed:

- `92fe41d` perf(api): resolve the opening-balance name from the lean reads (issue 213)
- `8d9d9bd` test(api): close the #213 test-audit gaps

`b5870df` applies the single code-review note (below); it is a test-only change.

## Standards

No hard violations. Design artifact is at the documented path, the resolver rule
stays in one place (`resolveOpeningDestination`), and the two-read merge owes and
has an equivalence test (`2026-10-14-split-list-read-money-gate.md` §3), incl. a
net-zero account.

Baseline smells raised, all judgement calls:

- **Duplicated Code** — the `{ id, name, entries }` candidate shape recurs at
  `router.ts:1133` (resolve) and `router.ts:1013` (guarded write), plus the test
  oracle copy. The inputs differ (`PartyListItem` vs `PartyName` + summary map)
  and the test copy is the deliberate oracle, so extraction is weak. Left as is.
- **Primitive Obsession** (weak) — `entriesById: Map<string, number>`; a named
  type would not read better. Left as is.
- **Test note** — `expect(emptyTwin.id).not.toBe(netZero.id)` was tautological.
  **Applied in `b5870df`**: replaced with the fold assertion
  `normalizeTextKey(emptyTwin.name) === normalizeTextKey(netZero.name)`.

## Spec

No missing or partial requirements; no scope creep; nothing implemented wrong.

- "compose listPartyNames + listSupplierAccountSummaries instead of listParties"
  — done; `listParties` dropped from the handler.
- "(1) output byte-identical (#184 tests are the oracle)" — `?? 0` on both sides
  over the same `safeWhole` count; #184 tests unedited; equivalence test added.
- "(2) a test pins the resolve path no longer calls listParties" — counting store
  `=== 0` + the booby-trapped empty-store path.
- "(3) no behaviour change to which supplier resolves" — filter key and
  `pickOpeningSupplier`/`lowestById` untouched.
- Brief (b) empty-store + no-match paths covered; (c) `supplier-opening-balance.tsx`
  untouched; (d) output shape unchanged.
- The structural "one implementation" test (`opening-balance-resolver.test.ts`)
  still passes; no tie-break copy was added.

Non-blocking note carried forward: the cost pin lives in the router test and does
not guard the guarded-write path — that path is out of #213's scope.

## Verdict

Both axes pass. One test-quality note applied; no production changes after
review.
