# Test audit — issue #96 (empty states), round 2 — base `071a1c4`, prior head `9c856bb`, current head `5a05144`

Auditor: test-audit reviewer (3 lenses: Edge Case Hunter / Coverage Analyst / Quality Reviewer).
Round-1 evidence read: `.scratch/reviews/96/9c856bb-test-audit.md`. No source or test file was
edited by this audit; everything below was checked against the working tree at `5a05144` and
against an actual test run of the touched specs.

## What changed in `5a05144` (the round-1 fix commit)

```
 .scratch/reviews/96/9c856bb-code-review-spec.md | 20 ++   (evidence, committed)
 .scratch/reviews/96/9c856bb-code-review-standards.md | 41 ++
 .scratch/reviews/96/9c856bb-test-audit.md       | 379 +++
 apps/web/src/lib/i18n.test.ts                   |  57 +    (new key-completeness spec)
 apps/web/src/lib/i18n.ts                        |   2 +-   (categoriesEmptyAction copy)
 apps/web/src/pages/invoice.test.tsx             |   6 +
 apps/web/src/pages/invoices.test.tsx            |   8 +
 apps/web/src/pages/items.test.tsx               |  24 +-
 apps/web/src/pages/items.tsx                    |   6 +-   (isError ⇒ no action)
 apps/web/src/pages/purchase.test.tsx            |  15 +
```

Six of the round-1 items were dispositioned; the rest were left open (see below). This is a
**test-only fix round**: one production line changed (`items.tsx`), everything else is test.

## Actual test run (evidence)

`cd apps/web && bun test --timeout 20000 <file>`

| command | result |
| --- | --- |
| `bun test src/lib/i18n.test.ts src/pages/items.test.tsx src/pages/invoices.test.tsx src/pages/invoice.test.tsx src/pages/purchase.test.tsx` | **130 pass / 0 fail**, 5/5 files |
| `bun test src/pages/items.test.tsx` | 49 pass / 0 fail |
| `bun test src/pages/invoices.test.tsx` | 0 fail |

The two new round-1 tests were seen passing by name:
`items page tabs > offers no add action when the category read failed, because the form cannot be completed (#96)`
and `InvoicesPage empty states (issue #96) > offers to clear the filter when only the status filter is active`.
NOT run here: the Playwright spec (`tests/e2e/01-empty-states.spec.ts` — no server/browser) and
`bun run typecheck`/`lint`.

---

# Round-1 findings: verified status against the CURRENT files

