# #257 round 5 — evidence

Issue: **#257** · PR: **#266** (`feat-257-inline-product` → `develop`)
Base: `2b5504ae` (PR head at the start of this round)
Lane: `feat-257-inline-product-round5`
Tier: **Standard** (see `.scratch/implementation/257-round5-design.md` for the
one-line justification)

Commit trail on this branch:

| commit | content |
|--------|---------|
| `5c19b2f` | the two fixes + the unit test + the design doc |
| `a9b6f6d` | the response to the independent test-audit and code-review run on `5c19b2f` (2 Medium findings fixed, 3 notes, comments corrected) |

Round 4 scored 5/5 and still listed two comments. The owner treats a listed
comment as outstanding regardless of the score, so this round closes both.

## Issue 1 — cancel during a slow save lost keyboard focus

**Fix.** `apps/web/src/pages/purchase.tsx`: the focus effect resolves its named
target and only calls `.focus()` when that target is *enabled*; otherwise it lands
on the lines region — `[data-testid="purchase-lines"]`, now
`tabIndex={-1}` + `aria-label={t("purchasesLinesTitle")}` +
`aria-describedby` to the frozen status line (a programmatic focus target, not a
tab stop, no new i18n key). The request is redirected when the effect runs — one
immediate landing, no deferred retry (a delayed restore would be focus theft — the
full reasoning is in the design doc). `Cancel` is untouched and stays enabled.

**Named assertion, unit.** `apps/web/src/pages/purchase.test.tsx` →
`lands the caret on the lines region when a cancel races the in-flight save (round 5, F1)`:

```
expect(document.activeElement).not.toBe(document.body);
expect(document.activeElement).toBe(container.querySelector('[data-testid="purchase-lines"]'));
expect(region?.getAttribute("aria-describedby")).toBe(container.querySelector('[data-testid="purchase-lines-frozen"]')?.id);
expect(region?.getAttribute("aria-label")).toBe(i18n.t("purchasesLinesTitle"));
```

It asserts the named trigger is `disabled` first, so the test states why the
redirect is needed.

**Named assertion, e2e.** `tests/e2e/purchase-inline-product.spec.ts`, in
`purchase line: the frozen draft and the cancel that outlives it (#257 rounds 4-5)`:
`await expect(lines).toBeFocused()` after `line-product-cancel` is clicked while
the invoice write is held.

## Issue 2 — the frozen-state e2e could flake

**Fix.** The held `invoicesCreate` is released by an explicit promise, not a
2500 ms timer. Sequencing, plainly:

1. the route handler sets `routePending = true` and `await`s the gate;
2. `expect.poll(() => routePending, { timeout: 15_000 }).toBe(true)` confirms the
   request is held before any frozen-state check reads the page (the bound is
   explicit: a wait-for-true recovers on a slow runner, a race does not);
3. every frozen-state assertion and the cancel leg run while the handler is still
   suspended on the gate;
4. `expect(routePending).toBe(true)` states that those checks ran while the
   request was still held — sequencing, not a stopwatch;
5. `releaseRoute()` runs in a `finally`, so a throwing assertion cannot leave a
   hanging route for the next test.

No assertion in the spec reads the clock: `rg -n 'setTimeout|waitForTimeout'
tests/e2e/purchase-inline-product.spec.ts` → no matches.

## Failing-first run (red before, green after)

Ablation A1 — the pre-fix effect (`if (target !== undefined) target.focus();`),
new unit test, `cd apps/web && bun run test -- purchase.test.tsx -t "lands the caret on the lines region"`:

```
apps/web/src/pages/purchase.test.tsx:1467
      expect(document.activeElement).not.toBe(document.body);
error: expect(received).not.toBe(expected)
Expected: not HTMLBodyElement { … }
exit 1
```

Re-run once more after the review-response commit; still exit 1, same assertion.
Log: `.scratch/reviews/257/r5-ablation-a1.log` (the multi-megabyte jsdom body dump
is elided in the file; the failing assertion line and the expectation are intact).

Green after the fix: same command → **51 pass, 0 fail, 275 expect() calls, exit 0**.

## Ablation table

Each row was run on this tree and then reverted. Logs under
`.scratch/reviews/257/`.

| # | variant | assertion under test | result | log |
|---|---------|----------------------|--------|-----|
| A1 | pre-fix effect (no fallback) | unit: `document.activeElement` is not the body | **red** exit 1 | `r5-ablation-a1.log` |
| A2 | round-4 timer (2500 ms) + 6 s artificial slow-check hold | e2e: `purchase-lines-frozen` visible | **red** exit 1; `routePending` logged `false` while the checks ran | `r5-ablation-a2-old-timer-slow.log` |
| A3 | new gate + the same 6 s slow-check hold | whole frozen leg, e2e | **green** exit 0; `routePending` logged `true` | `r5-ablation-a3-gate-slow.log` |
| A4 | pre-fix effect + new gate | e2e: `lines` focused | **red** exit 1 (`expect(locator).toBeFocused() failed`) | `r5-ablation-a4-prefix-focus.log` |

