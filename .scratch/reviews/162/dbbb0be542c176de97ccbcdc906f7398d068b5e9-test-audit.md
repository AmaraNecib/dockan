# Test audit (final delta) — #171 review-fix round 2

- PR base: `54a754b`
- Delta base: `38e3fa5`
- Fix commits: `7e110cf`, `7ffd272`, `25fd822`
- Final evidence SHA: `dbbb0be5`
- Tier: High-assurance

Three test-audit reviewers (edge-case hunter, coverage analyst, test-quality)
ran on the fix commits. A coverage analyst verified the relink tests by
counterfactual: neutralizing the two `useEffect` blocks made all eight relink
tests fail, then the tree was restored.

## Required cases — covered and fix-sensitive

| Panel | Case | Test | Assertion |
|---|---|---|---|
| PaymentPanel | untouched follows | "follows the new remaining under an untouched pair" | amount `900`, percentage `100` |
| PaymentPanel | edited amount | "keeps an edited amount as the source…" | amount `300`, percentage `33` |
| PaymentPanel | edited percentage | "keeps an edited percentage as the source…" | percentage `50`, amount `450` |
| PaymentPanel | percentage → 0 | "zeroes a percentage-based draft…" | amount `0` |
| PaymentPanel | untouched → 0 | "clears an untouched pair when the remaining falls to zero" | amount `""`, no percentage field |
| PaymentPanel | edited amount → 0 | "keeps an edited amount when the remaining falls to zero…" | amount `300`, `aria-invalid`, disabled, no submit |
| PaymentPanel | invalid % across change | "keeps an invalid percentage flagged across a reference change" | amount `""`, percentage `12.5`, `aria-invalid` |
| PaymentPanel | invoice switch | "reseeds the payment panel when the route moves to a cached different invoice" | amount `900` (not the carried `300`) |
| CustomerSettlePanel | untouched / amount / percentage / →0 | the four relink tests | as above |
| CustomerSettlePanel | untouched → 0 | "clears an untouched pair…" | amount `""` |
| CustomerSettlePanel | edited amount → 0 | "keeps an edited amount when the unpaid total falls to zero" | amount `400`, confirm disabled |
| CustomerSettlePanel | percentage through 0 and back | "relinks a percentage draft through a zero and back up" | `500 → 0 → 50% / 1000` |
| CustomerSettlePanel | invalid % across change | "keeps an invalid percentage flagged across a reference change" | amount `""`, `aria-invalid` |

## Vacuous purchase test — now genuine

`purchase.test.tsx` "omits initialPaid for 0% and for a percentage that rounds
to zero": `clearPurchaseRecorder()` runs before the second save, so
`expect(lastPurchaseInput).not.toBeNull()` can only pass if the second save
issued its own request. The helper exists to defeat TypeScript's control-flow
narrowing of the module variable after a direct `= null`.

## Notes / deferred

- The two relink helpers (`renderControlled`, `renderSettle`) duplicate the
  files' existing render scaffolds; a shared test util is a follow-up.
- Pre-existing `act` warnings in the PaymentPanel suite (Radix Select
  scheduling), not a regression.
- Arabic-Indic digits remain unsupported by the parsers (app-wide ASCII policy).

## Verdict

Every brief-required case has a non-vacuous regression test, and the
delta-review coverage gaps (reference→0 branches, double change, invalid
percentage across a change, the per-invoice reseed) are closed.
