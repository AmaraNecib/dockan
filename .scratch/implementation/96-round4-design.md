# Issue #96 round 4 — the expenses clear-focus defect, and the test I could not write

Tier: **Standard**. Justification: keyboard focus and test-only changes in two
`apps/web` pages; no money, stock, debt-direction, auth or backup path is
reachable from the diff. Base: `origin/issue-96-empty-states` (`5144100`).

## What is already fixed, and what is not

Greptile's finding 2 (the invoice focus) is an **echo**: `5144100` already made
the invoice clear follow the last *changed* filter via `lastFilterRef`. It is not
reworked here.

Greptile's finding 1 is live. `apps/web/src/pages/expenses.tsx` (round 3) added
`clearHistoryFilters()` for the filtered-empty history, but the handler only
resets state: the `expenses-empty-action` button it is attached to is replaced by
the table (or by a hint-only empty state), so a keyboard user's focus falls to
`document.body`. Same class as the invoice defect: **an action that replaces
itself must hand focus to something that survives.**

## The fix

`clearHistoryFilters()` gains a focus hand-off, executed **before** the state
updates so it lands while the button is still mounted, and it uses the invoice
rule — focus follows the filter that emptied the view:

| Last history filter changed | Focus target after clearing |
| --- | --- |
| a category pill (`toggleCategory`) | that pill, `expense-filter-<id>` |
| the "all categories" pill | the same pill (`expense-filter-all`) |
| a range preset (`applyFilterChange`) | `expense-range-preset` |
| a CUSTOM bound (`applyBoundEdit`, applied) | `expense-range-preset` |
| nothing recorded | `expense-range-preset` (always rendered) |

Why not "always the range preset", even though the brief names it as the natural
control: with a category filter the preset did not narrow the view, so focusing
it sends the keyboard user to an unrelated control — the exact complaint
Greptile raised on the invoices page, and the reason `5144100` exists. The preset
is therefore the **fallback**, not the rule. It is also the pill's fallback when
the chosen category id is no longer in `categoryOptions` (the pill would not
render, and `querySelector` would return `null`, dropping focus a second time).

Implementation note: `firstSelectedCategoryId` is read from the state *before*
`setSelectedCategoryIds(new Set())`. A `useEffect` would run after the empty
state has already re-rendered without the button, so the hand-off must be
synchronous inside the click handler (the same shape as `5144100`).

## Sweep — every empty-state action on the expenses page that destroys itself

| Action (`data-testid`) | Destroys itself? | Focus after the click | Needs work? |
| --- | --- | --- | --- |
| `expenses-empty-action` — clear filters (filtered empty) | **yes** — button is replaced by the table / hint-only empty state | dropped to `body` | **fixed here** |
| `expenses-empty-action` — create the first category | yes — replaced by the inline form | `expense-category-name` via the existing `nameRef` effect | no |
| `expenses-empty-action` — focus the amount field | no — the button's own target is the persistent `expense-amount` input | `expense-amount` | no |
| `expense-category-empty-action` (record card) | yes — replaced by the inline form | `expense-category-name` via the same effect | no |
| `invoices-empty-action` — clear filters | yes | last-changed filter (shipped at `5144100`) | no |

## The tests

Both must **fail on the pre-fix page file**. That is the acceptance condition.

1. `apps/web/src/pages/invoices.test.tsx` — kind set to SALE **first**, then
   status set to PARTIAL (neither seeded row is PARTIAL, so the list empties).
   Clearing must leave focus on the **status** trigger. The pre-`5144100` rule
   `kind !== "" ? kind : status` focuses **kind** here, so this test fails on it:
   it is the first test that can tell the two rules apart.
2. `apps/web/src/pages/expenses.test.tsx` — the default month has a row and a
   category filter empties the list. Clearing must leave focus on the category
   pill that emptied it (a persistent control). Pre-fix, focus is `body`.

### Select driving — the point of this round

The invoice test file's local `choose()` opens the trigger with raw `MouseEvent`s
and then takes the first globally-queried `[role='option']` whose text *contains*
the label. Base UI keeps a **closed** popup mounted, so with two selects on the
page both option sets are in the DOM at once and the global query can resolve
into the popup that is not the one just opened; the choice then never commits and
the second filter stays "all". That is why round 3 could not write the test.

The new tests use `chooseOption(trigger, label)` from
`apps/web/src/tests/select-driver.ts`, which scopes the option search to the
listbox named by the trigger's `aria-controls` (`findOption(label, trigger)`).
The discrimination evidence records both paths: the driver commits the second
select, the raw path does not.

## Risks

- Focus lands via `document.querySelector` on a testid. If a testid is renamed
  the focus silently drops; the tests assert `document.activeElement` identity,
  so a rename fails a test rather than rotting.
- The pill focus target depends on the clicked pill still being rendered from
  `categoryOptions`. The fallback chain covers the refetched-away case.
- No E2E spec is added: the behaviour is a happy-dom-observable focus move on a
  page whose E2E flow already exists (`tests/e2e/expense-reports.spec.ts`).
  Recorded as deferred rather than silently skipped.