A2 vs A3 is the wall-clock proof the brief asked for: a hold longer than the old
2500 ms window fails the old design and passes the new one. A2 also shows the
sequencing guard discriminates — `routePending` was `false` while the checks ran.
A4 shows the e2e focus assertion bites in a real browser, so the guard is not a
jsdom artefact.

## Guards that must not have regressed

Re-run on `a9b6f6d` inside `bun run test`, all `(pass)`:

- `refuses to re-point a line while the invoice save is in flight (round 4, F1)`
- `refuses a line-create submit that no disabled button produced (round 4, F1 belt)`
- `refuses a catalog pick that would re-point a line under the in-flight save (round 4, F1 belt)`
- `freezes the rest of the invoice draft while the save is in flight (round 4, F1)`
- `blocks the invoice save while a line create is in flight (round 2, F2)`,
  plus its four round-2 siblings (`frees the invoice save when the owner cancels
  the create in flight`, `lets only one create be in flight, so the save gate
  holds a single slot`, `frees the save when the create fails while the form is
  still on its line`, `does not let a create in flight re-point the line that
  re-adds its deleted item`)
- `returns the caret to the line's create button when the form is cancelled`
  (the un-frozen path still hands the caret to the trigger)

## Commands and exit codes (all on `a9b6f6d`)

| command | exit | notes |
|---------|------|-------|
| `bun run typecheck` | 0 | 4/4 turbo tasks |
| `bun run lint` | 0 | oxlint, no output |
| `bun run test` | 0 | 4/4 tasks; web 1335 pass / api 950 / desktop 68 / e2e-support, `0 fail` everywhere |
| `DOKAN_PORT=4700 DOKAN_WEB_PORT=5700 bun run test:e2e -- purchase-inline-product.spec.ts` | 0 | 3 passed (13.7 s / 6.1 s / 5.3 s) |
| `cd apps/web && bun run test -- purchase.test.tsx` | 0 | 51 pass, 0 fail, 275 assertions |

Logs: `r5-typecheck.log`, `r5-lint.log`, `r5-test-all.log`, `r5-e2e-green.log`.
The e2e runs held slot 1 of the shared `e2e-slot.sh` (ports 4700/5700).

## Review evidence

- `a9b6f6d-test-audit.md` — independent test audit (run on `5c19b2f`), verdict
  PASS, findings and dispositions.
- `a9b6f6d-code-review.md` — independent Standards + Spec review (run on
  `5c19b2f`), verdict SHIP, 2 Medium findings fixed in `a9b6f6d`.

## Images

The change is **not visual**: the caret moves onto a `<table tabindex="-1">` and
programmatic focus does not match `:focus-visible`, so no focus ring appears (the
`draft-during-save.png` frame confirms it). The proof is therefore the assertions
and the ablation table above, not a clip — the reasoning `playwright.config.ts`
already records for keeping video off ("it adds per-test encoding cost on a
sequential suite without answering anything the trace leaves open"). The e2e still
records its two frames, copied to `.scratch/reviews/257/screenshots/round5/`:
`draft-live-before-save.png` (controls live, create form open, typed line) and
`draft-during-save.png` (frozen controls, the create form still open, and the
stated reason line at the bottom).

## Decisions taken

1. **Redirect, do not defer.** The lines region is the only candidate left enabled
   by the freeze (picker, save button, line inputs and remove buttons are all
   `disabled={savePending}`), it holds the line the owner was editing, and a
   deferred restore would steal the caret from wherever he had moved on to. The
   applied wisdom lesson `2026-10-16-refusal-guard-must-record-the-ask` is
   answered structurally: the guard does not refuse, so there is no ask to record
   and no pending bit to get wrong.
2. **`tabIndex={-1}` + `aria-label` + `aria-describedby` on the table**, so the
   focus move is announced as a named region *and* carries the reason its controls
   are dead. No new i18n key.
3. **The cancel leg lives in the round-4 frozen test** rather than a new e2e test:
   it needs the same held write, and a second test would duplicate ~15 s of seed
   for one extra assertion.

## Observed, not fixed (out of this round's scope)

When the save lands, `draft.reset()` empties the lines and the success card
replaces the form, so the focused region unmounts and focus returns to
`document.body`. That is the page's existing save-completed swap (every successful
save on this screen does it), it is not one of the two listed comments, and
changing it would move the caret under the success card for sale and purchase
alike. Flagged by the independent test audit as well. Reported so the parent can
decide whether to open a follow-up.
