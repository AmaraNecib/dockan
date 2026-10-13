# Wisdom: issue 143 movement-posting seam (stock write + cache resync)

## Return-line order is not stable — key per-line tests by line id, never position (🟠 Major)

`getReturnDetail(id).lines` comes back in an unspecified order; across runs the
same return's lines can swap. A `returnsReject` test that asserted the scrap
movements positionally (`toEqual([-1, -2])`) flaked roughly 50% because the
per-line allocation follows the return's line order. The allocation itself is
correct (each line's take equals its own quantity when the budget is the full
returned quantity); only the row order moves.

**Always**: when a flow allocates one quantity across several child lines, assert
`Map<lineId, allocatedQty>` against `Map<lineId, expectedQty>`, or sort/sum. Never
pin a positional array of per-child rows. If order matters to the product, fix the
query with an explicit `ORDER BY` — do not encode an assumed order in the test.

## Extracting a repeated sequence into one module surfaces latent rule differences (💡 Design Principle)

Issue 143 pulled "read ledger → candidate → validate → FIFO snapshot → insert →
replay weighted average → write cache" out of nine `router.ts` call sites. Two
latent divergences only became visible once the sites shared code:

- **Outflow rule.** `stockAddManual` preserved the cached `costPrice` on
  `delta < 0`; everyone else replayed. They agree for an in-sync, non-backdated
  outflow, so no test had ever caught it — they diverge only for a *backdated*
  outflow (replay `233` vs preserve `200`). The ADRs settled it (ADR-0005:
  "replayed from the full ledger after any write").
- **Replay fallback.** `stockAddManual` passed no `fallbackUnitCost` (null-cost
  legacy inflows blended at 0); everyone else passed `item.costPrice`. Unreachable
  with current data, but a real second behaviour change.

**Always**: when unifying duplicated sequences, enumerate every parameter that
differed per site (fallback, ordering, validation timing, candidate shape) and
decide each one explicitly. Pin the diverging case with a golden test even when
the current data cannot reach it; a latent drift is the whole risk of the refactor.
If the docs settle the rule, say so and cite the ADR — that is stronger than a
"decision needed" note.

## Evidence SHA hygiene after review fixes (🟡 Minor)

Debate/test-audit/code-review evidence is named `<reviewed-sha>-<gate>.md`. When
review fixes change HEAD, amend the source commit and rename the evidence to the
new SHA in the evidence commit. Guard's staleness check tolerates an evidence
commit that only touches `.scratch/`, so the evidence SHA may trail HEAD by one
non-reviewable commit — but a tracked evidence file naming a SHA that is not in
the final history is a blocker.
