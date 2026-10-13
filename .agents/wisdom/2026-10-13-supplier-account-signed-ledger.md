# Signed supplier account: one ledger, cache derived from the entries that name the invoice

**Date:** 2026-10-13 · **Ticket:** 161 (supplier half of 164) · **Area:** apps/api/src/lib/supplier-ledger.ts, apps/api/src/rpc/router.ts, apps/api/src/store/drizzle-store.ts

ADR-0008 makes one signed account per supplier the single money primitive. The
implementation choices worth carrying forward:

1. **Keep the invoice cache, but derive its value from the entries.** The
   printed purchase invoice still reads `paid_amount / remaining_amount`, and
   the existing conditional `UPDATE ... WHERE remaining >= ?` stays the
   authoritative boundary. Every write also appends a signed
   `supplier_account_entries` row, and a pure `deriveInvoicePaid(entries, id,
   total)` proves the cache matches. This avoids a risky read-time rewrite of
   every invoice consumer while keeping one truth.
2. **Excess always becomes credit, never an error.** A payment or return that
   names an invoice is split by `splitAgainstRemaining`: the part that fits is
   attached (`invoiceId` set), the rest is a second entry with `invoiceId =
   null`. Overpaying is a legitimate business act (an advance), so the UI must
   NOT block it — the first E2E draft did and the confirm button stayed
   disabled. Only malformed/zero amounts block.
3. **A purchase return needs no review state.** It writes the `RETURN` entry
   and a `MANUAL_ADJUSTMENT` stock outflow in one `BEGIN IMMEDIATE` unit; the
   debt-vs-credit split falls out of the same `supplierReturnSplit`. Invoice-
   linked returns are capped bought-minus-already-returned (a new
   `returnedByPurchaseLine` read), free-standing returns price at the item's
   current average.
4. **Backfill once, marker-gated.** Existing id-backed purchase invoices get a
   `PURCHASE` charge plus one `PAYMENT` per existing payment row, inside one
   transaction with `migration.supplierAccountV1`. The marker is the guard; a
   second boot is a no-op (tested by clearing the marker in the store test).
5. **The purchase form's down payment defaults to the full total (#162).** An
   E2E that wants an unpaid purchase must zero `purchase-paid`, or the invoice
   is created already settled and the supplier balance reads 0.
