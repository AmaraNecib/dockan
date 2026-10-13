# Issue 143 / PR #192 — round-1 debate evidence (critic + defender)

- Base: `da44b50` (origin/develop merge-base)
- Round-1 delta reviewed: `e36d0fc` against the previously reviewed head `f048e45`
- Fixes folded through `12c7c49` → `60c1c0e` (this evidence is named for the final HEAD)
- Workflow: 7 parallel read-only `reviewer` agents — harsh critic, charitable defender, edge-case hunter, coverage analyst, test-quality reviewer, Standards axis, Spec axis — plus one focused verification pass on the fold diff (`e36d0fc...12c7c49`)
- Inputs: `.scratch/sessions/143/e36d0fc-delta.diff`, `.scratch/sessions/143/12c7c49-fold.diff`, full changed files, `apps/api/src/lib/stock-ledger.ts`, `.scratch/implementation/143-design.md`, `.scratch/sessions/crew/briefs/feat-143-greptile-round1.md`

## Central question — can the batch path change ANY number?

No. Critic, defender and the verification pass each traced it independently:

- **Ordering.** Batch candidates are appended with `seq: undefined`; `ordered()`/`byRecordingOrder()` tie-break undefined seq by input index, and spec order equals the rowids the per-line inserts would have received. So every tie resolves identically.
- **Running fallback.** `cacheFor` seeds each item's cache from the same committed row the per-line loop's first `getItemsByIds` would read, then updates it with exactly what each single post's `setItemStockAndCost` would have written. Legacy null-cost inflows, `COST_CORRECTION_REASON` segmentation and `backdateTo`/`saleMovementTime` all replay from `[...history, ...appended]` — the same list a re-read would see.
- **Per-movement numbers.** `stockOnHand`, `costPrice` and `outflowCost` are computed from `[...existing, candidate]` exactly as before; the inserted row is identical.

The critic could not construct a numeric counterexample. It did find one observable behaviour change (error precedence), now fixed.

## Critic findings

| # | Sev | Finding | Decision |
|---|-----|---------|----------|
| 1 | 4 | The batch pre-validated **all** item ids before processing, so a later spec's missing item out-prioritised an earlier spec's oversell (per-line raised `StockLedgerError`, batch raised `StockItemMissingError`). | **Fixed:** item resolution is lazy (`cacheFor`) so a missing item is reported when its first movement is reached. Pinned by "reports an earlier movement's oversell before a later spec's missing item" (fails against the pre-fold code). |
| 2 | 3 | The cache write is deferred to the end of the batch; if a caller caught a rejection *inside* the unit, ledger rows would exist with an un-advanced cache. | **Documented:** the seam doc already states the caller must be inside a transaction and that the enclosing unit rolls back; unchanged. No in-tree caller catches inside the unit. |
| 3 | 3 | The comment claimed per-line "re-reads and re-sorts" blocked other requests; the batch still sorts in memory per movement. | **Fixed:** both comments now name the repeated store round-trips (DB read + SQL sort) as the blocking cost and say the in-memory replay still runs per movement. |
| 4 | 3 | History reads are awaited in a loop (N round-trips for N items). | **Dismissed:** the store serializes every call (`runSerialized`), so `Promise.all` changes nothing; in-tree batches are per item. |
| 5 | 2 | `posted!` non-null assertion. | **Accepted:** invariant is exact (one result per spec); `SAFETY:` comments present. |
| 6 | 2 | `?? []` fallbacks hide a missing-history bug. | **Dismissed:** `appended` is legitimately empty for a first spec; history is seeded for every distinct item. |
| 7 | 2 | `returnsReject` still reads history twice (clamp projection + batch read), not once. | **Accepted:** the brief's requirement is one read + one cache write **per item for the batch**, instead of one per line. The pre-scrap clamp projection is a separate, pre-existing read; the router test pins the total at 2. |
| 8 | 1 | "Validation is total" is per-candidate, not whole-batch. | **Clarified:** the doc says the enclosing transaction rolls the earlier rows back. |

