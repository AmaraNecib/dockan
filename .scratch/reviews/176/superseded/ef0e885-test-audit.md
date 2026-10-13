# Test audit — issue #176 supplier adjustments

Reviewed SHA: `ef0e885` (base `1840a3a`). Three audit agents ran (edge-case
hunter, coverage analyst, quality reviewer) in two rounds.

## Acceptance criteria → test

| Criterion | Test | Status |
|---|---|---|
| ADJUSTMENT sign both directions (نسالوه +, يسالنا −) | `supplier-ledger.test.ts` | covered |
| Missing direction throws, never guessed | `supplier-ledger.test.ts` | covered |
| Account-only moves the balance, NEVER touches an invoice | store + router + e2e | covered |
| Linked adjustment drops the invoice remaining + `returnCreditAmount` | store + router | covered |
| Linked amount == remaining (full write-off boundary) | router (`zeroes an invoice…`) | covered (round 2) |
| Linked amount > remaining refused, nothing written | router + store + panel | covered |
| `WE_OWE` + link refused | router (contract superRefine) | covered |
| Wrong-supplier / sale-invoice link refused | router (round 2) | covered |
| Balance agreement: list / debts / pure signer, both signs | store | covered |
| Store refuses a null-direction ADJUSTMENT | store (round 2) | covered |
| Bulk: one entry per filled row | router + web | covered |
| Bulk: duplicate confirmation for a supplier with entries | router + web | covered |
| Bulk: whole-batch rollback on a bad row | router (round 2) | covered |
| Bulk: empty batch / zero amount refused | router (round 2) | covered |
| Backdatable `occurredAt` persisted | router (round 2) | covered |
| **BLOCKING v2 → v3 migration** (add column, preserve rows, stamp 3, old build refuses, idempotent re-open, ADJUSTMENT round-trips) | `supplier-adjustment-migration.test.ts` | covered |
| Playwright: bulk رصيد افتتاحي + linked خصم agree | `tests/e2e/supplier-adjustment.spec.ts` | covered |
| Web panel: direction, link forces يسالنا, excess block, no open invoices | `supplier-adjust-panel.test.tsx` | covered |

## Quality grades (final round)

- `supplier-ledger.test.ts` — A
- `supplier-account-store.test.ts` — A− (the order-dependent single-`.find`
  assertion from round 1 was replaced with a both-directions assertion; the
  THEY_OWE parity check now also compares against `supplierBalance`)
- `supplier-adjustment-migration.test.ts` — A (exact row preservation, typed
  refusal, idempotency via `COUNT(*)`)
- `router.test.ts` (supplier adjustments) — A−
- `supplier-adjust-panel.test.tsx` — A−
- `supplier-opening-balance.test.tsx` — A− (the inert-confirmation path is now
  driven end-to-end)
- `tests/e2e/supplier-adjustment.spec.ts` — A−

## Missing edge cases (none red; all green/orange closed where cheap)

Added in the fix rounds: full write-off, wrong-supplier/sale links, empty batch,
zero amount, null-direction refusal, mixed-batch rollback, backdated date,
signed list balance, duplicate inline name, stale-expectation confirmation.

Remaining (documented, non-blocking):

- The linked-discount invariant is proven on a fully-unpaid invoice; a
  partial-payment variant is deferred (same reconciliation term).
- The `ADJUSTMENT_DEBT_OFFSET_REFUSED` race branch is unreachable behind the
  pre-check inside `BEGIN IMMEDIATE`; its store primitive (`false` return) is
  tested.
- The fresh-DDL `kind/direction` CHECK is exercised via the store seam, not by
  raw SQL.
