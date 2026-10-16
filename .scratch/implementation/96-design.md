# Issue #96 — Empty states on secondary screens: name the next action

Tier: **Standard** — UI copy + adjacent focus/navigation. The diff cannot move
stock, money or debt, and touches no auth or backup path, so none of the five
High-assurance failure modes apply.
Base SHA: `071a1c48` (`git rev-parse origin/develop` at lane start).
Branch: `issue-96-empty-states` (the worktree branch the parent created).

## Problem

Issue #94 fixed the four primary screens (sale, purchase, both debts groups,
dashboard recents). Every other screen's empty state still says what is missing
but not what to do next, so the owner lands on an empty secondary screen with no
way forward.

`operate.md` says empty states should teach the interface. Teaching means saying
something **true**: for a list that only reports what already happened, a button
is decoration, and inventing one sends the owner somewhere that does not help.

## Two treatments (from the issue)

1. **Adjacent action exists** — point at it with a real pressable control
   (contextual focus / tab switch / navigation). Screens: items, categories,
   expenses, reports, invoices.
2. **Read-only list, no honest action** — better explanatory copy that says what
   will appear there and why it is empty. Screens: activity, diagnostics, stock
   history, returns (both lists), purchase link-proposals, invoice payment and
   return histories, party-detail lists.

## Interface

No new component. Extend the existing
`apps/web/src/components/ui/empty-state.tsx`:

- `className?: string` — the surface (border/background/margin) the state sits
  on, so call sites stop wrapping it in a duplicated `rounded border bg-card`.
- `testId?: string` — preserve every existing `data-testid` on a wrapper the
  spec can scope to, instead of the whole page.

`EmptyState` keeps `{ title, hint, icon, action }`. A read-only list passes
`title` + `hint` only (no action). All display text lives in
`apps/web/src/lib/i18n.ts`.

## Changes

| Screen | File | Treatment | Group |
| --- | --- | --- | --- |
| Invoices list | `pages/invoices.tsx` | unfiltered: link to `/sale` + `/purchase`; filtered: clear-filter button, focus the filter that emptied it | B |
| Items list | `pages/items.tsx` | action opens the add tab, focus lands on the tab; no category yet → link to `/categories` | B |
| Categories | `pages/categories.tsx` | action focuses the adjacent name input | B |
| Expenses history | `pages/expenses.tsx` | unfiltered: focus the amount field; filtered: clear-filter action; no category: point at creating one | B |
| Reports breakdown | `pages/reports.tsx` | link to `/expenses` | B |
| Invoice payments | `pages/invoice.tsx` | copy varies (settled / just-saved / recordable); focus action only when a payment can be recorded | B |
| Invoice returns | `pages/invoice.tsx` | copy; focus action only when a returnable line exists | B |
| Activity log | `pages/activity.tsx` | copy only | A |
| Diagnostics | `pages/diagnostics.tsx` | copy only | A |
| Item history | `pages/stock.tsx` | copy only | A |
| Returns (customer) | `pages/returns.tsx` | copy only | A |
| Returns (supplier) | `pages/returns.tsx` | copy only | A |
| Party invoices | `pages/party-detail.tsx` | copy only, filter-aware | A |
| Party payments | `pages/party-detail.tsx` | copy only | A |
| Supplier account | `pages/party-detail.tsx` | copy only | A |
| Purchase link-proposals | `pages/purchase.tsx` | copy only | A |

### Judgement calls (the point of the issue)

- **Invoice payments / invoice returns are not purely read-only.** The history
  list is empty, but the record form is directly below it and enabled, so a
  focus action completes the task rather than decorating. Where the form is
  *disabled* (settled invoice, no returnable line) the action is omitted and the
  copy says why. This is the one place the issue's literal Group A list is
  judged individually, as the acceptance allows.
- **Purchase link-proposals** is a sub-panel with its own heading, not a page
  list; `EmptyState` would duplicate the heading, so it keeps its heading and
  turns the bare statement into a hinted explanation.
- **Invoice lines** (the product rows on an invoice) have no empty state: an
  invoice cannot be saved without at least one line, so the table is never
  rendered empty. The invoice screen's two real empty lists are payments and
  returns, handled above.
- **`itemsSearchEmpty` / `partyNoMatches` / `dashboardLowStockEmpty`** are
  "no match for a query/period" states, not "nothing exists yet" states; they
  already name the cause. Left as-is.

### Deliberately not touched — collision guard

- `pages/sale.tsx`, `pages/debts.tsx`, `pages/dashboard.tsx`, `pages/parties.tsx`
  — already carry #94 actions.
- `pages/supplier-opening-balance.tsx` — no empty list state to change.

## i18n keys added

Group A hints: `activityEmptyHint`, `diagnosticsEmptyHint`, `historyEmptyHint`,
`returnsEmptyHint`, `supplierReturnsEmptyHint`, `pmtEmptyHint`,
`pmtEmptySettledHint`, `pmtEmptyJustSavedHint`, `invoiceReturnsEmptyHint`,
`partyInvoicesEmptyHint`, `partyNoUnpaidHint`, `partyPaymentsEmptyHint`,
`supplierAccountEmptyHint`, `purchasesProposalEmptyHint`.

Group B: `invoicesEmptyHint`, `invoicesEmptyFilteredHint`,
`invoicesEmptyClearFilters`, `itemsEmptyHint`, `itemsEmptyAction`,
`itemsEmptyNoCategory`, `itemsEmptyNoCategoryHint`, `itemsEmptyNoCategoryAction`,
`categoriesEmptyHint`, `categoriesEmptyAction`, `expensesEmptyHint`,
`expensesEmptyFilteredHint`, `expensesEmptyClearFilters`, `expensesEmptyAction`,
`reportsEmptyHint`, `reportsEmptyAction`, `purchasesNew`.

The invoice payment/return actions reuse `pmtRecord` / `returnsRecordTitle`; the
invoices actions reuse `saleNew` / `purchasesNew`.

## Planned tests

Unit (bun, `apps/web/src/pages/*.test.tsx`), assertion by `i18n.t(key)` never a
hard-coded Arabic string:

- Every changed empty state renders its title + hint; the action exists where
  one was added and is *absent* on the read-only lists.
- The non-empty render asserts the empty state is absent.
- New `categories.test.tsx` (no file existed) covers the focus action and the
  create-then-clear flow.
- New `activity-empty.test.tsx` / `history-empty.test.tsx` cover the copy-only
  ledger states and assert no action control.
- Filtered branches: invoices status/kind, expenses period/category, party
  unpaid-only.

Playwright (`tests/e2e/01-empty-states.spec.ts`): a clean-room spec resets shop
records in `beforeAll`, then walks categories, items, invoices, expenses,
reports and the read-only returns lists, asserting the real next action is
operable and no action is invented.

## Evidence

- `.scratch/reviews/96/decisions.md` — the per-screen outcome table.
- `.scratch/reviews/96/screenshots/{before,after}/` — one screenshot per screen,
  list empty, base vs HEAD.
- `.scratch/reviews/96/<sha>-test-audit.md`, `<sha>-code-review.md`.

## Risks

- Replacing `<p>` with `EmptyState` changes the DOM (adds an `h3`). Mitigation:
  keep every `data-testid` on the `EmptyState` wrapper and re-run the page specs.
- Focus-based actions must move focus to a real, enabled control. Where the
  adjacent form can be disabled, the action is not rendered at all.
- Sibling lanes share the e2e ports: e2e runs use `DOKAN_PORT`/`DOKAN_WEB_PORT`
  and clear any stale listeners on the shared pair before a run.
