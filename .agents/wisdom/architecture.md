
## Review-pending records must keep the ledger provisional (💡 Design Principle)

Issue #68: a PENDING_REVIEW return applied its debtOffset to the invoice at
creation, so the debts page showed "no debt" while the return could still be
rejected — and rejecting it never restored the money. Any record that has a
reversible review step (accept/reject) must NOT settle money in the create
transaction; the ledger stays provisional until the review resolves, and the
reject path must never have applied the value in the first place.

**Always**: check whether a "pending" write settles anything feed-visible
(debt screens, reports, balances). If the entity has a reject path and the
reject doesn't fully reverse the create-time settlement, the design is
inconsistent — defer the settlement to the accept step. Be careful what the
create-time voucher records vs what the ledger applies: the voucher is a
promise, the ledger is the truth; expose BOTH on the UI (recorded promise +
applied amount) so a cap at accept never makes the screen lie.

## Column backfills must be one transaction (🟠 Major)

Precedent set in ensureSaleColumns (greptile P1) and applied to the #68
debt_applied backfill: an ALTER TABLE + data backfill on an existing database
must run inside one BEGIN IMMEDIATE/COMMIT. Interrupted between the two
statements, the next boot sees the column and silently skips the backfill
forever.

**Always**: when adding a column that needs a data backfill for legacy rows,
wrap ALTER + backfill in one transaction (ROLLBACK on error) so an interrupted
boot re-runs the pair on the next setup. A column-presence guard is not the
same as crash-safety.
