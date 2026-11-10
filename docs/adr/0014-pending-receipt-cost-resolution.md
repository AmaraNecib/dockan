---
status: accepted
---

# Resolve receipt cost through linked immutable adjustments

Issue #393 extends ADR-0005 without rewriting historical invoice facts. The owner approved correcting the profit of units already sold when their receipt cost becomes known. The owner accepted original-sale-period reporting, a required reason and source-aware returns in the issue #393 conversation, then approved conditional return-source selection instead of unconditional FIFO attribution.

## Resolution and reporting

A receipt-cost resolution identifies the original pending receipt movement and records its actual unit purchase cost, a nonblank reason, authenticated actor and server recording timestamp. Preserve the original receipt, pending marker, posting timestamp and invoice snapshots. Derive effective cost and pending status from linked immutable records. This is not the current-item COST_CORRECTION command.

Resolve the full received quantity, not only the quantity still on hand. For five pending units received, two sold and three retained, resolving at 100 DZD adds 200 DZD to sold COGS and establishes 300 DZD of remaining receipt-linked FIFO value. Stock quantity, revenue, cash and debt do not change. Keep the live weighted-average cache separate from FIFO valuation under ADR-0002 and ADR-0005.

Profit corrections belong to the original sale's business period. The audit trail separately shows when the cost was learned and recorded. Keep original costAtSale and cogsExact snapshots immutable and expose effective totals through linked exact COGS adjustments. A zero-cost resolution clears pending status without inventing a nonzero cost. Profit becomes final only when no unresolved source contributes to its effective sold quantity.

## Source provenance and returns

Persist sale-line source quantities when posting the sale. Link adjustment outcomes to the resolved receipt and affected sale line. Backdated writes must not reinterpret existing source allocations or revise unrelated sales.

A return may draw only from source allocations of its original sale line and may not exceed their remaining returnable quantities. When all eligible sources have the same effective unit cost and pending status, allocate automatically without another question. When cost or pending status differs, offer source choices with receipt date, cost or pending label, and returnable quantity. Permit a multi-unit return to split across sources. Include an explicit "I don't know" option that allocates from the oldest eligible source used by that sale. Persist whether the operator selected the source or used automatic attribution. Ordering must be stable and reflect the original source allocation, not a later ledger replay.

Returned units with unresolved receipt provenance retain that provenance in their return layers. Resolving their source must value stock still present and correct any subsequent sale without charging the returned quantity twice. Preserve existing settlement and return-review rules. Do not incidentally change known-cost return valuation outside the source-aware behavior required here. Rejection must leave source quantities and effective costs consistent with the existing return-reversal contract.

## Atomicity, retries and historical data

Write the resolution, linked adjustments, effective valuation changes and audit event in one database transaction. Enforce at most one resolution per receipt. An identical retry returns the existing outcome; a conflicting retry is refused. A failure leaves no partial correction. The server validates source ownership, quantities, authorization and input rather than trusting UI selections.

Existing invoice-level stock_links do not always identify sale-line allocations. Preserve their facts and migrate only allocations that can be proved unambiguously. Present-day ledger replay and rounded snapshots cannot establish posting-time provenance after backdated insertions. Never fabricate missing links. If a historical receipt cannot be resolved safely, refuse atomically with a visible explanation and keep the affected profit provisional. Such gaps must be reported as acceptance blockers where they prevent the required behavior, not hidden as successful resolutions.

## Rejected alternatives

Overwriting invoice snapshots would erase the original facts. A current-item cost correction would not resolve the receipt or correct sold-unit profit. Replaying the current ledger to reconstruct every historical allocation can change the answer after backdating. Asking the operator to choose a source for every return adds work when all choices have the same accounting result; automatic FIFO for every return prevents an informed operator from identifying a different source.
