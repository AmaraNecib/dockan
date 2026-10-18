# Refresh derived views on a failed money batch, not only on success

**Date:** 2026-10-13 · **Ticket:** 174 round 1 (PR #186, Greptile 4/5) · **Area:** apps/web/src/components/parties/*, apps/web/src/pages/party-detail.tsx

A panel that writes several rows and calls an `onDone` callback **only after the
last one succeeds** leaves every view derived from those rows stale when the
batch stops midway. `CustomerSettlePanel` posted one `invoicesPay` per invoice;
on a mid-loop failure it refreshed only `customersGet`, so the new paged
`partyInvoices` / `partyPayments` queries (separate oRPC keys) kept old data — a
paid invoice still showed unpaid and its payment was missing.

Three things to carry forward:

1. **Signal the outcome on both paths.** The panel got an `onWriteFailed`
   callback invoked from its `catch`, wired to the page's `refreshTabQueries`.
   The success path keeps `onDone`. Do not fold the failure refresh into `onDone`
   (the panel must stay open on failure so the owner can see the halted state).
2. **Fire it unconditionally on failure, not behind a client-side write count.**
   A rejection can also hide a write the server committed (a lost response), so
   `if (written > 0)` is a guess. Refresh whenever the attempt failed. The only
   cost is one extra refetch.
3. **Single atomic RPCs still need the failure refresh.** `suppliersPay` with
   `OLDEST` allocates inside one `withTransactionImmediate`, so there is no
   mid-batch path — but a committed-but-lost response is the same user-visible
   class. The supplier panels' `catch` invalidated only `suppliersGet`; they now
   signal `onWriteFailed` too. "No partial writes" is not the same as "no
   refresh needed after a failure".

**Always**: when a write can change a list, ask what refreshes that list on the
*failure* path, not just the success path. And keep the tab/derived query keys
owned by the page, not the shared panel — the panel signals, the page
invalidates.
