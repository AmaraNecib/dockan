# #123 — debate evidence (review-fix round 1)

Final HEAD: `f195f324c6da6ba7daf6d0aa11bd16f08ce6f309`
Base: `origin/develop` @ `07ab23d561b59e4117846fb8bebbb3415533cc49`
Tier: **Standard** (web UI). Debate run because the lane brief requires it.

Reviewed delta: `git diff f353b67..f195f32`, kept verbatim at
`.scratch/reviews/123/round1-delta-final.diff`.

## What changed

Three Greptile 4/5 findings on PR #194:

1. **A date refusal vanished across a preset switch.** `DateField` gated its
   own warning on a mount-local `blurred` flag, so `preset === "CUSTOM"`
   unmounting/remounting the field brought an unreadable value back clean while
   the old bound still filtered the list. The refusal is now derived from
   `value`; local state (`editing`) only suppresses it while a keystroke is in
   flight.
2. **A refused bound edit reset the page.** Both custom-bound callbacks called
   `pager.reset()` even when `editDateBound` kept the previous bound, so typing
   an impossible date on a later history page jumped to page one. Reset now
   happens only when `next.bound !== previous.bound`.
3. **The range controls spilled out.** The input gained `min-w-0` and the two
   bound fields stack below `sm`.

Follow-ups from the review rounds:

- the same-value no-op class was closed for the preset/sort selects and the
  active "all categories" pill (`applyFilterChange`, early return);
- the guards got a regression test;
- the design doc was refreshed to the derived-refusal contract.

## Rounds

### Round 1 — delta `f353b67..156a011`

Seven read-only reviewers (critic, defender, three test auditors, standards,
spec). No blocker. Actionable:

| Finding | Severity | Disposition |
|---|---|---|
| "All categories" pill reset a later page while already active | 5 | Fixed — early return |
| Preset/sort selects reset before knowing the value moved | 4 | Fixed — `applyFilterChange` guard |
| `applyBoundEdit` reads a render-closure `previous` | 4 | Documented — one discrete flushed event per edit, no other writer |
| Design doc still described the blur-gated contract | 2 | Fixed |
| `to` bound and the clear branch untested | 4 | Fixed — both tests added |
| Reports parity for the reset class | — | N/A — reports has no pager |
| min-w-0 e2e likely tautological at 420px | 4 | Fixed — asserts computed `min-width: 0px` |

The round-1 critic also reported a severity-9 blocker claiming a concurrent
writer and an `everBlurred` variant in `date-field.tsx`. **Dismissed as
fabricated**: the reviewer had no shell access; `git status` was clean, the file
has exactly one `useState` (`editing`), and no `everBlurred` string exists in
the repo. Verified directly.

### Round 2 — delta `f353b67..d0e56e1`

Seven reviewers again. No blocker. One real gap: the four same-value guards had
no test — deleting any left every test green. Also noted: `applyBoundEdit`'s
closure assumption is documented but untested; the reports grid change is only
covered through the e2e loop (accepted).

### Round 3 — final `f195f32`

One independent pre-merge re-check. Verdict: **No issues found.** It confirmed
all three fixes, walked every filter callback (`applyFilterChange`,
`applyBoundEdit`, `toggleCategory`, `setPageSize`) and found the
reset-only-on-applied-change invariant holds on every surface, and confirmed
`applyFilterChange` and the guard test introduced no regression.

## Deferred / dismissed, with a path forward

- **`applyBoundEdit` reads the render closure.** Safe today: each
  `onValueChange` is one discrete, synchronously flushed event and there is no
  other writer of `customFrom`/`customTo`. The assumption is stated in the code
  comment. Revisit if a caller ever batches two edits for one bound.
- **Pre-existing reset callbacks outside #123** — `invoices.tsx:53,78`,
  `party-detail.tsx:396`, and `use-pagination.setPageSize`. Same class, not
  touched by this PR. Follow-up, not this lane.
- **The applied bound is not printed on `/expenses`.** A refused value keeps the
  last applied moment, which is invisible there; `/reports` prints its resolved
  range. Out of the three findings' scope. Follow-up.
- **`TanStack Query` `placeholderData`.** The installed skill recommends keeping
  the previous page visible during pagination. The list flashes its loading
  state on a real filter change. Out of scope for a review-fix round; noted.
- **Whitespace-only bound text** trims to empty and silently opens the bound.
  Pre-existing `editDateBound` semantics, unchanged by this PR.
- **RTL bidi run order** still has no automated assertion (browser-only,
  unchanged from #119).
