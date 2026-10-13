# Test audit — issue #176, Greptile round-2 fix

Reviewed SHA: `8e567c4`. Three audit agents at `895d1c9` plus a focused pass at
`8e567c4`.

## Finding → regression test

| Finding | Test | Fails pre-fix? |
|---|---|---|
| Dashboard `weOwe` negative rejects output validation | `router.test.ts` "accepts a signed weOwe in the dashboard output contract" — accepts `-300` and `300`, rejects `±(MAX_SAFE_INTEGER+1)` | **Yes** for `accept(-300)`: pre-fix `dinarsSchema` has `min(0)`. (The reject assertions pass against `.int()` alone — zod v4 bounds to safe integers; they document the contract.) |
| Credit-only shop's dashboard fails | `router.test.ts` "serves the signed supplier net for a credit-only shop and agrees with /debts" — `weOwe < 0` and equal to the `/debts` supplier net | Yes: pre-fix the RPC rejects a negative `weOwe` |
| Dashboard renders a negative as a debt | `dashboard.test.tsx` "renders a net supplier credit as a credit subline…" — shows `dashboardSupplierCredit` and `300`, not `-300` | Yes |
| `1 000,00` inflated 100× | `supplier-opening-draft.test.ts` "rejects a decimal or a malformed separator…" — `1 000,00`, `1,5`, `1 00`, `1,0000`, `1000,000`, `,1000`, `1,00,0`, `1٬00` all null; `openingRowStatus("1 000,00")` invalid | Yes (old reader returned 100000) |
| Page commits the inflated value | `supplier-opening-balance.test.tsx` "rejects a decimal-grouped amount with a row error instead of saving 100x" — error shown, save disabled, nothing captured | Yes |
| Valid grouping still accepted | `supplier-opening-draft.test.ts` "accepts plain digits and valid thousands grouping" — `1000`, `1,000`, `25 000`, `1 000 000`, `1,000,000`, `٢٥٬٠٠٠`, `۱۲۳` | (pins the accept side) |

## Grades

- `supplier-opening-draft.test.ts` — A− (thorough accept/reject matrix; a
  tab/newline separator and repeated-space boundary are unspecified)
- `router.test.ts` (contract + RPC) — B (faithful `/debts` invariant; the bound
  rejections are non-discriminating because `.int()` already bounds)
- `supplier-opening-balance.test.tsx` — B+
- `dashboard.test.tsx` — B+ (credit branch only; the positive label is asserted
  indirectly)

## Remaining (non-blocking)

- No page-level Arabic-Indic grouping case (covered at the parser unit level).
- Parser accepts a tab (`1\t000`) as a grouping separator; harmless.
- `/debts` group total negative rendering is untested and unlabeled.
