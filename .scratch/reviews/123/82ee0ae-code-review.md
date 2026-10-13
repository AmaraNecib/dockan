# #123 — code-review evidence

HEAD reviewed: `82ee0aeda6680f7a19a088d3609fd5472b8eeb5a` (base `origin/develop` @ `da44b50`).
Two axes, reviewed independently by read-only sub-agents.

## Spec

Every requested item is implemented:

- **One shared validated day-first field.** `apps/web/src/components/ui/date-field.tsx`
  is the single `type="text"` control; all four remaining bounds adopt it
  (`expenses.tsx` `expense-custom-from/to`, `reports.tsx` `report-custom-from/to`),
  and the #119 record field was folded into it so there is genuinely one
  component, not two shapes.
- **Reuse, no re-implementation.** The component imports `parseDateTimeText` /
  `nowDateTimeText`; `formatDateTime` reaches it through `nowDateTimeText`. No
  `Date` parsing, no `Intl`, no `dir` forcing. `withSeconds` is deleted from both
  pages.
- **Same instants round-trip.** A bound is a `DateBound` folded by
  `editDateBound`: `01/01/2020 00:00 → 2020-01-01T00:00:00`, empty → open, and
  unreadable text keeps the previous bound. The api payload is byte-identical to
  the removed `withSeconds` path.
- **Impossible dates.** `parseDateTimeText` already rejects impossible calendar
  days in `develop` (`a0b9671`, #119 follow-up) and `dates.test.ts:125` pins it;
  #123 refuses the value visibly and does not apply it. No silent widening.
- **testids kept.** `expense-date`, `expense-custom-from/-to`,
  `report-custom-from/-to` are unchanged; `…-now`/`…-error` are additive.
- **i18n + RTL.** No new keys (`dateNow`, `expenseDateHint`,
  `expenseDateInvalid` reused); the field renders a plain text run in the RTL
  page with no direction override.
- **«الآن».** On every field, writes `nowDateTimeText()`, clears the field's own
  refusal, and reaches the query (asserted for the upper bound on both screens).

No scope creep. `.scratch/implementation/123-design.md` matches the code.

## Standards

- **Documented standards.** Source-only policy honoured (only `apps/web/src`,
  `tests/e2e`, and `.scratch` change; no lockfiles/artifacts). Unit + Playwright
  tests ship in the same change. SAFETY comments satisfy the anti-slop rules;
  oxlint and `tsc` are clean.
- **Fowler baseline.** `Duplicated Code`: the two label+`DateField` blocks per
  page are near-identical — accepted; a `DateRangeFields` abstraction for two
  pairs would be premature. `Primitive Obsession`: improved — a bound is a
  `DateBound`, not a raw string. `Divergent Change`: `DateField` encodes two
  refusal modes keyed on `errorId === undefined`, documented in the component
  header; legible as-is, split if a third caller appears. `Speculative
  Generality`: the unused `className` prop was removed and `nowTestId` derived.
  No other baseline smell was found.
- **Repo process.** Review evidence lives at `.scratch/reviews/123/<sha>-*.md`;
  `docs/engineering-workflow.md` gate order was followed (design → TDD → guard 1
  → quality → debate → test-audit → code-review → guard 2).

## Verdict

Final pass: **no blockers, no new regressions — ship it.** Remaining items are
accepted notes (RTL is browser-only; bare-date-`to`/reversed-range follow the
shared parser and the api; one latent a11y nit with no reachable trigger), all
recorded in `5707a37-debate.md`.
