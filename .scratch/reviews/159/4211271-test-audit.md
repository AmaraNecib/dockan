# Test audit — #169 review-fix round (#159 / #160 / #166)

**Tier:** Standard
**Base:** `0b4ec68` (`origin/develop`)
**Reviewed delta:** `ec7f518..4211271` (PR #169 review-fix commit)
**Reviewed code:** `4211271`
**Gate artifact for HEAD:** the evidence commit that adds this file

Supersedes `ffde449-test-audit.md` (the pre-Greptile pair is kept as history).

## Scope of the delta

`tests/e2e/completion-screens.spec.ts`, `apps/web/src/pages/invoice.test.tsx`,
`apps/web/src/pages/invoice-returns.test.tsx`, plus the production change in
`apps/web/src/pages/invoice.tsx`.

## Greptile findings → disposition

| # | Pri | Finding | Fix | Test |
| --- | --- | --- | --- | --- |
| 1 | P1 | return card hardcoded «خُصم من الدَّين» + `debtOffset`, claiming a PENDING return's promise as already deducted | detail now renders `debtOffsetDisplay(status, debtOffset, debtApplied)` | pending test asserts «عند القبول» + 900 and NOT «مطبّق»; accepted test asserts «مطبّق» + 700 (applied ≠ promised 900) |
| 2 | P2 | `pmt-new` / `returns-new` remount the form but drop keyboard focus | ref + effect keyed on the saved state going null focuses the restored form's first enabled field | both success tests assert `document.activeElement` identity (`pmt-amount`, `returns-qty-بطارية`) |
| 3 | P2 | e2e only checked an `RTN-` prefix, so it did not prove the card opened *that* return | capture the card's `RTN-\d+` and compare to the voucher; record a second return and assert the second opens | `completion-screens.spec.ts` now asserts number equality and `secondReturn !== firstReturn` |

The old all-debt test that asserted the misleading «خُصم من الدَّين» text was
replaced (it encoded the bug).

## Verification round (independent, at `4211271`)

Two reviewers read the delta and re-ran the suite:

- `cd apps/web && bun test --max-concurrency=2` → **643 pass / 0 fail**, 3761 assertions, 50 files.
- P1: cash/value figures unchanged; only the debt segment is conditional;
  ACCEPTED shows `debtApplied`, PENDING shows `debtOffset` — matches the helper.
- P2: `restoreFocusPending` starts false, so no focus on initial mount and no
  re-render loop; it arms on save and consumes once.
- P3: verified the e2e logic (the reviewer could not run a browser; the lane
  ran the full Playwright suite instead, below).
- No missing `await`; the new assertions distinguish applied vs promised value
  and the real focused element.

## Commands

```
bun run typecheck            # 3 successful
bun run lint                 # 0 errors
bun run test                 # 643 pass / 0 fail
bun run test:e2e             # 47 passed (isolated ports 4406/5406, default .e2e-data)
```

## Residual notes (accepted, no blocker)

- `returnsSavedDebt` (i18n.ts) is now an unused key. Left in place: this
  review-fix round keeps `lib/i18n.ts` (shared with PR #168) untouched. It is
  harmless and carries real Arabic copy; a later cleanup can drop it.
- The e2e spec is logic-verified by the reviewer and executed green by the lane.
