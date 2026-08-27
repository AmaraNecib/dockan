# Issue #68 — Test-audit evidence

Base: `f4d4674` · Head: `18ee20c` · Branch: `fix/68-return-debt`

Three parallel reviewer agents (edge-case hunter, coverage analyst, quality
reviewer) over the changed test/source files and the design doc.

## Edge-case hunter

Correct (verified): fresh-DB path safe (ensure runs before SCHEMA_DDL; PRAGMA
on a missing table returns 0 rows); accept arithmetic sound
(`applied = min(max(0, debtOffset−debtApplied), remaining)` ≤ both bounds);
debts+marks+setDebtApplied share one BEGIN IMMEDIATE unit; accept/reject race
guarded by the conditional UPDATE.

Findings → actions:
1. 🟠 Migration was two autocommit statements; a crash between ALTER and
   backfill would make the next boot skip the backfill forever (the exact
   greptile P1 class ensureSaleColumns guards). → **Fixed at 18ee20c**: ALTER +
   backfill wrapped in one BEGIN IMMEDIATE/COMMIT with ROLLBACK on error.
2. 🟠 Legacy REJECTED rows (backfilled debtApplied > 0) contradicted the
   “لم يُطبّق” label. → **Fixed**: new `debtOffsetDisplay` helper: REJECTED
   with debtApplied > 0 reads as applied (ledger fact), otherwise shows the
   cancelled promise; card + voucher both use it.
3. 🟡 Missing test: accepting a backfilled legacy PENDING row must apply
   nothing. → **Fixed**: router test inserts a simulated legacy row
   (debt_applied = debt_offset, invoice already at 0) and asserts the accept
   is a no-op with debtApplied unchanged.
4. 🟡 Missing-invoice accept → non-reachable (getReturnDetail returns
   NOT_FOUND first); dismissed.

## Coverage analyst

Criteria 1–3 (pending keeps debt, accept applies, reject never applies)
covered with diverse scenarios. Gaps closed:
- Over-promise test recalibrated (debt 2000 < 2×2000 promises) so the
  accept-time partial cap and the `setDebtApplied(…, 0)` write are actually
  exercised.
- debtApplied > 0 asserted on every accepted scenario (parent, never-negative,
  sequential, user, over-promise).
- Voucher status-aware label/amount now tested (view test, 4 cases).
- Legacy end-to-end accept now tested (above).
Residual note: `debtSummaries` store query not re-tested per pending state
(the existing debt-summary store tests stand; reportsDebts covers the issue).

## Quality reviewer

Grade B → points fixed: comment mismatch in invoice-returns test clarified;
acceptance-note absence asserted (no note when projectedDebt = 0); trailing
newlines added. Test names, async handling, assertion quality confirmed.

## Result

All three agents' actionable findings addressed in `18ee20c`; final suites:
API 423 pass / 0 fail, web 130 pass / 0 fail, typecheck + lint clean.