# #123 — test-audit evidence

HEAD reviewed: `82ee0aeda6680f7a19a088d3609fd5472b8eeb5a` (base `origin/develop` @ `da44b50`).

Three read-only auditors (edge-case hunter, coverage analyst, quality reviewer)
plus a final audit pass. Grades: **A-** (round 1) and **B** (final pass, held
back only by the RTL gap and two e2e-thin assertions — no functional gap).

## Acceptance-criterion coverage

| Criterion | Where it is proven |
|---|---|
| A valid day-first value sets the same instant the old control did | `dates.test.ts` `editDateBound` pins `01/01/2020 00:00 → 2020-01-01T00:00:00` / `31/01/2020 23:59 → 2020-01-31T23:59:00` (the exact `withSeconds` output); `expenses.test.tsx` and `reports.test.tsx` assert the same literals on the captured query input; e2e `.fill("01/01/2020 00:00")` returns the backdated row |
| An impossible date is refused visibly and is not silently applied | `date-field.test.tsx` (no scolding mid-keystroke → blur → `aria-invalid`, `role="alert"`, shared copy, clears on correction); `dates.test.ts` keeps the prior bound through half-typed/impossible text; `expenses.test.tsx` asserts the refusal for **both** `from` and `to` and that the last applied bound survives; `reports.test.tsx` the same for `from` |
| «الآن» fills the current time | `date-field.test.tsx` asserts the value is within 90 s of `Date.now()` and `onNow` fires; `expenses.test.tsx` asserts the filled upper bound reaches the query; `reports.test.tsx` asserts the filled upper bound reaches the query |
| Both screens filter/report the same window; testids kept | Parallel per-screen describe blocks resolve identical input to identical ISO; every kept testid is exercised (`expense-custom-from/-to`, `report-custom-from/-to`, `expense-date`, `…-now`); e2e round-trips the report window onto `report-range-label` |
| `parseDateTimeText` rejects impossible calendar days (#119 follow-up) | `dates.test.ts:125` pins `29/02/2026`/`31/04/2026` → null and `29/02/2024` → valid. The fix is already in `develop` (`a0b9671`); #123 relies on it and re-asserts it at the field and page level |
| RTL | **No automated test** — bidi run order is not observable in happy-dom. Accepted; component keeps the #119 rule (no `dir` forcing). |

## Findings and disposition

| Finding | Action |
|---|---|
| Mid-typing text could widen the window (edge/coverage) | Fixed in `editDateBound`; pinned at unit, page and e2e level |
| `to`-bound refusal was untested | Added `refuses an impossible upper bound the same way` |
| Reports «الآن» assertion only checked `!== undefined` | Strengthened to `=== parseDateTimeText(value)` |
| Blur flag was sticky after the first blur | `blurred` resets on edit; matches the documented "not scolded mid-keystroke" claim |
| Copy-coupled literals in page tests | Page tests now use `i18n.t("expenseDateInvalid"|"expenseDateHint")` |
| `expect(parseDateTimeText("31/02/2020 00:00")).toBeNull()` inside a page test re-asserts `dates.test.ts` | Kept as an explicit "the #119 fix is present" marker, per the lane brief |
| Reversed range (`from > to`) has no client-side test | Accepted — no client validation exists; the api resolves the window |
| e2e comment claimed the window is retained but only asserts the refusal | Comment corrected; the retention claim is proven by the unit/page tests |
| RTL has no test | Accepted (browser-only), noted above |

## Test quality

- Names are descriptive and issue-tagged; no "does not crash" assertions.
- Controlled inputs are driven through the native value setter + `input`/
  `focusout` events; roots are registered for teardown even on assertion failure.
- No missing `await`; polling uses bounded `waitFor`, not fixed sleeps.
- No test was found that would still pass if the feature regressed (the
  regression-sensitive round-trip and no-widening assertions fail if the bound
  drops or the control reverts to `datetime-local`).
