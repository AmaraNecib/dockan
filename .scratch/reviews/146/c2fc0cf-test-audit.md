# #146 test-audit evidence

- **Issue:** #146, one invoice-draft module behind the sale and purchase screens.
  This file covers the PR #188 review-fix round 2.
- **Tier:** Standard (test audit is required for Standard and High-assurance).
- **Base:** `origin/develop` @ `fc951133134a9b0b18b5ae38f9658665c29e73ec`
- **Evidence HEAD:** `c2fc0cf926bf57602715660ca9d264ba238b3e3c`
- **Supersedes:** `41c5fcd-test-audit.md`

## Provenance

An edge-case hunter, a coverage analyst and a test-quality reviewer each read the
round-2 delta and both submit paths at `a28acf2`. Their one substantive finding —
the discount arm is ordered after the payment check — was fixed in `c2fc0cf`
together with a red-before-green page test. The gates then re-ran at `c2fc0cf`.

## The behaviour under test

A typed payment must not shadow the real problem. The owner types a valid
payment, then breaks one of the inputs the total is derived from, so the total
falls to zero while the typed amount survives. The page must blame the broken
input, not the payment.

## Ordering matrix (verified by reading both submit paths)

| precedence | `sale.tsx` | `purchase.tsx` |
|---|---|---|
| 1 empty cart | `saleLinesEmpty` :245 | `purchasesLinesEmpty` :115 |
| 2 ambiguous party | `partyChooseExisting` :251 | :120 |
| 3 per-line, draft order | `saleInvalidOverride` > `saleInvalidQuantity` :260 | `purchasesInvalidQuantity` :132 |
| 4 discount | `saleInvalidDiscount` :270-279 | n/a |
| 5 payment | `saleInvalidPaid` :282 | `purchasesInvalidPaid` :139 |

The edge hunter walked the combinations: a bad quantity on a *later* line with
line 1 fine still beats the payment on both screens (`firstLineError` runs to
completion first); empty cart beats everything; a bad party beats the line
checks; a zero total from a free line or a 100% discount with an untouched pair
saves as `initialPaid: undefined`. All correct.

## Tests at `c2fc0cf`

| test | file:line | what it pins |
|---|---|---|
| blames the unusable quantity, not the payment… (purchase) | `purchase.test.tsx:809` | quantity arm on purchase; asserts total→0, `purchasesInvalidQuantity` present and `purchasesInvalidPaid` absent |
| blames the unusable quantity, not the payment… (sale) | `sale.test.tsx:1119` | quantity arm on sale |
| blames the unusable discount, not the payment… (sale) | `sale.test.tsx:1141` | **new in `c2fc0cf`** — discount arm; `saleInvalidDiscount` present, `saleInvalidPaid` absent |

All three assert the positive message *and* the absence of the payment message,
and assert `lastInvoiceInput`/`lastPurchaseInput` stayed null. The sale tests
assert through `i18n.t(...)`; the purchase test now does too (was hardcoded
Arabic before this round).

## Falsifiability (measured, not assumed)

- Restoring the pre-fix sources at `dfe1ed8` while keeping the new tests: the two
  quantity tests fail, both receiving the payment message.
- Moving only the discount block back after `resolveInitialPaid` in `sale.tsx`:
  `sale.test.tsx:1141` fails, receiving `أدخل مبلغاً صحيحاً غير سالب`
  (`saleInvalidPaid`) instead of `saleInvalidDiscount`.

Both runs were local, with the files restored afterwards; the tree was clean
before the evidence commit.

## Findings and disposition

| finding | risk | decision |
|---|---|---|
| discount validated after the payment (edge hunter ORANGE) | would mislead the owner | **Fixed in `c2fc0cf`**, red-before-green |
| Arabic-Indic quantity drafts rejected while the same digits are valid money (`parseQuantityDraft` is ASCII-only) | yellow/orange | **Deferred.** Pre-existing, unrelated to the ordering class; a separate issue. |
| no test for `1000001` / `-0` / `+1` boundaries | yellow | **Deferred** (test-only follow-up). |
| no multi-line "bad quantity on line 2" page test | yellow | **Deferred** (test-only follow-up); the unit level covers draft order. |
| override-vs-payment arm unpinned | yellow | **Deferred** (test-only follow-up); structurally ordered. |
| zero total from a free line / 100% discount untested | yellow | **Deferred** (test-only follow-up). |

## Quality grade

**A−.** Precise names, correct `act`/async discipline, real negative assertions,
numeric totals (no substring false-pass), no cross-test leakage, no vacuous
assertion found. The only deduction was the hardcoded-copy asymmetry in the
purchase test, which is now fixed.

## Verdict

The round-2 ordering behaviour is pinned on both screens for the quantity arm
and on sale for the discount arm; each pin is measured to fail without its fix.
The remaining gaps are boundary and arm coverage, none of which can mask a real
error today.
