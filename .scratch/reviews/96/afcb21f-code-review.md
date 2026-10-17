# Issue #96 — final review (round 3), HEAD `afcb21f`

Axes: Standards + Spec. Delta since `5a05144` (EmptyState `card`, items failed-read, decisions.md).
Evidence: `git diff 5a05144..HEAD`; `bun run typecheck` exit 0; root `oxlint` exit 0; targeted
`bun test --timeout 10000` on 10 files → 126 pass / 0 fail.

## Standards
- **Correct.** Round-2 smell "duplicated surface class" is **resolved**. `empty-state.tsx:35` now
  renders `card && "rounded border border-border bg-card"`; all 13 `EmptyState` call sites pass
  `card` with spacing-only `className` (`activity.tsx:122`, `categories.tsx:68`, `diagnostics.tsx:123`,
  `expenses.tsx:578`, `invoices.tsx:115`, `items.tsx:805`, `party-detail.tsx:442/491/535`,
  `reports.tsx:156`, `returns.tsx:49/230`, `stock.tsx:347`). No `EmptyState` call site retains the
  literal; `className` still overrides (ordering in `cn` is call-site-last). No new smell: no hunk
  added abstraction, duplication, or a switch cascade. `page-harness.tsx` comment no longer overclaims.
- **Note (Low, pre-existing/out of delta).** Surface literal still hand-rolled outside `EmptyState`
  (`dashboard.tsx:276`, `getting-started-panel.tsx:34,74`).
- **Note (Low, round-2 #3 still open).** "categories unavailable" has two predicates: `items.tsx`
  `categories.isError` vs `expenses.tsx:181` `categories.data === undefined`.
- **Note (Info).** Heterogeneous focus idiom (ref / helper / querySelector) unchanged; decisions.md
  disposes it as deliberate — accepted.

## Spec
- **Correct.** Items failed-read dead end fixed: `items.tsx:794-809` selects
  `itemsEmptyCategoriesUnavailable{,_Hint,_Action}`; keys added (`i18n.ts:190-192`) and enumerated in
  `i18n.test.ts:311`; `items.test.tsx:433` pins copy plus `href=/categories`. Pointing a failed read
  at `/categories` (which retries the read) is an honest, non-dead-end step.
- **Note (Low, unchanged).** "Invoice lines" has no empty branch; `decisions.md` still substitutes
  the invoice-detail histories — documented, not implemented.
- **Note (Low).** Round-2 invoices finding (filtered copy when the shop has zero invoices) rests on
  `decisions.md`'s self-correction argument, unasserted in tests.
- **Blocker: none.** No regressions introduced by the delta. E2E not re-run here (decisions.md
  records 6 passed).
