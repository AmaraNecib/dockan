# #123 — test-audit evidence (review-fix round 1)

Final HEAD: `f195f324c6da6ba7daf6d0aa11bd16f08ce6f309`
Base: `origin/develop` @ `07ab23d561b59e4117846fb8bebbb3415533cc49`
Delta: `git diff f353b67..f195f32` (`.scratch/reviews/123/round1-delta-final.diff`)

Three read-only auditors per round (edge-case hunter, coverage analyst, quality
reviewer). Final grade **A−**, held back only by the e2e layout test's coupling
and a documented stale-closure assumption — no functional gap.

## Failing-without-the-fix coverage

Each finding is pinned by at least one test that fails on the pre-fix code
(verified by mutation, not just reading):

| Finding | Test that fails without the fix |
|---|---|
| 1 — refusal survives a remount | `date-field.test.tsx` "keeps a refusal across an unmount/remount (a preset switch)" — mutation: restoring the `blurred` flag fails exactly this plus the page-level test |
| 1 — page-level parity | `expenses.test.tsx` "keeps the refusal visible when the preset is switched away and back" (also asserts the applied bound never moved) |
| 2 — refused edit keeps the page | `expenses.test.tsx` "keeps a later history page when a refused bound edit is not applied" — mutation: unconditional `pager.reset()` fails this and the `to`/clear siblings |
| 2 — `to` bound | "keeps a later history page when a refused upper-bound edit is not applied" |
| 2 — clearing an applied bound | "resets to page one only when clearing a bound that was applied" (the first half is the regression-sensitive one) |
| 2 — same-value guards | "does not reset a later page when a filter is re-applied unchanged" — mutation: removing the guards fails it |
| 3 — min-w-0 + stacking | e2e "custom range controls stack and stay inside their column on a narrow window" (`/expenses` and `/reports`) |

## Edge cases

- **Covered:** remount-clean negative control (readable value remounts without a
  warning), from and to, clear-applied vs clear-open, same-value preset/sortBy/
  sortDir/filter-all, both screens' narrow-width stacking.
- **Accepted, no change:** whitespace-only text trims to an open bound
  (pre-existing parser semantics); reversed ranges are the api's problem
  (documented in the design); the `min-w-0`/spill e2e is coupled to
  `div.flex` + computed `min-width` (deliberate — it is the literal mechanism of
  the fix, and the alternative `scrollWidth` check is weaker).
- **Not applicable:** reports has no pager, so no reset-parity test is owed.

## Test quality

- Names state the outcome, not the mechanism.
- Async handled with `act` + bounded `waitFor`; the new `mountPage.blur` helper
  replaces four copy-pasted focusout blocks; `mountToggled` reuses the file's
  `mounted` teardown.
- Assertions are semantic (`aria-invalid`, `aria-describedby`, `role="alert"`,
  the captured ISO bound, the captured `offset`), not internal shape.
- Module-level `beforeEach` resets only `listItems`/`listTotal`; it does not
  clash with the three per-describe hooks.
- The new `listItems`/`listTotal` fixture is what makes the pager real; without
  it `expenses-pager-next` would not exist.

## Findings and disposition

| Finding | Action |
|---|---|
| Four same-value guards untested (round 2) | Fixed — guard test added, mutation-verified |
| Presence-only error assertions in two tests | Strengthened to `role="alert"` |
| e2e `min-w-0` assertion passed with or without the class at 420px | Fixed — assert computed `min-width: 0px` |
| `applyBoundEdit` closure assumption untested | Accepted — documented; discrete-event flush is React's contract |
| Reports grid change only covered by e2e | Accepted — a Tailwind-only change |
| Fixed 20 ms sleep for "nothing happened" assertions | Accepted — pre-existing pattern; mutation runs prove the assertions hold |

## Runs

- Focused: `bun test src/components/ui/date-field.test.tsx src/pages/expenses.test.tsx`
  → 51 pass / 0 fail.
- Full unit (`bun run test`): web 891 / api 886, 0 fail.
- Full e2e: 57 pass / 0 fail (isolated ports 4388/5188).
