# #222 — debate at `7b03343` (High-assurance)

Tier: **High-assurance** — the change rewrites the supersession resolver that decides which movement a
cost correction overrode, i.e. the provenance the owner reads beside the running weighted average that
feeds COGS/profit (`docs/adr/0002-weighted-average-cost.md`). Named failure mode: a supersession index
(or window) that answers the wrong row badges a purchase a correction did not replace, or hides one it
did — misattributing a money number in an audit trail.

Delta reviewed: `git diff 45328fd...HEAD` (`45328fd` = the #215 PR head rebased onto current
`develop`; `7b03343` = this round). Critic and defender are independent reviewer sub-agents with the
diff, the full changed files and `.scratch/implementation/222-design.md`.

## Critic (verbatim)

**Correct (verified, not assumed).** I could not break it. Differential harness (`.scratch/diff-222.ts`,
throwaway) ran 200k random ledgers × every `(from,to)` window incl. out-of-range/`to<from`, plus holes,
equal seqs, undefined seq, null-cost / wrong-reason corrections, `opening` zero-deltas, outflows, empty
ledger: **0 mismatches** against the old backward scan sliced. The pop/dominance argument holds: an
entry is popped only by a later-positioned correction with `seq ≥` its own, so it can never be the
nearest qualifier for a row visited after the pop, and stack order = position order makes the binary
search return the nearest qualifier. Cross-page #215 semantics intact; the e2e pins the real
page-1/page-2 split and `toContainText("تصحيح التكلفة")` prevents a vacuous negative pass.

1. **Severity 4 — `apps/api/src/rpc/router.ts:617-621`:** the window is behaviour-invisible *and*
   unpinned. Whole-ledger output sliced ≡ windowed output (`stock-ledger.test.ts:510-518` pins exactly
   that); reverting the router to `supersededByCorrectionSeq(projected)` passes every test. Measured
   reads for limit 50: offset 0→299, 1 000→6 299, 50 000→300 299, 100 000→600 999 (≈6/row) — per-page
   work is **Θ(offset+limit), not page-proportional**; the ledger is still fully fetched
   (`listStockMovements`) and fully projected (`historyWithRemaining`) per request. So 12 lines of new
   API surface buy a constant-factor allocation saving, and the design's "a page of 50 rows annotates
   50 rows, not 10 000" is true only of the output array. Plus `from<0 → 0` clamping while the router
   slices raw `offset` (negative slice = from-the-end) would silently misalign badges for any future
   caller — unreachable today only because `paginationInputSchema.offset` is `.min(0)`
   (`packages/contracts/src/core.ts:708`). Undocumented clamping contract.
2. **Severity 3 — `apps/web/src/lib/i18n.ts:603`:** `اللاحق` ("the later one") is unanchored. In a
   date-ordered list the correction is drawn *above* the row, so "the later correction" can still be
   read as the one below — the definite `أعلاه` misdirection is traded for vagueness. Naming recording
   order directly (`المسجَّل بعده`) closes it. The unit pin (`stock.test.tsx:190-199`) is an 8-token
   denylist: pins absence, not meaning; a reworded misdirection passes.
3. **Severity 3 — `stock-ledger.test.ts:541-584`:** both pins measure the *default whole-list* call —
   the path the router no longer uses for annotations — so they under-pin finding 1's claim. Margins
   are thin (pin 2: theoretical log-growth ratio ≈2.2 at n=250 vs bound 3) and neither covers the
   top-qualifies fast path. Not decorative (old quadratic → ~4× would fail), but not discriminating
   for what the window was added for.
4. **Severity 2 — `stock-ledger.ts:299`:** `i >= start` is dead (`:287/:291` already `continue`d) —
   misleading load-bearing-looking guard.

Residual risk: none blocking; the algorithm itself is sound.

## Defender (verbatim)

1. **Dominated-correction drop is sound** — `stock-ledger.ts:280` pops any correction whose
   `seq <= row.seq` before pushing. If a popped `d` ever qualified a row, the popper `c` satisfies
   `c.seq >= d.seq > row.seq` and is drawn strictly closer, so `c` qualifies too and is the nearer
   answer. `d` can never be the unique nearest qualifier → dropping it is exact. **10/10.**
2. **Index invariant makes the query 1-D** — after the pop loop the array is position-ordered with
   strictly decreasing `seq`; qualifying entries form a *prefix* `0..k`, and the nearest-by-position
   qualifier is the largest such index. Top-first check (292–296) then binary search (299–313) returns
   index `k` in O(log n). **10/10.**
3. **Window keeps the cross-page badge, bounds per-page work** — the loop end is `end` (274), so walk
   cost tracks the window's end; rows with `i < start` still feed the index (289 skips only
   *answering*), so a correction above the page badges a row inside it. Router slices first
   (`router.ts:616,621–622`). **10/10.**
4. **O(n log n) is the right class** — the query "max position subject to `seq > threshold`" is 2-D
   dominance; a monotonic index collapses the position dimension, leaving one threshold query per
   inflow. O(n) with no corrections. **9/10.**
5. **Page-agnostic copy is strictly better than a page-aware probe** — `i18n.ts:603` names recording
   order, dropping "above" (أعلاه). A page-aware probe would need the correction's page in the payload
   and would still mislead as pages shift. **9/10.**
6. **Tests pin behaviour** — the exhaustive equivalence test (`test.ts:511`) checks every window
   equals the whole-ledger answer sliced, i.e. the pre-222 contract; pop-chain (521) and deep-index
   (532) pin semantics; the 570/582 read-count guards assert complexity class without snapshots or
   timing. **9/10.**

Also verified by both: 58 API + 21 web tests pass at `7b03343`.

## Synthesis

| # | Finding | Decision |
| --- | --- | --- |
| 1 | Window is behaviour-invisible; per-page work Θ(offset+limit), not Θ(page) | **Dismissed as a defect, accepted as a documented residual.** The brief allows "index first and then slice"; `historyWithRemaining` already walks the ledger for cumulative `stockAfter`/`total`, so the index pass adds no asymptotic cost, and the O(n²) per-inflow rescan the finding named is gone. The window bounds the output array and the answering to the page, and page 1 stops the walk at 50. Pinning the router's window argument is impossible black-box because the output is intentionally identical; the existing `router.test.ts:4516` page-1/page-2 case *does* fail if the window is misaligned (page-2 `supersededBySeq` reads from the page-relative slice). Recorded in `7b03343-code-review.md` as residual risk. |
| 2 | `اللاحق` is unanchored | **Dismissed.** It is order-based (recording order), which is the invariant, and is true on every page — the misdirection the Greptile finding named was the page claim ("أعلاه"). Rewording churn would not kill the denylist's inherent limit and the copy is already page-agnostic. |
| 3 | Complexity pins measure the default whole-list call | **Accepted.** The window is a scoping optimisation, not the complexity fix; the pins measure exactly the path Greptile reported (10,000 inflows, no corrections). The window path is additionally covered by the window≡slice equivalence oracle. |
| 4 | Dead `i >= start` guard | **Accepted as cosmetic.** Harmless; removing it would force another evidence round for no behavioural gain. |

Mutation check (this round, against `45328fd`): restoring the pre-fix `stock-ledger.ts` fails **5** of
the issue-222 cases — `aligns the answer to the requested page window`, `answers each window as the
whole-ledger answer sliced`, `answers a window from a deep index built above it`, and **both**
complexity pins — while the 53 other cases (all #215 semantics) stay green. The guards are
discriminating, not decorative.