| # | Round-1 rating | Status now | Evidence |
| --- | --- | --- | --- |
| E1 error half | 🟠 | **FIXED** | `items.tsx:799,812` — `categoriesUnavailable = categories.isError` short-circuits the action to `undefined`; new test `items.test.tsx:433-445` pins it and passes. |
| E1 pending half | 🟠 | **STILL OPEN** → N2 | `items.tsx:798` still `const noCategories = categories.data?.items.length === 0;` (see N2). |
| E3 just-saved branch | 🟠 | **FIXED** | `invoice.test.tsx:311-317` now asserts `pmtEmptyJustSavedHint`, `not pmtEmptyHint`, and no `pmt-empty-action` inside the existing successful-payment test. |
| E3 settled-wins combination (`remaining === 0 && savedPayment !== null`) | 🟠 (second half of E3) | **STILL OPEN** 🟡 | `invoice.test.tsx:253-262` renders `makeInvoice(0)` with **no** saved payment; `:311-317` has `remaining > 0`. No test exercises both at once. |
| E4 status-only clear + focus | 🟠 | **FIXED** | `invoices.test.tsx:222-229` clicks `invoices-empty-action`, waits for the 2 rows, asserts the empty state is gone and `document.activeElement === page.statusFilter()` (new accessor `invoices.test.tsx:133`). Indirectly proves the filter was cleared (rows only return unfiltered). |
| E4 global `document.querySelector` focus target (`invoices.tsx:135`) | 🟠 | **STILL OPEN** 🟡 | Source unchanged in `5a05144`; the new test asserts equality with the page-scoped element, which is the strong half, so the risk is now covered by the test rather than removed. |
| C2 purchase link-proposal | 🟠 | **FIXED** | `purchase.test.tsx:259-269` — new test pins `[data-testid="link-proposal-empty"]`, `purchasesProposalEmpty` copy, exactly one `h3` in the panel, and `querySelector("button, a") === null`. Passes. |
| C3 tautological i18n assertions | 🟠 | **FIXED (with residual)** | `i18n.test.ts` new describe enumerates 32 keys. I diffed the list against the full `071a1c4..HEAD` i18n diff: it is **exactly** the 32 added/rewritten #96 keys (missing/extra: none). Residual: the list is a hand-maintained duplicate of `i18n.ts` (no parity scan), and it cannot catch a *wired-to-the-wrong-key* swap — that is C6, still open. |
| E2 party-detail pending detail query | 🟠 | **STILL OPEN** | `party-detail.tsx:189,443-444` byte-identical to round 1; no deferred-detail test added. |
| E5 expenses filter + no-category | 🟡 | **STILL OPEN** | `expenses.tsx` / `expenses.test.tsx` untouched in `5a05144`. |
| E6 invoices paging reset on clear | 🟡 | **STILL OPEN** | `invoices.tsx:126-137` untouched; no pager test added. |
| E7 items transition out of no-category | 🟡 | **STILL OPEN** | `items.test.tsx` untouched for this path. |
| E8 `reset-e2e-records.mjs` delete ordering | 🟡 | **STILL OPEN** | Script and spec untouched. |
| E9 `empty-state.tsx` component spec | 🟡 | **STILL OPEN** | `find apps/web/src -name "*empty-state*"` → still only the source file. |
| C4 e2e breadth (6/16 surfaces) | 🟡 | **STILL OPEN** | `tests/e2e/01-empty-states.spec.ts` not in the `5a05144` diff. |
| C5 shared no-action helper | 🟡 | **STILL OPEN** | `grep -rn "expectNoAction" apps/web/src tests` → no match. |
| C6 absence-of-wrong-hint assertions | 🟡 | **STILL OPEN** | Only `invoice.test.tsx:258` and `party-detail.test.tsx:355` do the negative form; items/invoices/expenses pairs remain positive-only. |
| Q3 page-harness adoption, Q4 `waitFor` budgets | 🟡 | **STILL OPEN** | `tests/page-harness.tsx`, `items.test.tsx:196-202`, `reports.test.tsx:107-116` untouched. |
| Q7/Q8 e2e spec hygiene | 🟡 | **STILL OPEN** (Q8's justification still stands) | spec unchanged. |
| Q9 `purchase.test.tsx:197` no-op helper | 🟡 | **STILL OPEN (now redundant)** | The helper survives at `purchase.test.tsx:197`; the new test at `:259-269` supersedes it with a real assertion, so the helper is dead weight rather than a gap. |

---

# Lens 1 — Edge Case Hunter (new findings)

### N1 🟠 `apps/web/src/pages/items.tsx:810-813` — the failed-read branch now ships actionable copy with no action and no reason
```ts
title={t(noCategories ? "itemsEmptyNoCategory" : t("itemsEmpty"))}
hint={t(noCategories ? "itemsEmptyNoCategoryHint" : "itemsEmptyHint")}
action={ noCategories ? <Link…> : categoriesUnavailable ? undefined : <Button…> }
```
With `categories.isError` the action is correctly suppressed, but the copy stays the *actionable*
pair: `itemsEmpty` + `itemsEmptyHint` = "أنشئ أول منتج بأسعار الشراء والبيع ليظهر في القائمة."
The owner is told to create a product, is offered no control, and is not told why (categories
could not be read). This is a milder version of the dead end #96 removed — the neighbouring
`expenses` page already models the correct shape with a dedicated read-failure explanation
(`expenses-history-error`, `expenses.test.tsx:1393-1400`). Worse, the new test **locks the
mismatch in**: `items.test.tsx:440` asserts `toContain(i18n.t("itemsEmptyHint"))` for exactly the
state where that hint is wrong.
**Missing test:** assert the failed-category empty state does **not** contain `itemsEmptyHint`
and does contain a categories-unavailable explanation (either a new key, or reuse of an
`items-empty-error` box) while still offering no action.
**Risk:** 🟠 subtle bug — the copy promises an action the UI deliberately withholds; the test
suite now certifies it.

### N2 🟠 `apps/web/src/pages/items.tsx:798,812` — the pending-category window still offers the dead-end add action (round-1 E1, unfixed half)
`categories.data` is `undefined` while `categoriesList` is in flight **and** during react-query's
retry backoff after a failure (`isError === false` until the last retry settles). In both windows
`noCategories === false` and `categoriesUnavailable === false`, so the actionable
`items-empty-action` button is rendered; clicking it opens the add panel whose category select has
no options yet — the exact "the add form requires one it cannot create" dead end of `items.tsx:791-795`.
The new test deliberately tolerates this ("the action exists while it is pending",
`items.test.tsx:439`) and then only waits for the settled error, so the window is still unpinned.
**Missing test:** mount with `categoriesList.queryFn` returning a never-resolving promise (the file
already has a deferred-promise pattern for `itemsGate`) while `itemsList` is already empty; assert
`[data-testid="items-empty-action"]` is `null` (or that the no-category copy is shown). The
predicate fix is one line, and the stronger variant already exists on the expenses page:
`categories.data !== undefined && categories.data.items.length === 0`.
**Risk:** 🟠 would show a dead-end action on a slow/failing-then-retrying category read.

### N3 🟡 `apps/web/src/pages/items.test.tsx:439-443` — the new error test depends on `retry: false`
The wait budget is the file-local `waitFor` (120 × 20 ms ≈ 2.4 s, `items.test.tsx:196-202`) and the
test only passes deterministically because the mount creates
`new QueryClient({ defaultOptions: { queries: { retry: false } } })` (`items.test.tsx:310,328`).
React-query's default exponential retry delay is ~1 s + 2 s + 4 s, i.e. **longer than the budget**,
so if the harness ever drops `retry: false` this test turns into a flake, not a failure with a
clear cause. **Missing guard:** an explicit comment/assert that the query client disables retry, or
a budget above react-query's default retry ceiling. **Risk:** 🟡 flake source only.

### N4 🟡 `apps/web/src/pages/invoices.test.tsx:224-229` — the clear-filter test asserts the *effect*, not the request
The round-1 ask was `requests.at(-1)?.status === undefined` **and** the focus assertion. The fix
does the focus assertion and `page.numbers().length === 2`; the request payload is never inspected.
Since the list body is what the fixture derives rows from, a wrong request would also fail this
test — but the failure message would point at row count, not at the filter that leaked.
**Risk:** 🟡 diagnostics quality only.

---

# Lens 2 — Coverage Analyst

- **Acceptance criteria:** the 16 design-doc rows are still covered as in round 1; row 16
  (purchase link-proposals) moved from **gap** to **covered** by `purchase.test.tsx:259-269`. Rows
  with a remaining unpinned branch: 6 (items, E1 pending), 7 (invoices, E6 paging), 8 (expenses,
  E5 combination), 11 (party invoices, E2), 14 (invoice payments, E3 settled-wins).
- **Diversity:** unchanged and good — every changed empty branch still has a non-empty
  counter-test; the two new tests are behaviour tests, not copies of an existing pattern (one
  drives a rejected query, one drives focus).
- **Duplicates:** the new i18n key test duplicates the key strings already in `i18n.ts` (accepted
  trade-off, flagged as residual under C3). `purchase.test.tsx:197` `emptyState()` is now a
  redundant weaker twin of the new `empty()` (Q9).
- **Missing:** the two round-1 blockers that remain (E1 pending, E2) plus N1, and the second E3
  combination. Nothing else changed the coverage picture.
- **e2e:** still 6 of 16 surfaces, still zero of the filtered/no-category/payments branches
  (`tests/e2e/01-empty-states.spec.ts` untouched).

# Lens 3 — Quality Reviewer

**Grade: B+ (up from B).** The new tests are exactly the right shape: they assert the *absence* of
things (`not.toContain(pmtEmptyHint)`, `querySelector("button, a") === null`,
`items-empty-action === null`, `h3` count) rather than only presence, they use stable `data-testid`
hooks, and the i18n spec closes the round-trip hole for all 32 keys at the source. Async handling in
all five touched specs is correct (no missing `await`; the focus assertions after a synchronous
`act()` click are valid because `focus()` runs in the click handler). Isolation unchanged and good
(`categoriesListFails` is reset in `beforeEach:376`, matching the file's knobs pattern).
Held back by: the N1 copy/action mismatch that the new test now asserts as correct, the accepted-but-
unpinned pending window (N2), the still-unadopted `page-harness.tsx` and its divergent `waitFor`
budgets (Q3/Q4), and the hand-maintained i18n key list.

---

# Synthesis — ranked fix list for round 3

| # | Rating | Item | Action |
| --- | --- | --- | --- |
| N1 | 🟠 | `items.tsx:810-813` failed-read branch shows actionable copy with no action and no explanation; the new test asserts that copy as correct | give the branch its own explanation copy (or an error box, like `expenses-history-error`) and change `items.test.tsx:440` to assert it |
| N2 | 🟠 | `items.tsx:798` pending/retrying category read still offers the dead-end add button | predicate `categories.data !== undefined && categories.data.items.length === 0`, plus a never-resolving-query test |
| E2 | 🟠 | `party-detail.tsx:189,443-444` wrong copy while the detail query is pending | deferred-detail test (as round 1) |
| E5/E6/E7/C6/E3b | 🟡 | combination, paging-reset, transition and absence-of-wrong-hint coverage | extend the existing specs |
| C4/E9/C5/Q3/Q4/E8/Q7/Q9 | 🟡 | e2e breadth, component spec, shared helpers, harness adoption, waitFor budgets, reset ordering, dead helper | test-only refactor / follow-ups |

No 🔴 finding: every state that is currently reachable and settled behaves as documented, and the
three specs that matter for this round (items, invoices, invoice) pass. The two 🟠s are a shipped
copy/action mismatch on the item error branch (N1) and the still-unhandled pending window (N2);
both are one-line source changes with a test each.

## Residual risks / not verified by this audit
- Playwright spec never executed here (no server/browser); the round-1 claims about it remain
  claims.
- `bun run typecheck` / `bun run lint` not re-run.
- Scope = the round-1 fixes (`9c856bb..5a05144`) plus re-verification of every round-1 finding
  against the current tree; files outside the #96 change set were not re-audited.
- `5a05144` commit message says "a FAILED category read…" — the round-1 finding asked for the
  **pending** window too; E1 is therefore only half-closed, which the commit message does not claim
  otherwise but a future reader could read as fully closed.
