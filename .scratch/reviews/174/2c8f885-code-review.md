# Issue 174 — Code-review evidence

Base: `8bf2a81` (origin/develop merge-base; three-dot diff). HEAD: `2c8f885`.

Two read-only `reviewer` sub-agents reviewed `git diff 8bf2a81...HEAD` on
opposite axes. Standards sources: `AGENTS.md`, `CONTEXT.md`,
`docs/engineering-workflow.md`, `.agents/skills/` (plus the Fowler smell
baseline). Spec sources: `gh issue view 174` and
`.scratch/implementation/174-design.md`.

## Standards axis

| Finding | Disposition |
|---|---|
| `role: z.enum(["customer","supplier"])` duplicated `partyRoleSchema` (`core.ts:138`). | **Fixed** in `2c8f885`: both party-read schemas reuse `partyRoleSchema`. |
| `partyPayments` role axis was a one-sided seam — only the customer caller exists; the supplier tab is `supplierEntries`. | **Fixed**: `partyPaymentsInputSchema` and `store.partyPayments(partyId, …)` are customer-only; the misleading role parameter is gone. |
| Dead `pagination === undefined` full-read branches (Speculative Generality) — the router always resolves concrete pagination, and `supplierEntries(id)` duplicated `listSupplierEntries`. | **Fixed**: pagination is required on the three tab reads; the branches were removed and the store tests use explicit pages. |
| Duplicated row mapper — the payment `String(invoiceNumber)` map appeared three times. | **Fixed**: shared `mapPartyPayments` (mirrors `mapRecentInvoices`), used by `partyDetail` and `partyPayments`. |
| `refreshTabQueries` over-invalidates (supplierEntries on a customer page). | **Dismissed**: the inactive/disabled query is a no-op; keying by role would add branching for no user-visible effect. Noted as harmless. |
| Query-key prefix shape (the debate blocker) | **Verified fixed**: double-nested `[[...]]` constants, pinned by `query-keys.test.ts`. |
| Money reads whole; rowid tie-break; wisdom 2 (selects keep full data) | **Correct** — checked, no violation. |

## Spec axis

| Finding | Disposition |
|---|---|
| All four acceptance criteria implemented: `{limit,offset}`→`{items,total}` on all three reads; `partyDetail` full invoice set; Pager wired into all three tabs; offset reset on the unpaid-only filter. | **Verified.** |
| Money math untouched — the diff touches no settle/pay panel, `party-settle.ts`, or `deleteParty`; router tests pin a >1-page OLDEST-first settle. | **Verified.** |
| Scope creep: `refreshTabQueries` + three `query-keys.ts` constants + five panel `onDone` edits. | **Accepted, design-approved**: required so a payment does not leave stale tab rows; documented in the design doc. |
| Scope creep: the rowid tie-break also changes `partyDetail`'s tie ordering. | **Accepted**: strictly more deterministic; `distributePayment` re-sorts independently. |
| **Risk: no error branch on the three tab queries** — a failed read rendered the empty state, misreporting a party as empty. | **Fixed** in `2c8f885`: each tab renders a `role="alert"` error state (`party-invoices-error`, `party-payments-error`, `supplier-account-error`) instead of the empty state. |
| `mapRecentInvoices(rows) ?? []` can blank a page while `total` counts it. | **Dismissed** (also in debate): the same all-or-nothing degradation the tab already had pre-#174; malformed-legacy-only. |
| Router forwards `unpaidOnly` regardless of role; web never sends it for suppliers. | **Dismissed**: harmless, contract-permitted. |

## Verification at `2c8f885`

- `bun run typecheck` — 3/3 packages pass.
- `bun run lint` — clean (oxlint + anti-slop).
- `apps/api`: `bun test src/store/pagination-store.test.ts` 12 pass; `bun test src/rpc/router.test.ts` 207 pass.
- `apps/web`: `bun test src/lib/query-keys.test.ts src/pages/party-detail.test.tsx src/pages/parties.test.tsx` 35 pass.
- `tests/e2e/pagination.spec.ts` — 3 passed.

No blocker remains on either axis.
