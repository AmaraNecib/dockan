# #257 round 6 — close PR #266's one live finding, refute the stale one

Base: `feat-257-inline-product` @ `07fea5c0` (PR #266 head). Lane branch:
`feat-257-inline-product-round6`.

## Tier: Standard

One justification line: the diff closes a picker/focus hole (React state and an
effect) plus one test-sequencing refutation. It changes no quantity, cost or
ledger arithmetic, nothing under `apps/api/src/store/**`, no auth, no backup
path — so none of the five High-assurance failure modes is reachable. Standard
gates: guard 1 → quality check → guard 2 → Greptile. (The independent
`code-review` / `test-audit` / `debate` lenses are skipped this round by owner
instruction under the token budget; Greptile reviews the PR.)

## Finding 1 (valid) — a pick made from a picker the landing create replaced

`purchase-line-pick-*` is disabled only by `savePending`. A line create in
flight (`lineCreatePending.target === line.item.id`) leaves the picker live, so
the owner can open the picker for product A while A's create is out, the create
lands and re-points the line to B, and the pick of C then calls
`replaceItem(A, C)` — the reducer's `replaceDraftLineItem` finds no row named A
and returns the list unchanged. `pickItem` has already closed the dialog, so the
choice disappears silently.

### Fix: two mechanisms, because there are two routes

1. **The ordinary route is closed at the control.** The line's own picker is
   disabled while that line's create is pending
   (`savePending || lineCreatePending?.target === line.item.id`). This is
   Greptile's first option and it is scoped to the one line whose product is
   about to move; every other line's picker stays live.
2. **The belt route is closed in the landing.** The picker can still be OPEN
   when a create lands if it was opened while the form was open and the submit
   event came from somewhere no mouse reaches (the same class round 4 already
   belts: `submitLineCreate`'s `savePending` check, `pickItem`'s). So when the
   landing re-points the line the picker names, the picker is retargeted to the
   new product id instead of holding an id that is gone. The owner's search is
   preserved and his pick re-points the same row.

The retarget reads `pickerTargetRef`, because `submitLineCreate`'s async
callback closes over the render that submitted, not over the picker state the
owner opened afterwards. The same ref answers the second half of the landing:
when the picker keeps the caret, the landing must NOT `requestFocus("quantity")`
— a programmatic focus move would yank the caret out of the open dialog and
send the owner's next keystrokes to the line input behind it.

### Named assertion (red first)

`apps/web/src/pages/purchase.test.tsx`:
- `"disables a line's own picker while that line's create is in flight (round 6, F1)"`
  — the button is disabled during the pending window and no dialog opens (today:
  `disabled === false` and the dialog opens → red).
- `"keeps a pick made from a picker a landing create replaced (round 6, F1 belt)"`
  — with the picker open and the create landing under it, the picker still names
  the line, focus stays in the dialog, and the pick re-points the line while the
  typed quantity and cost survive (today: the pick is dropped → red).

## Finding 2 (valid) — the frozen-region landing is invisible

Round 5 redirects a cancel that races the in-flight save to the lines region
(`tabIndex -1`), and recorded the risk: programmatic focus does not match
`:focus-visible`, so a table focused by script shows **no** ring and the sighted
keyboard user has no idea where he is. Greptile's finding is the same defect in
other words ("the focus effect does not retry… keyboard users lose their
place").

### Fix: the landing is visible, and the caret returns when it can

1. **A visible focus indicator on the region.** `focus:outline-2
   focus:outline-offset-[-2px] focus:outline-ring` — the same utilities the
   debts list uses, but on `focus:` rather than `focus-visible:`, because the
   whole point is a script-issued focus that `:focus-visible` never matches.
   It is the only ring in the app written on `focus:` and the comment says why.
2. **A guarded retry**, which is Greptile's second option made non-theft. When
   the effect cannot land on the named control it records the request; when the
   freeze lifts, the caret goes back to that control — but only if
   `document.activeElement` is still the lines region, i.e. only if the owner
   has not moved on. A successful save still unmounts the whole draft in the
   same commit (the region then owns nothing), so the retry cannot fight the
   page's own save-completed swap; it fires on the error path, where the
   trigger comes back and the owner is still standing in the frozen table.

### Named assertion (red first)

- `"...and the region shows the caret"` inside the round-5 cancel test (unit):
  the region's class carries the focus ring.
- `tests/e2e/purchase-inline-product.spec.ts`, in the frozen test, immediately
  after `await expect(lines).toBeFocused()`: the computed `outline-style` is
  `solid` and `outline-width` is `2px` on a real browser (today: `none`/`0px` → red).
- Unit `"hands the caret back to the line's create button when the frozen save
  settles (round 6, F2)"`: after a cancel during the freeze, a failed save
  (harness `invoiceCreateFails`) re-enables the trigger and the caret is on it
  (today: stays on the region → red).

## Finding 3 (refuted — stale)

The finding describes `page.route(… setTimeout(…, 2500) …)`. That timer is not
in the file at the anchor head: round 5 (`5c19b2f`) replaced it with an explicit
promise gate plus a `finally` release and a `routePending` sequencing assertion
— exactly the change the finding asks for. Evidence: the code at
`tests/e2e/purchase-inline-product.spec.ts:282-296` and `:303`, `:324`, `:326`;
the comment at `:210-217` naming the discarded 2500 ms window;
`git log -S2500 -- tests/e2e/purchase-inline-product.spec.ts` (added `0fcbbcc`
round 4, removed `5c19b2f` round 5); and the round-5 slow-run ablation
`.scratch/reviews/257/r5-ablation-a2-old-timer-slow.log`, where a 6 s hold
passes against the gate and fails against the timer. Closed as refuted, not
re-implemented.

## Risks

- The retarget changes which row a pick lands on when the picker is open across
  a landing; the row is the very line the picker was opened from, so the
  semantic is "the picker follows its line", not "the pick follows a stale id".
- `focus:` (not `focus-visible:`) also rings the region on a mouse click into a
  cell's padding. Accepted: the region is a programmatic focus target and the
  indicator has to be unconditional to be an indicator at all.
- The video the evidence rule asks of a visual change is not recorded for this
  round: `playwright.config.ts` records the repo's decision (no video — per-test
  encoding cost on a sequential suite, `trace` already carries the DOM). The
  visual proof is the before/after screenshots of the focused region plus the
  computed-outline numbers.

## Planned tests

- Unit (jsdom, `bun run test`): the four named assertions above; the #257
  describe block re-run whole.
- E2E (Playwright, one spec): `tests/e2e/purchase-inline-product.spec.ts`.
