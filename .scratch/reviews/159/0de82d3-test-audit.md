# Test audit — #169 review-fix round 2 (#159 / #160 / #166)

**Tier:** Standard
**Base:** `957d059` (`develop`, rebased; PR base `origin/develop`)
**Reviewed delta:** `a5020e5..0de82d3`
**Reviewed code:** the focus fixes at `d6ea827`; `0de82d3` corrects only their
comment
**Gate artifact for HEAD:** the evidence commit that adds this file

Supersedes `4211271-test-audit.md` and `ffde449-test-audit.md` (both kept as
history).

## Scope of the delta

`apps/web/src/components/ui/success-card.tsx`, `apps/web/src/pages/invoice.tsx`,
`apps/web/src/pages/invoice.test.tsx`, `apps/web/src/pages/invoice-returns.test.tsx`.

## Greptile round-2 findings → disposition

| # | Finding | Fix | Test |
| --- | --- | --- | --- |
| 1 | a successful save unmounts the submitting control and focus is lost; the focus effects returned early while the card was shown | `SuccessCard` gained `containerRef` + `tabIndex={-1}`; both panels focus the card on the form → card transition | after save, `document.activeElement` is `pmt-done` / `returns-done` |
| 2 | the last payment leaves every field disabled; the first-enabled-input lookup found nothing and still cleared the pending flag, losing focus | the «مسدّدة بالكامل» message is the focusable fallback (`paidOffRef`, `tabIndex={-1}`); the flag clears only when `document.activeElement` actually moved | a full-payment test re-renders with remaining 0, clicks `pmt-new`, and asserts focus on `pmt-unavailable` |

The three re-printed Greptile items (P1 pending-debt wording, card→form focus,
e2e voucher identity) are the already-fixed round-1 findings; ignored per the
round-2 brief.

## Mutation check

Removing `cardRef.current?.focus()` from `invoice.tsx` makes the two new
card-focus tests fail (`bun test src/pages/invoice.test.tsx`: 2 fail), then the
code was restored and went green. The paid-off test fails without the
`paidOffRef` fallback because `first` is `undefined` and focus stays on `body`.

## Verification round (independent, on the delta)

Two reviewers read the delta and re-ran the suite:

- `cd apps/web && bun test --max-concurrency=2` → **658 pass / 0 fail**, 3844 assertions, 51 files.
- Finding 1: `tabIndex={-1}` is new in this commit and only the panels focus
  the card, so the tests cannot pass without the fix; no focus steal on initial
  mount (the flag starts false) and no re-render loop (focus writes no state).
- Finding 2: the paid-off fallback is reachable and focusable; the flag is
  consumed only on a real move.
- `tabIndex={-1}` on the shared card is inert for sale/purchase (they never
  pass `containerRef`) and keeps every card out of the tab order.

## Commands

```
bun run typecheck            # 3 successful
bun run lint                 # 0 errors
bun run test                 # 658 pass / 0 fail
bun run test:e2e             # 48 passed (isolated ports 4407/5407, default .e2e-data)
```

## Residual notes (accepted, no blocker)

- The `ReturnsPanel` early-return when no enabled input exists is unreachable
  today: the reason input (and, in a custom split, the cash input) is always
  enabled whenever the form renders, so `first` is never `undefined`. The
  payment panel, which really can have every field disabled, has the fallback.
- Reviewers suggested the comment "a later render can retry" was inaccurate
  (the effect deps are `[savedPayment]`); corrected in `0de82d3`.
- `returnsSavedDebt` in `lib/i18n.ts` remains an unused key (shared file with
  PR #168); left as-is.
