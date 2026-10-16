# Issue #96 — per-screen decisions (acceptance evidence)

Base `071a1c48`. Every `Group A` row is copy-only; every `Group B` row points at
an action that already existed on the screen. "No action" is an explicit outcome
for a read-only list, per the issue.

Screenshots: `.scratch/reviews/96/screenshots/{before,after}/<n>-<screen>.png`
(same harness run on base and on HEAD, list empty).

| # | Screen | Group | Outcome | File | Screenshot |
| --- | --- | --- | --- | --- | --- |
| 1 | Activity log | A | copy improved — `activityEmptyHint` says what the log records; deliberately **no action** (it only reports history) | `pages/activity.tsx` | `01-activity` |
| 2 | Diagnostics | A | copy improved — `diagnosticsEmptyHint` says which file is read and that nothing is expected of the owner; deliberately **no action** | `pages/diagnostics.tsx` | `02-diagnostics` |
| 3 | Returns — customer review | A | copy improved — `returnsEmptyHint` says returns are recorded from the invoice; deliberately **no action** | `pages/returns.tsx` | `03-returns-customer` |
| 4 | Returns — supplier history | A | copy improved — `supplierReturnsEmptyHint` says they come from the supplier account; deliberately **no action** | `pages/returns.tsx` | `04-returns-supplier` |
| 5 | Categories | B | action added — focuses the adjacent name field (`categoriesEmptyAction`); focus moves the caret, not a scroll | `pages/categories.tsx` | `05-categories` |
| 6 | Items — catalogue | B | action added — opens the add tab and focuses it; when no category exists, links to `/categories` instead (the add form cannot be completed) | `pages/items.tsx` | `06-items` |
| 7 | Invoices list | B | action added — unfiltered: links to `/sale` **and** `/purchase` (the list holds both); filtered: clears the filters and focuses the one that emptied the view | `pages/invoices.tsx` | `07-invoices` |
| 8 | Expenses history | B | action added — unfiltered: focuses the amount field; filtered: clears the filters; no category: opens the inline category create | `pages/expenses.tsx` | `08-expenses` |
| 9 | Report breakdown | B | action added — links to `/expenses`; the hint says to pick the same period here | `pages/reports.tsx` | `09-reports` |
| 10 | Item history | A | copy improved — `historyEmptyHint` says what the ledger records; deliberately **no action** | `pages/stock.tsx` | `10-stock-history` |
| 11 | Party detail — invoices | A | copy improved — general hint, or "all settled, drop the unpaid filter" when the filter is the cause; deliberately **no action** | `pages/party-detail.tsx` | `11-party-detail-invoices` |
| 12 | Party detail — payments | A | copy improved — `partyPaymentsEmptyHint`; deliberately **no action** | `pages/party-detail.tsx` | `12-party-detail-payments` |
| 13 | Party detail — supplier account | A | copy improved — `supplierAccountEmptyHint` names the four entry kinds; deliberately **no action** | `pages/party-detail.tsx` | `13-supplier-account` |
| 14 | Invoice detail — payments | A/B | copy improved, **action added only when a payment can be recorded** — focuses `pmt-amount`; a settled invoice or the just-saved card gets copy with no action | `pages/invoice.tsx` | `14-invoice-payments` |
| 15 | Invoice detail — returns | A/B | copy improved, **action added only when a line has units left to return** — focuses the first enabled return field; otherwise no action. Round 2: on a **purchase** invoice the panel points at the supplier account instead (the api refuses `RETURN_NOT_SALE`), and while a saved return's card is shown the action is withheld | `pages/invoice.tsx` | `15-invoice-returns` |
| 16 | Purchase link-proposals | A | copy improved — `purchasesProposalEmpty` now says what would appear and why it is empty; deliberately **no action**; keeps the panel's own `h3` (an `EmptyState` would duplicate it) | `pages/purchase.tsx` | `16-purchase-proposals` |

## Judgement notes

- **"Invoice lines" is judged as the two invoice-detail histories** (payments,
  returns). The invoice's product-line table has no empty state: an invoice
  cannot be saved without at least one line, so the table is never rendered
  empty.
- **Invoice payments / returns sit on the boundary.** The issue lists "invoice
  lines" as read-only, but both panels contain an enabled record form directly
  below the empty history. A focus action there completes the task rather than
  decorating it, so it is offered **only** while that form is usable and omitted
  with a reason when it is not. This is the individual judgement the acceptance
  explicitly allows.
- **Purchase link-proposals** is a sub-panel, not a page list; `EmptyState` would
  render a second `h3` under the panel's own, so it keeps the heading and turns
  the bare statement into a hinted explanation.
- **Query/period no-match states** (`itemsSearchEmpty`, `partyNoMatches`,
  `dashboardLowStockEmpty`, `partySettleNoDistribution`) are "nothing matched
  this query/period", not "nothing exists yet"; they already name the cause and
  are left unchanged.

## Review dispositions (rounds 1–2)

Evidence: `9c856bb-*.md` (round 1), `5a05144-*.md` (round 2); no blockers in either.

Fixed after round 1 / round 2:

- **items, failed category read** — the add action opened a form the owner can
  never complete (`submit` refuses without a category). It now has its own copy
  and a link to `/categories`, pinned by `items.test.tsx`.
- **Duplicated surface class** — the `className`-only prop moved the duplicated
  `rounded border border-border bg-card` into 12 call sites; `EmptyState` now
  takes `card` and the copies are gone.
- Coverage pins added: link-proposals copy + no control, invoice just-saved hint,
  invoices status-filter clear + focus return, and an i18n key-completeness spec
  (`toContain(i18n.t(key))` alone passes when the key is missing).
- `page-harness.tsx` comment no longer overclaims adoption.

Deliberate, with reason:

- **expenses failed history read** now shows the error, not "no expenses": a
  failed read is not an empty state, and the empty copy would be untrue.
- **invoices filtered copy with zero invoices total** — "no invoices match the
  filter" is vacuously true; clearing the filter lands on the unfiltered empty
  state with its create actions, so the flow self-corrects.
- **items action while the category read is pending** — the button is usable if
  the read succeeds and is replaced by the `/categories` link if it fails;
  gating on `!isPending` would instead flash a control-less state.
- **focus idiom** varies (ref / helper / querySelector) where the surrounding
  component already owned one; no single idiom was worth the churn.

## Verification

All commands re-run at the final code HEAD `afcb21f`, exit 0 unless noted:

- `bun run typecheck` — 4/4 workspaces
- `bun run lint` — clean
- `bun run --filter @dokan/web test` — 1167 pass, 0 fail
- `bun test ./scripts/` — 73 pass, 1 pre-existing skip (selection map)
- `DOKAN_PORT=4217 DOKAN_WEB_PORT=5273 bunx playwright test 01-empty-states` —
  6 passed
- Screenshot harness run on base and HEAD; 16 before / 16 after.

## Deferred (not silent — for the parent to route)

- `EmptyState` has no component-level spec (`card` class + `testId`
  passthrough). Low: the class is cosmetic and every call-site behaviour is
  covered. Owner: a tiny unit test when the component is next touched.
- `party-detail` pending-`detail` copy: unreachable at the current render gate
  (`detail.data === undefined` returns early), so no test; revisit if that gate
  changes.
- The invoices filtered-copy-when-totally-empty case is reasoned in this file
  but not asserted; it self-corrects through the clear action.
