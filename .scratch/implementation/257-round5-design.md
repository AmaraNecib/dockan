# #257 round 5 — the two comments PR #266's 5/5 review still listed

Base: `feat-257-inline-product` @ `2b5504ae` (PR #266 head). Lane branch:
`feat-257-inline-product-round5`.

## Tier: Standard

One line of the diff can break the stock-quantity failure mode (it lands a
product on a purchase line), but this round changes **no** quantity, cost or
ledger arithmetic: the diff is a focus fallback in a React effect, one `tabIndex`
/ `aria-label` pair on an existing table, a unit test and an e2e sequencing
change. Nothing under `apps/api/src/store/**`, no auth, no backup path. Standard
gates: guard 1 → quality check → test-audit → code-review → guard 2 → Greptile →
guard 3.

## Issue 1 — cancel during a slow save loses keyboard focus (product)

### The defect

`closeLineCreate()` hands the caret back to the line's create trigger with
`requestFocus("trigger", itemId)`, and the focus effect calls `.focus()` on it.
Round 4 set `disabled={savePending}` on that trigger (a create would re-point a
line the in-flight request already serialised), and a disabled button cannot take
focus: `.focus()` on one is a no-op. The form has just unmounted out from under
the caret, so `document.activeElement` becomes `document.body` and the keyboard
user restarts from the top of the page.

Round 2's constraint stands: Cancel stays enabled, because a hung write must not
trap the owner. The fix is where the focus GOES, not whether Cancel works.

### Where the focus goes, and why

**Decision: the request is REDIRECTED in the same commit to the lines region,
not deferred until the trigger re-enables.**

- The lines region (`[data-testid="purchase-lines"]`) is the only candidate the
  brief offers that is *actually* enabled during the freeze. Read the controls
  during `savePending`: the line's picker is `disabled={savePending}`, the save
  button is `disabled={createInvoice.isPending || …}`, every line input and the
  row's remove button are disabled too. A candidate that cannot take focus is not
  a candidate.
- The region is the owner's context: the line he was editing is inside it, its
  accessible name is the section's (`purchasesLinesTitle`), and the
  `role="status"` line directly below states *why* the controls are dead
  (`purchasesSaveInFlight`) — a frozen region with no stated reason is the dead
  end the round-4 comment already refused to accept.
- Tab from the region continues into the first enabled control once the save
  settles (the first row's picker), so the region is not a dead end either.
- **No deferred restore.** Greptile's second option — "restore it when the
  trigger becomes available" — is focus theft: by the time a slow save answers,
  the owner may have tabbed on or started typing, and a late `.focus()` would yank
  the caret out of whatever he is doing. WCAG 2.4.3 asks that focus not be *lost*;
  it does not ask for a delayed grab. Landing it once, immediately, at a stable
  enabled anchor keeps the tab order predictable.
- The wisdom lesson `2026-10-16-refusal-guard-must-record-the-ask` is applied by
  asking its question — *"who will re-ask?"* — and answering it structurally: the
  guard does not refuse, it redirects, so there is nothing left to re-ask and no
  bit of pending state to get wrong. A deferred re-ask would also be the theft
  above.

The trigger is a button the browser cannot put focus on; the region is a table
made focusable **only** by `tabIndex={-1}` (programmatic target, not a tab stop),
with `aria-label={t("purchasesLinesTitle")}` so the focus move is announced as a
region rather than an unnamed box. No new i18n key.

The *quantity* branch of the same effect gets the fallback for free: it is not
reachable with a frozen input today (a create or a pick both refuse while
`savePending`), but a focus request that names an unmounted or disabled control
now lands somewhere instead of nowhere.

### Named assertion

`apps/web/src/pages/purchase.test.tsx`:
`"lands the caret on the lines region when a cancel races the in-flight save (round 5, F1)"`
— asserts `document.activeElement` is **not** `document.body` and **is**
`[data-testid="purchase-lines"]`, with the named trigger asserted disabled first
so the test states why the redirect is needed.

`tests/e2e/purchase-inline-product.spec.ts`, in the round-4 frozen test:
`await expect(page.getByTestId("purchase-lines")).toBeFocused()` after the
cancel, in a real browser.

### Ablation

Revert the effect to `?.focus()` on the named target only → the new unit test
must fail on `expect(document.activeElement).not.toBe(document.body)`.

## Issue 2 — the frozen-state e2e can flake (test quality)

`page.route("**/api/rpc/invoicesCreate", … setTimeout(…, 2500) …); route.continue()`
makes the frozen window a wall-clock bet: the checks have to finish inside 2.5 s
or the save completes, the page removes `purchase-lines-frozen`, and correct
behaviour fails the test. The failure it produces is indistinguishable from a
product bug on a slow runner.

### The fix

An explicit gate. The handler sets `routePending = true`, awaits a promise the
test resolves, then continues:

- `expect(routePending).toBe(true)` after the frozen-state checks proves those
  checks ran while the request was *still held* — sequencing, not a stopwatch.
  If a timer (or a bug) released it early, the frozen assertions fail first and
  this one names the sequencing.
- The release sits in a `finally`, so a throwing assertion cannot hand the next
  test a hanging route.
- Nothing in the spec reads the clock afterwards; the hold's length is however
  long the checks take.

### Proof it is no longer timing-dependent

1. Structural: the sequencing assertion above.
2. Slow-run: an artificial 6 s hold inserted before the frozen checks — longer
   than the old 2500 ms window — passes with the gate and fails against the old
   timer. Both runs recorded in `.scratch/reviews/257/<sha>-evidence.md`.

## Risks

- Focusing a `<table tabindex="-1">` shows no focus ring (programmatic focus does
  not match `:focus-visible`), so the move is silent for a sighted keyboard user
  and the frozen status line is the only cue. Accepted: the alternative candidates
  are disabled, and the region is where the owner already was. Stated in the code
  comment rather than hidden.
- Adding `aria-label` to the table changes its accessible name; the e2e locators
  in this spec address rows and cells by role/name, not by table name, so they are
  unaffected.
- The cancel-during-freeze step lives inside the round-4 e2e test (which already
  holds the write open) instead of a new test with its own ~15 s seed. The frozen
  state under test is the same state; the failure line still names the cancel.

## Planned tests

- Unit (jsdom, `bun run test`): the new caret-fallback test above; the existing
  round-4 quartet and the round-2 save-block test re-run by name.
- E2E (Playwright): the round-4 frozen test with the gate, the sequencing
  assertion and the cancel-focus assertion.
