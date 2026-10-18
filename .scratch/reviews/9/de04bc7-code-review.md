# Code Review — Issue #9 Debts screen

- Issue: #9 (spec `.scratch/dokan-mvp/issues/07-debts-screen.md`)
- Base SHA: `af0c7a3`; evidence HEAD: `0cf7e3c`
- Reviewed at `1a18ed7`; single code-review note applied as `0cf7e3c` (delta below)
- Two parallel sub-agents: **Standards** (repo conventions + Fowler smell
  baseline) and **Spec** (spec fidelity + lane constraints)

## Standards axis

No documented-standard violations. StorePort remains the boundary;
drizzle-store is the only driver-aware file; contract/contracts changes are
additive; guarded/guardedInput seams reused; lint (oxlint + anti-slop) clean.

Baseline smells (judgement calls, none hard):
- Divergent Change / Data Clumps: the party-identity rule (id wins; otherwise
  trimmed typed name) exists at three seams — `debtSummaries` (raw GROUP BY),
  `listUnpaidInvoicesByParty` (trimmed match), and the contract refine. The
  padding nuance is documented and frozen by test-audit E1. Latent, not a
  blocker. **Dismissed** with documentation (changing `debtSummaries` would
  ripple into other lanes' pre-existing behavior).
- Repeated Switches (minor): `kind === "SALE"` vs `"PURCHASE"` re-keys what
  the enum constrains. **Dismissed.**
- Dead inner `key={signature}` on the row `<li>` (parent already keys).
  **Fixed** (`0cf7e3c`).
- `mock.module` in the component test matches repo precedent (purchase.test.tsx).
  **Dismissed.**

## Spec axis

All four acceptance bullets implemented and tested:
1. Two groups (owedToUs SALE / weOwe PURCHASE), each with remaining total +
   invoice count — group headers and per-person rows; e2e asserts 1500/1200
   and counts.
2. Known parties AND typed-only names; lone names never lost; no id/name
   merging — id-authoritative matching + typed-name-only branch; store, wire,
   and component tests lock it.
3. Totals = sum of remaining amounts — `debtSummaries` SUM verified against
   drill-down sums in store tests.
4. Clicking a group opens its unpaid invoices — expandable person row runs
   `debtsByParty`; Arabic RTL asserted in e2e.

Lane constraints respected: grouping reused (not reimplemented); store extended
only for the real gap (party-filtered unpaid invoices); shared-file changes
additive except implementing the pre-existing `reportsDebts` stub, which is
this screen's own contract seam (in-lane by design, flagged to the parent for
merge coordination with #31). No expenses/reports-beyond-the-seam/payments
files touched.

Not asked for (scope creep): none material — drill-down RPC, skeletons,
single-open-row toggle, a11y hooks are engineering for the "opens its unpaid
invoices" bullet.

## Applied delta (reviewed-at → HEAD)

- `0cf7e3c`: removed the dead inner `key` on `DebtPersonRow`'s `<li>`.

## Residual

- Unbounded `debtsByParty` list (no pagination) — MVP-accepted; follow-up
  issue recommended (same item as debate finding #2).
- Padded-name asymmetry between summary grouping and drill-down is latent but
  app-create paths trim, and it is frozen by a dedicated test.
## Rebase addendum (2026-08-25)

Rebased onto origin/develop `d589133`; evidence re-keyed `0cf7e3c` →
`de04bc7`. Debts code byte-identical post-rebase; the only added reviewable
drift is #45's diagnostics feature, resolved additively (both RPCs, both
routes/nav, both test describes). Standards/spec verdicts unchanged.
