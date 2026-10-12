# Test audit (delta) — #171 review-fix round

- PR base: `54a754b`
- Delta base: `4020982`
- Fix commit: `62a8dfb`
- Follow-up fixes: `943c9a01`
- Final evidence SHA: `22bc6208`
- Tier: High-assurance

Three reviewers (edge-case hunter, coverage analyst, test-quality reviewer)
audited the fix commit. This records the gaps and their closure.

## Coverage of the six Greptile findings

Every finding now has a regression test that fails without the fix:

| Finding | Test | Fails without the fix because |
|---|---|---|
| 1 return relink | `invoice-returns.test.tsx` "relinks… (#171)" | the stale amount stays 450 after the value doubles to 1800; the test asserts 900. |
| 2 settle double-submit | `party-detail.test.tsx` "holds the submit guard… (#171)" | the gated refetch lets a raw second submit record a second payment; asserts `payInputs` length 1. |
| 3 invalid percentage | sale/purchase/returns/settle tests | the invalid draft clears the amount and the save proceeds; asserts the error/`aria-invalid` and `lastInput === null`. |
| 4 zero purchase payment | `purchase.test.tsx` "omits initialPaid…" | `initialPaid: 0` is sent; asserts `undefined`. |
| 5 full discount | `sale.test.tsx` "recomputes… zero…" | the stale 500 is sent; asserts the save went through and `initialPaid` is `undefined`. |
| 6 purchase tests | `purchase.test.tsx` new suite | n/a (coverage). |

## Gaps found and fixed in the follow-up commit

- **The settle invalid-percentage guard had no test.** Added: types `12.5`,
  asserts `aria-invalid`, a disabled Confirm, a live error, and that a raw form
  submit records nothing.
- **The halted raw-submit bypass had no test.** The existing halted test clicked
  the (disabled) button. Added a raw `submit` dispatch after the mid-loop
  failure and asserted no further payment — this failed before the guard fix.
- **Sale/purchase over-total guards had no test.** Added one each: an amount
  above the cart total shows the error and sends nothing.
- **The return value→0 percentage case had no test.** Added: 50% of 900, then
  clear the line → cash `0`, no reference line.
- **Two vacuous assertions.** `expect(lastInput?.initialPaid).toBeUndefined()`
  also passes when a guard blocked the save. Added
  `expect(lastInput).not.toBeNull()` before each.
- **Weak reference assertion.** `toContain("1800")` → `toContain("1800 دج")`.

## Deferred (minor)

- Extract the repeated `setValue`/native-setter helper and the purchase
  `mountPurchase`/`addQuickLine` harness into a shared test util (test-only
  duplication).
- The new purchase suite duplicates the #159 harness rather than reusing it.
- A focused unit assertion on the component's second `onChange` argument
  (`edited`); it is currently covered indirectly through the page tests.

## Verdict

All six findings have non-vacuous regression coverage; the delta-review gaps are
closed. No shallow or duplicate coverage remains after the fixes.
