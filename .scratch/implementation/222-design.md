# Issue 222 — close the 2 Greptile findings on the recording-order PR (design)

Tier: **High-assurance**. Finding 1 rewrites the resolver that decides which movement a cost
correction supersedes — the provenance the owner reads next to the running weighted average that
feeds COGS/profit (`docs/adr/0002-weighted-average-cost.md`). The **named failure mode** is a
supersession index that flags the wrong movement (or misses one): the badge then tells the owner a
correction replaced a purchase it did not, or stays silent where it did, so a money number is
misattributed in an audit trail. Finding 2 is copy, but it points at that same correction.

Base for review: current `origin/develop` (`1ea76b5`). The PR's four commits
(`bd537cc`, `fc9a613`, `d2a82ca`, `3635538`) are cherry-picked onto it, so this branch is the PR
rebased onto current develop plus this round.

## Finding 1 — `supersededByCorrectionSeq` is quadratic (`apps/api/src/lib/stock-ledger.ts`)

Greptile: `supersededByCorrectionSeq` scans every earlier movement for every inflow, and
`itemsHistory` runs it over the whole ledger before slicing. For 10,000 inflows with **no
corrections** that is ~50M checks per page request.

The rule is a 2D-dominance query: for an inflow at date-order position `i` with recording order `r`,
report `max{ seq(c) : c is a correction drawn above the row (position < i), seq(c) > r }`. The old
code answers it by walking left from `i` until the first qualifying correction — O(n) per inflow.

### Fix

One left-to-right pass builds a monotonic index of corrections, and each inflow is answered in
O(log n) against it — O(n log n) for a ledger that has corrections, O(n) for one that has none (the
reported case). No new field, no schema change, no store call.

The resolver takes a `[from, to)` **window** and returns an answer aligned to that window only. The
router slices the page first and passes `offset, offset + page.length`, so the ledger above the page
is walked once to build the index but page rows are the only rows answered: a page of 50 rows
annotates 50 rows, not 10,000, and allocates 50 entries, not 10,000. A page-1 request stops the walk
at the page's end. Rows above the window still badge rows inside it, so issue 215's cross-page case
is intact.

A correction `c` recorded **before** a later correction `c'` (position of `c` < position of `c'`) with
`seq(c) <= seq(c')` can never be the nearest qualifying correction for any row: for any threshold,
if `c` qualifies then `c'` also qualifies and `c'` is nearer. So the index keeps only the
non-dominated corrections, in position order, with strictly **decreasing** `seq`. For a row with
recording order `r`, the nearest qualifying correction is the topmost index entry with `seq > r`
(fewer entries qualify as `r` grows), found by binary search over the decreasing `seq` array.

Only inflows (`delta > 0`, `seq` defined) are queried; only `COST_CORRECTION` zero-delta rows with a
non-null unit cost are indexed — exactly the old predicate, so the output is byte-identical.

### Proof it is a fix, not a coincidental speed-up

A unit guard counts **property reads** on the rows (getters/`Proxy`) for N vs 2N inflows with no
corrections. The old code does ~4× the work at 2N (quadratic); the fix does 2×. The guard asserts
`work(2N)/work(N) <= 2.5`. It is mutation-checked against the unfixed function.

## Finding 2 — the badge points "above" across a page boundary (`apps/web/src/pages/stock.tsx`)

`historySupersededByCorrection` says the correction is **"أعلاه"** (above). On page 2 of the #215
scenario the correction is on page 1, so the copy sends the owner somewhere they cannot look.

### Fix

Make the copy page-agnostic: drop the location claim and name the ordering the rule actually uses.
`"سُجِّل قبل تصحيح التكلفة اللاحق، فاستُبدل أثره في متوسط التكلفة"` ("recorded before the later cost
correction, so its effect on the average was replaced"). It cannot be wrong on any page, needs no
page probe, no new field and no new key — the tightest fix for "this is copy, not behaviour".

The pin exercises the **cross-page** case, because that is where the old text lied: the existing
e2e scenario (correction on page 1, badged row alone on page 2) asserts the rendered badge does not
make the "أعلاه" claim, plus a unit pin that the keyed string carries no page-relative word.

## Interfaces

| Seam | Change |
| --- | --- |
| `supersededByCorrectionSeq(rows, from?, to?)` | same signature and output for the whole list; new optional window; internal monotonic index instead of a backward scan |
| `itemsHistory` router handler | slices the page first, resolves precedence for the page's window only |
| `historySupersededByCorrection` (i18n) | page-agnostic Arabic copy |

Nothing else moves: no contract, no store, no badge-set logic.

## Planned tests

Unit — `apps/api/src/lib/stock-ledger.test.ts`:
- the existing #215 cases stay green (semantics unchanged);
- **complexity pin**: property-read count for N vs 2N no-correction inflows grows about linearly;
- a deep-index case still returns the nearest qualifying correction (the binary-search branch).

E2E — `tests/e2e/stock-ledger.spec.ts` (cross-page scenario, page size 2):
- page 2's badge is visible and its copy makes no "أعلاه" claim.

Unit — `apps/web/src/pages/stock.test.tsx`:
- the keyed copy contains no page-relative pointer.

## Risks

- **Wrong index answer** (the named failure mode): guarded by keeping the #215 output assertions
  (including the "nearest of several" case) and adding the deep-index case; any divergence fails an
  exact `toEqual`.
- **Complexity pin flakiness**: the pin counts reads, never wall-clock, so a loaded host cannot move
  it.
- No behaviour, no money output, no schema change.
