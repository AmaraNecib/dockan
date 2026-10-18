# Debate (final delta) — #171 review-fix round 2

- PR base: `54a754b`
- Delta base (previous head): `38e3fa5`
- Fix commits: `7e110cf` (relink both panels), `7ffd272` (edge tests + per-invoice reseed), `25fd822` (explicit invalid-percentage guard + reseed coverage)
- Final evidence SHA: `dbbb0be5`
- Tier: High-assurance

Reviewers: a 6-agent round (harsh critic + standards + spec + edge-case hunter +
coverage analyst + test-quality) on `7e110cf`, then a focused 3-agent round
(critic + coverage + quality) on `7ffd272`.

## Greptile findings

**Finding 1 — reference-change relink.**
- The `ReturnsPanel` example is **stale**: it already had `cashSource` and a
  source-tracked relink effect (`invoice.tsx` ~309/~379); 50% of 900 → 1800
  yields 900. **Not changed**, as instructed.
- The **real gap** was `PaymentPanel` (seeded once, no source tracking) and
  `CustomerSettlePanel` (seeded once). Both now carry a source ref and a relink
  effect keyed on the reference: untouched pair follows the new reference at
  100%, an edited amount stays the source, an edited percentage rescales, and a
  percentage-based draft falls to zero with the reference. **Fixed.**

**Finding 2 — vacuous purchase test.** The second save's assertions read
`lastPurchaseInput`, which still held the first purchase, so they passed even if
the second save failed. **Fixed:** `clearPurchaseRecorder()` before the second
save (plus a helper to defeat TS control-flow narrowing), so the case proves its
own request was sent.

## Delta-review findings and disposition

| Finding | Sev | Disposition |
|---|---|---|
| `PaymentPanel` relied on an incidental invariant (invalid percentage ⇒ empty amount ⇒ INVALID) instead of guarding `percentageInvalid` explicitly. | cosmetic | **Fixed** (`25fd822`): explicit guard in `submit`, in the submit button's `disabled`, and the field's `aria-invalid`. |
| `key={invoice.id}` had no test; an untested behaviour change. | minor | **Fixed** (`25fd822`): a test moves the route to a *cached* different invoice (so no pending unmount) and asserts the panel reseeds to the new remaining instead of carrying the edited draft. |
| Reference→0 untouched / edited-amount sub-branches untested; percentage through 0 and back untested. | minor | **Fixed** (`7ffd272`): added for both panels. |
| "Blocked, not sent" claims asserted only the field value. | cosmetic | **Fixed** (`25fd822`): assert the disabled/absent submit and `aria-invalid`. |
| Invalid percentage + reference change untested. | minor | **Fixed** (`7ffd272`/`25fd822`): added for both panels. |
| Over-reference amount renders `amount > reference` with `100%`. | cosmetic | **Kept, documented:** the amount is the last-edited source; the amount field is flagged and every consumer rejects the over-total amount before sending. |
| The relink state machine now exists in five places. | judgement | **Deferred:** a shared `useLinkedReference` hook is the right cleanup; out of scope for this round. |
| `CustomerSettlePanel` does not reset its source on success. | cosmetic | **Dismissed:** the panel unmounts on `onDone`; no reachable stale state. |

## Verdict

Both Greptile findings are fixed; the one stale example (ReturnsPanel) was
verified and deliberately left untouched. The delta review found no blockers in
the fix set; its cheap hardening and coverage notes are all applied. No
unresolved blocker.
