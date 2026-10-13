# Issue 174 — Round 1 debate evidence (High-assurance)

Base: `8bf2a81` (origin/develop merge-base). Round-1 delta reviewed:
`e84d592..676cde5`, then the debate fixes `676cde5..d8d21f4`. Evidence anchor:
`8e12e3d` (the code under review is `d8d21f4`; the only later commit is this
docs/evidence anchor).

Two read-only `reviewer` sub-agents ran in opposite directions on
`git diff e84d592...HEAD`, plus the round-1 brief
(`feat-174-greptile-round1.md`) and the full PR diff for context.

## Critic findings

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | **5** | `written === 0` is a client-side guess: a first-write failure whose response is lost commits server-side but rejects with `written=0`, so gating the refresh on the counter could still leave tabs stale. | **Fixed** in `676cde5`: invoke the callback unconditionally in the catch (after the panel's own refresh) and rename it `onWriteFailed`. |
| 2 | 4 | The settle/pay/return panels still invalidate string-first literals (`["invoicesList"]`, `["activitiesList"]`, `["suppliersReturnsList"]`) — the same documented no-op shape. | **Deferred** (pre-existing, app-wide; already recorded in the round-0 deferred list). Out of the round-1 tab scope. |
| 3 | 4 | Non-tab families (`debtsByParty` / `reportsDebts` / `dashboardSummary`) are not invalidated by the settle/pay panels. | **Deferred** (pre-existing; `supplier-adjust-panel` already handles them; a broader change outside this lane). |
| 4 | 3 | Supplier panels' failure paths call `void refresh()` (detail only) and never refresh `SUPPLIER_ENTRIES_QUERY_KEY`; a committed-but-lost `suppliersPay`/`Return`/`Adjust`/`Refund` leaves the entries tab stale — the same class. | **Fixed** in `d8d21f4`: the four supplier panels gained `onWriteFailed`; the page wires all of them (and the settle panel) to `refreshAfterWriteFailure`, which refreshes the detail and the three tab keys. A supplier-pay failure test pins it. |
| 5 | 2 | `onWriteFailed?.()` ran before `void refresh()`; a throwing callback could skip the panel's own refresh. | **Fixed**: `void refresh()` now runs first (`customer-settle-panel.tsx`). |
| 6 | 2 | Coverage: no first-write-failure test; the all-success guard is not a discriminator. | **Addressed**: added the first-write-failure test (nothing landed → rows stay owed, no phantom payment); the all-success assertion is a guard per the brief. |
| 7 | 1 | The halted panel keeps a stale amount/preview while tabs refresh. | **Dismissed** — cosmetic; confirm is blocked and the amount relinks on the detail refetch. |

**False alarm dismissed:** the Critic read `SupplierReturnPanel`'s two
`create.mutateAsync` calls as sequential writes. They are mutually exclusive
`if (mode === "INVOICE_LINKED") { … } else { … }` branches (one call per submit),
so there is no mid-batch path there. The Defender independently verified the
same.

## Defender highlights

- The callback shape (page owns its tab keys; the shared panel stays
  page-agnostic) is the right seam.
- `written`-after-await was correct; the unconditional catch is strictly more
  robust (the Defender also recommended it).
- `suppliersPay` with `OLDEST` runs the whole allocation inside one
  `withTransactionImmediate` (`router.ts`), so the supplier tab has no
  mid-batch path.
- The regression test is non-vacuous: the unpaid filter is toggled *before* the
  settle, so no query-key change can mask the assertion; only invalidation can
  flip the row to `مسدّدة بالكامل`.

No blocker remained after `d8d21f4`. Money paths untouched.
