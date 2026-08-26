# Code review — returns & refunds (standards + spec axes)

Base SHA: `9b6ee41`. Head SHA: `fd09134`. Diff: `git diff 9b6ee41...fd09134`.

Reviewers: reviewer subagents (standards + spec axes, mission 53796ce2),
settlement-delta review (mission 2281d97f), plus the external PR #62 findings
(both validated and fixed in `fd09134`).

## Standards

Fixed during review:
- Issue numbers in new-source comments → semantic (cab527a).
- Arabic inside comments of NEW files → English (617a7ab); type assertions
  without SAFETY: → justified (617a7ab).
- anti-slop return-type widening in `bookSaleLineForReturns` → named
  `BookedSaleLine` contract with `satisfies` (fd09134).

Confirmed compliant:
- @dokan/contracts single source of truth; ADR-0003 StorePort seam (scrap
  stats read through the store; `bookSaleLineForReturns` is pure in the
  return-calculations seam); whole-DZD money; Algeria-local timestamps;
  Arabic UI with stable translated server keys; append-only ledger facts
  (only review tags / status / reason transition).
- PR-fix code follows the local patterns: consolidation mirrors the cap's
  request-internal summing; per-unit closed booking lives in the pure module
  with the store supplying raw aggregates (readable, unit-testable).

Baseline smells (judgement calls, accepted): duplicated ledger-append blocks
match the router's explicit style; payoutMethod future-proofing is documented.

## Spec

Base + settlement-split + freebie-unwind requirements all present and correct
(clauses verified in the previous evidence revision). The two PR findings are
spec-adjacent correctness fixes, not new scope:

- P1 — the refund must be computed ONCE per line: dedupe-first consolidation
  now guarantees the split entries of one line settle at the single
  full-line/partial price (exact full-line net, never per-entry rounding).
- P2 — rejected returns must un-book only the resold portion: per-unit closed
  booking keeps the scrapped-now units in the original sale and lets the
  resale invoice own the resold units — no unit is booked twice, and a
  fully-scrapped freebie still keeps its recognized loss.

## Summary

Standards: 3 findings (all fixed) + 2 accepted judgement calls. Spec: 0
missing/scope-creep/wrong; 2 external findings fixed with regressions. Worst
remaining per axis: none blocking.