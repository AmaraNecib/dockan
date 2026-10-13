# Code review — issue #163 (two axes)

> **Superseded** by `f651a97…-code-review.md` (Greptile round-1 fix delta). Kept as history.

Reviewed code SHA: `79a7e65281206875b547c2add383eae81e5e1377`
Evidence SHA (this filename): `cbeba3012d5ac0928e796bd7a7ef490e5634c79f` (adds only the wisdom note)
Fixed point: `c0794b7a1a0e1ec0e5af0ca6bd51c1a6588a4b92` (`origin/develop`, merge-base)
Diff: `git diff c0794b7...79a7e65` (three-dot)
Standards sources: `docs/engineering-workflow.md`, `docs/development-workflow.md`,
`AGENTS.md`, `CONTEXT.md` (domain glossary), plus the oxlint anti-slop config.

---

## Standards

**Verdict: pass.** No documented-standard breaches.

- Source-only change policy: staged named files only, never `git add -A`;
  no `dist/`, coverage or report artifacts in the diff.
- Evidence filename carries the exact reviewed HEAD (`79a7e65…`).
- Anti-slop lint (`bun run lint`) is clean; the assertions, `unknown`
  parameter and value-widening rules were all satisfied in the new code.
- Domain terminology matches `CONTEXT.md` (list, page, offset, total).
- Deep-module shape: the page math lives in one pure module
  (`apps/web/src/lib/pagination.ts`), the list interaction in one hook
  (`usePagination`), and the UI in one component (`Pager`) — no per-page
  duplication of the rules.
- Money paths untouched: no write/settlement/debt code reads a paginated list;
  `partyDetail` still returns the full invoice set for the settle/pay panels.

Judgement calls (baseline smells, not violations):

- **Duplicated Code (judgement call):** the store repeats a small
  optional-pagination envelope across `listItems`, `listReturns`,
  `listSupplierReturns`, `listActivities`, `listInvoices` ("if no keys return
  all, else limit/offset + count"). Extracting a generic Drizzle helper was
  considered and deferred: each call site has a different join/order, and the
  duplication is ~6 lines; the shared contract (`resolvePagination` +
  `pagedOutputSchema`) already carries the rule.
- **Divergence from "the store does LIMIT/OFFSET":** expenses and item
  history slice at the router because `sortExpenses` owns ordering there and
  `stockAfter` is cumulative. This is documented in the design doc; the client
  contract is still `{limit, offset} → {items, total}`.
- `tests/e2e/auth-helpers.ts` opens lists wide (page size 500) for the shared
  e2e preamble because specs about other features assert on complete lists.
  This is a test fixture, explicitly commented; `pagination.spec.ts` resets to
  10 to exercise paging from a known state.

---

## Spec

Source: GitHub issue #163 (read via `gh issue view 163`) and
`.scratch/implementation/163-design.md`.

| Spec requirement | Status |
|---|---|
| One shape `{limit, offset}` in, `{items, total}` out | ✅ |
| Store `LIMIT/OFFSET` + `COUNT`; default page size 10 | ✅ for invoices, items, activity, returns, supplier returns (SQL). ⚠️ expenses + item history slice at the router (documented reason: pure-module sort / cumulative balance) |
| Shared pager: hidden when `total <= pageSize` | ✅ |
| Presets 20 / 25 / 50 / 100 + «مخصّص…» manual size | ✅ |
| «عرض X–Y من Z» + numbered pages | ✅ |
| RTL, theme tokens only, `tabular-nums`, Arabic-first i18n | ✅ |
| Offset resets to 0 on search/filter change | ✅ (invoices, expenses filters; returns page has no filters) |
| Chosen page size persists | ✅ (`ui.pageSize` preference via `usePreference`) |
| Paginate invoices (sale + purchase) | ✅ |
| Paginate items | ✅ (plus `itemsAll` so pickers/selects keep the whole catalog) |
| Paginate expenses | ✅ |
| Paginate activity | ✅ |
| Paginate returns | ✅ (customer + supplier tabs) |
| Paginate an item's stock history | ✅ |
| Paginate supplier account entries (#161) | ❌ **deferred** |
| Paginate party-detail tabs (customer + supplier) | ❌ **deferred** |
| Exempt computed aggregates and grouped views | ✅ untouched |
| Keep money paths untouched | ✅ |

Findings:

- **(a) Missing/partial:** the **party-detail tabs** (customer/supplier
  invoices and payments) and the **supplier account entries** list are still
  returned whole by `partyDetail`. They are coupled to the in-page settle/pay
  panels and the delete guard, which must keep the complete invoice set for a
  correct money distribution; paginating them needs dedicated money-safe reads
  (`partyInvoices`, `partyPayments`, `supplierEntries`). Deferred deliberately
  to keep the money paths untouched (spec: "Keep the money paths untouched").
  **Proposed follow-up issue:** "Paginate the party-detail tabs and supplier
  account entries behind money-safe reads".
- **(b) Scope creep:** none. The only unrequested surface is the `itemsAll`
  endpoint, which is required to keep the existing dropdowns complete once
  `itemsList` paginates (a direct consequence of the spec).
- **(c) Implemented but wrong:** none found. The two subtle correctness traps
  (sort-before-slice for expenses, project-before-slice for cumulative
  `stockAfter`) are both handled and pinned by new router tests.

---

**Summary:** Standards — 0 hard violations, 2 judgement-call notes.
Spec — 14/16 requirements done; 2 explicitly deferred (party-detail tabs,
supplier account entries) with a proposed follow-up issue.
