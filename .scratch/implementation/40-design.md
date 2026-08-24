# PR #40 — purchase proposal cap and process-safe invoice numbers

- **base:** `aed3917722aa2660b587d7699b15794b105147d8` (merge-base with `origin/develop`)
- **head:** `5f5c961995c86113c66737e5af7a14928be934e2`
- **review tier:** High-assurance — purchase attribution and invoice numbering are money/audit-facing behavior.

## Public interfaces

- Keep `purchasesProposal`'s output shape. For each item, cap the proposed quantity at the invoice line quantity minus quantity already attributed to that invoice; rows with no remaining quantity must report `proposedLinkQty: 0` and `remainderQty: 0` so the UI cannot offer a no-op allocation.
- Add a persistence seam `allocateInvoiceNumber(): Promise<string>` to `StorePort`. It reserves the next formatted number in the database, inside the caller's transaction.

## Dependencies and implementation

- Add a singleton SQLite sequence table to the additive startup DDL. Seed it once from the maximum existing parseable `INV-` number using an atomic `INSERT ... SELECT ... WHERE NOT EXISTS`, allowing concurrent process startup.
- Implement allocation as one database `UPDATE ... RETURNING` statement. SQLite serializes writers across connections; the outer invoice transaction rolls back the reservation with the invoice if the transaction fails.
- Replace the router's process-local `lastInvoiceNumber` read with the transaction-local allocator. Keep `lastInvoiceNumber` for the existing read seam and compatibility tests.

## Planned tests

- Router regression: create uninvoiced stock beyond an invoice line, link the line's full quantity, leave extra uninvoiced stock, then assert proposal reports no linkable quantity and no remainder allocation.
- Store regression: open two independent SQLite connections/stores on one database file and allocate concurrently in separate transactions; assert both succeed with distinct sequential numbers.
- Existing router, store, typecheck, lint, and E2E suites remain required. No new user-facing flow is introduced, so the existing purchase E2E coverage remains the applicable browser seam.

## Risks

- Startup migration must never reset an already-seeded sequence or duplicate rows under concurrent setup.
- The sequence can have gaps only if a future caller commits a reservation without an invoice; current router allocation and invoice insert share one transaction, so failed creates roll back the reservation.
- Keep existing SAFETY comments and StorePort seam; do not introduce a process mutex that cannot coordinate separate app processes.