Critic confirmed correct: `ordered`/`byRecordingOrder` tie-break equivalence; running-cache chain; `saleMovementTime` order-independence; empty-batch guard.

## Defender highlights (confidence)

- Batch reproduces a sequence of single posts exactly (9/10): running fallback, ordering, validation-before-write, one cache write = last-write-wins.
- `recordStockMovement` as the length-one thin case is sound (9/10): identical IO to the old single path; the rule lives once.
- The read-count fix is sufficient, not over/under-engineered (8/10): per-line `listStockMovements` collapses to one per item; tests pin both the seam stats and the router read count.

## Other axes (edge / coverage / quality / standards / spec)

| Finding | Axis | Decision |
|---|---|---|
| Multi-item batch untested (`fakeTx` is single-item) | edge, coverage, spec | **Deferred:** the production path batches one item at a time; no in-tree caller posts distinct items in one call. Recorded, not fixed. |
| Empty batch guard untested | edge | **Fixed:** "touches the store for nothing on an empty batch". |
| Mid-batch oversell leaves earlier rows (relies on tx rollback) | edge | **Documented** in the seam doc; no in-tree path can oversell mid-scrap (the clamp prevents it). |
| `backdateTo` inside a batch untested | edge | **Fixed:** a backdated SALE is now one of the equivalence-test specs. |
| Zero-delta cost correction inside a batch untested | edge | **Fixed:** a `COST_CORRECTION_REASON` spec is now in the equivalence test. |
| 200-line scrap exercises only I/O reduction, not CPU | edge, spec | **Accepted:** the brief pins reads; the replay is O(lines × history) in memory, negligible next to the round-trips. |
| Router read-count test hard-codes `2` | edge, quality | **Fixed:** named `expectedLedgerReads = 1 + 1` with an explanatory comment. |
| Missing item mid-batch untested | edge | **Fixed:** dedicated test (plus the precedence test). |
| Requirement 3 proven at the seam, not as a router A/B | coverage | **Accepted:** the seam A/B is the strongest form; the router test additionally asserts 3 rows, sum −3, ref/reason, `stockOnHand 0`, `costPrice 100`. |
| `recordStockMovement` now has no production caller (Middle Man) | standards | **Dismissed:** the brief requires the single-item path to stay a thin case over the batch; it is the seam's public single-movement API, exercised by the unit tests. |
| `clientForStore` duplicates the `linkWith` body | standards, quality | **Deferred:** test-only boilerplate; low value, higher churn risk in a 4300-line test file. |
| All nine single-post sites now funnel through the batch accumulator | spec (scope) | **Accepted:** required by "one implementation of the rule, not two"; behaviour-identical for a one-element batch. |

## Verification pass on the fold (single `reviewer`)

Read `12c7c49-fold.diff` and both full files. Verdict: **no blockers; no number can differ from the per-line path.** Confirmed the lazy `cacheFor` restores per-line error precedence, `running` holds every item with a spec (none skipped at the final write loop), and the new tests are genuine (not vacuous). One note — the precedence fix was not directly pinned — was **fixed** with the extra test. Two informational notes (empty-batch test does not assert `getItemsByIds`; "one item read" wording) were **fixed/dismissed** as above.

## Synthesis

- Blocker/major (8–10): none.
- Fixed now: critic 1, 3; edge empty-batch, backdateTo, correction, missing-item, counting-constant; the precedence-pinning test.
- Accepted / documented: critic 2, 7, 8; standards Middle Man; spec scope.
- Dismissed: critic 4, 6; `clientForStore` duplication.
- Deferred (recorded here): multi-item batch test.

## Post-fix state

- `bun test src/lib/stock-posting.test.ts` → 16 pass / 0 fail.
- `bun test src/rpc/router.test.ts` → 224 pass / 0 fail.
- `bun run typecheck` → clean; `bun run lint` → clean (0 findings).
- Reviewers are read-only; the parent ran Guard separately.
