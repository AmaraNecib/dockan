# CI e2e fix — expense row selector (test-only)

PR #171's first CI run failed `playwright e2e`, in `tests/e2e/expense-reports.spec.ts:243`
(`create a new expense category from the expenses screen and record against it`). This
file and `expenses.tsx` are **not touched by this branch**; the branch's new e2e specs
changed the parallel data and exposed a latent flake.

## Root cause
The test selected its row by amount: `locator("tbody tr", { hasText: "1250" })`.
Playwright concatenates a row's cells **without separators**, so another row
(`كراء المحل`, note `كراء-<stamp>`, amount `5000`) rendered as
`…كراء-1791843945**312**5000…` → the substring `…3125000` contains `1250`. Two rows
matched → strict-mode violation.

## Fix
Select by the row's unique stamped category name instead of the amount, and assert the
amount inside that row. Verified locally: `bunx playwright test tests/e2e/expense-reports.spec.ts`
→ 4 passed.

Test-only change; no product code affected. The substantive #162/#164 review at
`0c5d3f4` still stands.
