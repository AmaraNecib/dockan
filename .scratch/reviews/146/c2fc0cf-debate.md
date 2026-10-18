# #146 debate evidence (critic + defender)

- **Issue:** #146, one invoice-draft module behind the sale and purchase screens.
  This file covers the PR #188 review-fix round 2.
- **Tier:** Standard. Debate was run at the lane's request in every round.
- **Base:** `origin/develop` @ `fc951133134a9b0b18b5ae38f9658665c29e73ec` (merge-base)
- **Evidence HEAD:** `c2fc0cf926bf57602715660ca9d264ba238b3e3c`
- **Supersedes:** `41c5fcd-debate.md`

## Provenance

| round | reviewed | children | outcome |
|---|---|---|---|
| 1 | `6c6e9f4` | critic + defender | 15 findings, applied in `e231b47` |
| 2 | `e231b47` | critic + defender | 5 nits, applied in `6e0d153` |
| 3 | `cdf32c6` | critic + defender | 10 findings, applied in `4f1d810` |
| verification | `4f1d810` | critic + defender | 7 findings, applied in `41c5fcd` |
| **4 (this round)** | **`a28acf2`** | **critic + defender** | **1 major + notes; major fixed in `c2fc0cf` (this HEAD)** |

The critic and defender read `git diff dfe1ed8..a28acf2` (the round-2 delta), the
full changed files, the brief at
`D:/projects/mani-project/.scratch/sessions/crew/briefs/feat-146-greptile-round2.md`,
design doc section 8, and the `41c5fcd-*` evidence. Both were asked explicitly to
check the ordering on **both** screens, not only the changed one.

## The findings this round fixes

**Finding 1 — a payment error masked a bad quantity (purchase).** `purchase.tsx`
resolved the initial payment (including the amount-vs-total check) before it
validated the line quantities. Clearing a quantity after typing a payment drops
`total` to zero while the typed amount survives (`nextPaymentPair` keeps an
`amount`-sourced pair at `total === 0`), so `resolveInitialPaid(0, "1200")`
rejects and the page blamed `purchasesInvalidPaid` for a cart whose real problem
was `purchasesInvalidQuantity`. Fixed in `a28acf2`.

**Finding 1b — the same mask for sale's discount (found by the critic).** The
reorder above fixed the quantity arm but left sale's discount validation *after*
the payment. The discount is a second input to `total` (`draftTotals` subtracts
`discountAmountFor`), and an over-100% percentage is capped at the subtotal, so
`150` also drops `total` to zero while the typed amount survives. The owner saw
`saleInvalidPaid` for a bad discount. Fixed in `c2fc0cf`: sale now validates
lines → discount → payment (`sale.tsx:254-285`).

**Finding 2 — duplicated policy comment.** The comment block above
`QuickAddSpec` was committed twice verbatim. One copy removed in `a28acf2`,
leaving the survivor directly above the type.

## Critic findings and synthesis

| # | sev | location | decision |
|---|---|---|---|
| 1 | **7 (major)** | `sale.tsx:275-281`, discount after `resolveInitialPaid` | **Fixed in `c2fc0cf`.** Same masking class, reachable from a free-text discount field, verified red-before-green. |
| 2 | 4 | `purchase.tsx:150`, `unitCost` never re-validated at submit | **Dismissed for this round.** Pre-existing and by design (`nextUnitCost` clamps; quick-add gates `> 0`); not an ordering bug and out of the round's scope. |
| 3 | 3 | ORDER comment claimed an unusable override "drops the total" | **Fixed in `c2fc0cf`.** The comment was rewritten: it now states the rule (raw drafts before derived values) without the false override mechanism. |
| 4 | 3 | comment dedupe | No issue — confirmed correct. |
| 5 | 3 | ordering tests cover only quantity | **Partly fixed.** The discount arm now has its own test (`sale.test.tsx:1141`). The override arm stays structurally ordered but unpinned; deferred as a test-only follow-up. |
| 6 | 2 | reorder preserves every other branch | Confirmed; no prior test pinned `saleInvalidPaid`/`purchasesInvalidPaid`, so nothing broke. |

The critic confirmed the new tests are genuine pins: each types a payment first
(pinning `source: "amount"`), then clears the quantity so `total → 0` while the
amount survives. Swapped, `resolveInitialPaid(0, …)` returns `ok: false` and the
page emits the paid message, failing the positive and the negative assertion.

## Defender

The defender scored the input-before-derived ordering 9/10, the symmetric sale
reorder 8/10, separate early returns over one combined validator 8/10, the
ORDER comment as a signpost 7/10 (honest weakness: a comment cannot enforce
order — the tests are the lock), and the comment deletion 9/10. No blocker.

## Residual risk (named, not hidden)

- The ordering invariant is expressed in two submit bodies plus two near-verbatim
  `ORDER:` comments (standards axis flagged it as a mild Duplicated Code smell).
  Acceptable now — the screens differ (discount, override, supplier) and the
  order is pinned per screen — but it is a legitimate extraction target. Deferred.
- The override-vs-payment arm is ordered correctly but has no page test; only the
  quantity and discount arms are pinned.
- Purchase's `unitCost` remains an unvalidated input to `total`.

## Verdict

No blocker at `c2fc0cf`. The round-2 quantity mask is fixed on both screens, the
same class of mask for sale's discount was found by the critic and fixed with a
red-before-green test, the duplicated comment is gone, and every remaining gap is
either tested or written down with a reason.
