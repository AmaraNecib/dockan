# Debate — returns & refunds (high-assurance)

Tier: High-assurance (money + stock invariants). Base SHA: `9b6ee41`. Head
SHA: `cab527a`. Issue: returns/refunds. Evidence reviewed: design doc
`.scratch/implementation/59-design.md` and diff `git diff 9b6ee41...cab527a`.

Reviewers: reviewer subagents (critic + defender), full outputs captured from
the workflow run (mission 53796ce2).

## Commands / context

- Diff under review as first submitted: `git diff 9b6ee41...cdb8e68`
- Post-review fix commit: `cab527a` (findings below applied)
- Local gates at review time: `bun run typecheck`, `bun run lint`,
  `bun run test` (api 388 + web 115), e2e 18/18

## Critic findings and dispositions

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | 8 | Cash refund is not bounded by money actually collected on the invoice — on an unpaid/partially-paid invoice the shop can hand out cash for money never received | **Deferred to owner (decisionRequest).** Not silently coded: the app records `paidAmount=0` for most counter sales (`initialPaid` is optional), so a hard refund ≤ paidAmount guard would break the primary cash flow; the decision list ("any past invoice … forever") explicitly scopes quantity caps only. Report + parent decision asked (see crew report decisionRequest). |
| 2 | 6 | Per-unit `Math.round` can over-refund a full-line return (e.g. net 101 / 3 → 34×3 = 102) | **Fixed (cab527a):** a full return (`quantity === lineQuantity`) now refunds `netTotal` exactly; partials keep the rounded effective unit price. Unit test: "keeps a FULL return exact". |
| 3 | 5 | `listReturns` unconditional `.limit(200)` could strand an old PENDING return off the review page and diverge the client cap mirror | **Fixed (cab527a):** list cap removed, newest-first kept; a pending return stays reachable for review forever. |
| 4 | 5 | Reject-after-resale: full-quantity reversal can STOCK_NEGATIVE → review deadlocks (return stuck PENDING) | **Fixed (cab527a):** reject clamps the MANUAL_ADJUSTMENT removal to stock actually on hand; whatever of the returned units was already resold stays as a legitimate sale; the mark/status still consume. Wire test: "reject after some units were resold clamps the removal to available stock". |
| 5 | 4 | No escape hatch if item lookup fails at review time | **Dismissed (unreachable):** returns only record `itemId` non-null and `stock_movements.item_id` FK prevents deletion; `itemId===null` guard is defensive, the ITEM_NOT_FOUND throw cannot fire through the UI. Noted. |
| 6 | 4 | `setReturnMarks` mutates an "append-only" row | **Dismissed (documented exception):** only the review tag transitions (PENDING→ACCEPTED/REJECTED), never ledger facts; schema comment + ADR-0002/0005 docs state it; replay ignores the tag (projection inputs are kind/delta/unitCost/occurredAt/seq). Noted in schema. |
| 7 | 3 | Rejection note not persisted on the return record (only the movement reason) | **Fixed (cab527a):** `setReturnReason` persists the note on `returns.reason` (composed with the original reason); voucher + returns list tell the full story. Store test added. |
| 8 | 2 | Cap violations surface one generic error without telling which line | **Dismissed (stable-key design):** the UI mirrors the cap per line client-side; ORPC messages are stable translation keys by design, dynamic data would break `tError`. |
| 9 | 2 | `lines` array unbounded | **Fixed (cab527a):** `.max(200)` on `returnsCreateInputSchema.lines`. |
| 10 | 1 | Hardcoded Arabic strings in the router ("مرجوع", "مرجوع تالف") | **Dismissed:** these are ledger/activity DATA (Arabic-first app), not UI copy; existing router uses identical Arabic activity summaries. |

## Defender highlights (accepted)

- Refund basis (effective per-unit net price, snapshotted, client-price-free,
  whole-DZD) is the pro-rata-correct measure; denominator is the SOLD count so
  partial returns price stably.
- One BEGIN IMMEDIATE unit owns create (record + lines + marked movements +
  stock/cost caches + audit) and review; `transitionReturnStatus` conditional
  UPDATE + serializeStore make double-consume impossible; `allocateReturnNumber`
  is a single atomic statement with a setup seed that tolerates hand-written
  RTN rows.
- Reject auto-remove is the owner's stated remedy automated (issue 58),
  inflow-precedes-outflow keeps replay valid (now clamped — see finding 4).
- `return_mark` is review-state metadata; rendering/valuation never depends on it.

## Verdict

No blockers after the fix commit. Remaining risk items: refund-vs-collected
money (finding 1, owner decision requested), full-suite DB-sharing/isolation
(see test-audit evidence), hardcoded Arabic ledger reasons (by design).