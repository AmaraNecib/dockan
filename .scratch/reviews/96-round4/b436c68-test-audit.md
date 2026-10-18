# Test audit — issue #96 round 4

Head reviewed: `b436c68` (the three agents read `777f3f7`; see *Provenance*).
Base: `5144100`. Spec: `.scratch/implementation/96-round4-design.md` and the crew
brief (`.scratch/sessions/crew/briefs/issue-96-round4.md`).

Three sub-agents (edge case hunter, coverage analyst, quality reviewer) ran in
parallel. Their reports are quoted, then dispositioned.

## Edge case hunter

> Missing edge cases:
>
> 1. **Category pill refetched away / deleted (untested claimed fallback) — MED.**
>    `expenses.tsx:147` relies on `querySelector` returning null when the pill is
>    gone, then falls through to the preset. No test exercises it.
> 2. **Default window also empty (untested branch) — LOW.**
> 3. **`getByTestId`-style selector injection — LOW.** `expenses.tsx:149`
>    interpolates the id into a raw attribute selector with no `CSS.escape`.
> 4. **Custom-bound preset path (untested) — LOW.**
> 5. **Stale ref on a no-op "all" click — LOW.**
> 6. **`applyBoundEdit` sets the ref even when the edit is refused — LOW.** Focus
>    lands on a control that did not narrow the view — the class the design argues
>    against.

## Coverage analyst

> - **Correct — both acceptance criteria have a test.** invoices: kind=SALE then
>   status=PARTIAL, asserts focus `invoices-status-filter`; the old rule focuses
>   kind, so it discriminates. expenses: the three tests all fail pre-fix.
>   (Note: the invoice page is unchanged in this diff, so its red baseline is
>   pre-`5144100`, not `5144100`.)
> - **Uncovered branches:** `applyBoundEdit` → `expense-range-preset`; the
>   defensive fallback `previous ?? range-preset`.
> - Single-filter invoice tests (`:221`, `:239`) pass under both rules — they only
>   guard "focus ≠ body".
> - No duplicate assertions; tests 2–3 share the 7D setup. `focusedTestId` is
>   copy-pasted in both files.

## Quality reviewer

> **Grade: A** — strong, non-vacuous, correctly isolated.
> - Focus assertions are not vacuous: both files `.focus()` the clear button
>   immediately before clicking, which defeats focus left by the select's
>   close behaviour.
> - `filteredEmpty` is safe for the other 45 expenses tests (default false, reset
>   in the outer `beforeEach`).
> - Nits: `focusedTestId` duplicated; `invoices.test.tsx` now drives selects two
>   ways; `filteredEmpty` reset only by the outer `beforeEach`.

## Dispositions

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | Recorded pill gone — untested fallback | **Fixed.** New test "falls back to the range preset when the recorded pill is gone": the category list is refetched without the pill while its filter is still applied, then the clear runs. Red pre-fix (`null`), green now. |
| 2 | Default window also empty | **Dismissed.** After the clear the preset remains rendered and focused; the empty state's action changes to the amount field, which is a different control. No hand-off is lost, so a test would assert the fallback twice. |
| 3 | No `CSS.escape` on the interpolated id | **Dismissed.** The id is a server-generated `ExpenseCategory.id`, never user text; `expenses.tsx` already interpolates ids into testids (`expense-filter-${category.id}`) and an id containing a quote is not a shape this schema can produce. |
| 4 | Custom-bound path unobservable | **Dismissed, with a change.** The applied-bound branch now sets the ref (so attribution is honest), but its *outcome* is identical to the preset fallback — a test could not discriminate, so adding one would be ceremony. Recorded in the design doc. |
| 5 | Stale ref on the no-op "all" click | **Dismissed.** The early return happens when no category is selected, so nothing changed and the previous attribution is still the last real change. |
| 6 | `applyBoundEdit` records a refused edit | **Fixed.** The ref assignment moved inside `if (next.bound !== previous.bound)`, so only an applied window change is attributed to the range control. |
| 7 | `focusedTestId` duplicated in two specs | **Fixed.** Moved to `apps/web/src/tests/page-harness.tsx` (the "one definition new specs start from"), imported by both. |
| 8 | Two select-driving paths in `invoices.test.tsx` | **Fixed.** All five pre-existing call sites now use `chooseOption`; the local `openPopup`/`choose` pair is deleted. One path, so the next round cannot pick the unsafe one. |
| 9 | Vacuous-focus risk (quality reviewer's "not vacuous" finding) | **Hardened anyway.** Each new test focuses the clear button before clicking it, and the invoice test asserts the state premise (`kind=SALE` + `status=PARTIAL` in the last request) before the focus assertion. |
| 10 | `filteredEmpty` reset only by the outer `beforeEach` | **Fixed.** Also reset in the `history empty state (issue #96)` describe's own `beforeEach`. |

## Provenance

The three agents reviewed `777f3f7`. Findings 7–10 were applied after that, plus
the `applyBoundEdit` change (finding 4/6), so those parts of the report are
**not** a review of the final code. What was re-run on the final head:

- `bun run lint` → clean
- `bun run typecheck` → 4/4 successful
- `bun test` in `apps/web` → **1197 pass, 0 fail, 76 files** (267 s)
- failing-first red/green for all five new tests: `b436c68-failing-first.md`

No new review agent was run for the post-review edits; the parent's Greptile
round is the independent check on them.
