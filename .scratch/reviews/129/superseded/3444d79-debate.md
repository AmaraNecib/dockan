# Debate evidence — issue #129 (round 1 review-fix, High-assurance)

**Base:** `21dbc13f13d1889646f4466e610decf5a077253b` (`origin/develop`).
**Reviewed/worktree SHA:** `3444d79220170a5be4d274987202158ffc1277e0`.
Product code unchanged since `0631081c1a30ac6e0df37b046f95064407985e9d`; the
round-1 delta is the e2e spec.

The prior debate (critic vs defender over `21dbc13…7f0540a`) resolved its six
product-code findings at `0631081`; nothing in this round touches that code, so
those dispositions stand. This round's adversarial item is the vacuous-test
class Greptile raised against the new spec.

## Critic (this round)

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| R1 | 5 | `afterEach` can skip saved customers and does not await the last delete. | **Fixed.** ACKED-list presence, per-delete `actAndAck`, fresh-read verification. |
| R2 | 5 | `toHaveValue(pickerName)` passes before the save, so a broken selection is invisible. | **Fixed.** Query and record names differ; mutation that skips `pick()` makes the test fail. |
| R3 | 2 | Normalisation asserted from a row that renders the folded local form either way. | **Fixed.** Asserted from the ACKED raw payload; confirmed the store's `listParties` returns the stored column untouched. |

## Defender

- The `actAndAck`-before-click and ACKED-payload patterns are the repo's
  established #189/#179 discipline; the spec now matches the proven
  `customer-name-variants.spec.ts` seam.
- Cleanup remains defensive: it verifies the server state, so a skipped or
  failed delete fails the test instead of leaking into the shared sqlite DB.
- The remaining audit items are missing breath (landline/separators/extended
  digits/server-boundary POST), each already owned by unit or router tests;
  adding them here would duplicate coverage, not close a test defect.
- Selection is proven by the record name rather than the id; `pick()` is the
  single assignment site for both, and the realistic mutant is covered.

## Verdict

No open product-code findings. The two Greptile findings are fixed and
mutation-proven; the residual gaps are documented, deliberate, and out of round
scope.
