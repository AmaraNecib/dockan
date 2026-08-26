# Code review — returns & refunds (standards + spec axes)

Base SHA: `9b6ee41`. Head SHA: `cab527a`. Diff: `git diff 9b6ee41...cab527a`.

Reviewers: reviewer subagents (standards axis, spec axis; mission 53796ce2).

## Standards

**Violations found and fixed (cab527a):**
- Semantic naming: two NEW-source comments embedded issue numbers
  (`return-calculations.ts` "issue 59", `drizzle-store.ts` "Issue 59") —
  removed; semantic descriptions now.

**Confirmed compliant:**
- `@dokan/contracts` single source of truth (statuses/marks/payout methods/
  schemas), port imports the same tuples the drizzle schema does.
- ADR-0003 StorePort seam — new persistence methods go through the port;
  raw SQL confined to the driver adapter.
- ADR-0002/0005 append-only — returns append movements; the ONLY mutable
  column is `return_mark` (documented review tag); reject re-balances via a
  fresh MANUAL_ADJUSTMENT outflow in the same unit.
- Money = whole DZD integers (`dinarsSchema`, integer columns); timestamps via
  `localDateTime()` (Algeria local); Arabic UI with stable `RETURN_*` server
  keys translated by `tError`.
- Tests ship with the feature (unit/store/wire/web/e2e) and run green.

**Baseline smells (judgement calls, accepted):**
- Duplicated ledger-append block between `returnsCreate` and `returnsReject`
  — mirrors the router's existing explicit style (sale vs purchase blocks in
  `invoicesCreate`); the two paths differ (inflow with cost vs clamped outflow
  with reason); a shared helper was judged higher-risk than the duplication.
- Speculative Generality (mild): `payoutMethod` future-proofing is a
  documented owner decision, not speculative.

## Spec

All requirements present and correctly implemented — no missing items, no
scope creep, nothing implemented wrongly:

- returns table with invoice_id, line refs, quantities, Arabic reason,
  whole-DZD refund, payout_method (CASH default), returnMark state + review
  flow; append-only SALE-reversal movements marked PENDING; per-line
  sold−already-returned cap; FIFO replay deterministic; stock never negative
  (projectLedger guard both sides).
- RPC create/list/accept/reject with the specified validations; review accepts
  consume the mark, reject performs the MANUAL_ADJUSTMENT removal with Arabic
  reason.
- Web: return form on the invoice detail (line picker with remaining-
  returnable), returns list + review UI (Arabic RTL, existing page patterns),
  voucher route `/invoices/:id/returns/:rid/print` mirroring the receipts
  route (`buildReturnVoucher`, store identity header, on-demand render, no
  stored PDFs).
- `stock_movements.return_mark` upgrade path via ALTER for existing DBs.

One note (not a defect): `return_lines` DDL forward-references `invoice_lines`
declared later in `SCHEMA_DDL`; SQLite permits FK forward references and
enforcement happens at DML time, so fresh-db creation is safe (verified by the
store suite's fresh setup()).

## Summary

Standards: 2 findings (both naming nits, both fixed) + 2 accepted judgement
calls. Spec: 0 findings. Worst remaining per axis: none blocking.