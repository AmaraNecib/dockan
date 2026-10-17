# Test audit — issue #96 (empty states), base `071a1c4` → head `9c856bb`

Auditor: test-audit reviewer (3 passes: Edge Case Hunter / Coverage Analyst / Quality Reviewer).
No source or test file was edited. Everything below was checked against the actual
files at `9c856bb` and against an actual test run of the changed spec files.

## What was audited

Source (16 empty-state call sites across 12 files):
`components/ui/empty-state.tsx`, `lib/i18n.ts`, `pages/{activity,categories,diagnostics,expenses,invoice,invoices,items,party-detail,purchase,reports,returns,stock}.tsx`

Tests:
- new `pages/activity-empty.test.tsx`, `pages/history-empty.test.tsx`, `pages/categories.test.tsx`
- new `tests/e2e/01-empty-states.spec.ts` (+ `tests/e2e-selection.map.json`, `scripts/reset-e2e-records.mjs`)
- extended `pages/{expenses,reports,invoices,invoice,invoice-returns,returns,party-detail,diagnostics,purchase}.test.tsx`
- new shared `tests/page-harness.tsx`

## Actual test run (evidence)

`cd apps/web && bun test --timeout 20000 <file>` for all 11 changed/added spec files, run concurrently:

| file | exit |
| --- | --- |
| src/pages/activity-empty.test.tsx | 0 |
| src/pages/categories.test.tsx | 0 |
| src/pages/diagnostics.test.tsx | 0 |
| src/pages/expenses.test.tsx | 0 |
| src/pages/history-empty.test.tsx | 0 |
| src/pages/invoice.test.tsx | 0 |
| src/pages/invoice-returns.test.tsx | 0 |
| src/pages/invoices.test.tsx | 0 |
| src/pages/party-detail.test.tsx | 0 |
| src/pages/reports.test.tsx | 0 |
| src/pages/returns.test.tsx | 0 |

Aggregate: **195 pass / 0 fail, 11/11 files exit 0.** All pass counts matched the
counts claimed in the diff's own commit messages for these files.
NOT run here: the Playwright spec (`tests/e2e/01-empty-states.spec.ts`) — it needs a
live server + browser; `.scratch/reviews/96/decisions.md` claims "6 passed" and
"1164 pass" for the whole web suite; those two numbers are **unverified by this audit**.
`bun run typecheck` / `lint` also unverified here.

---

# Pass 1 — Edge Case Hunter

### E1 🟠 `apps/web/src/pages/items.tsx:796` — "no category" branch is wrong while the categories query is pending or errored
```ts
const noCategories = categories.data?.items.length === 0;   // false when data === undefined
```
`categories.data` is `undefined` both while `categoriesList` is in flight **and** after it
fails. In both windows `noCategories === false`, so the products empty state renders the
*actionable* copy (`itemsEmpty` + `itemsEmptyHint`) and a button that opens the add tab —
whose category select is empty. That is precisely the dead end #96 set out to remove
("the add form requires one it cannot create", `items.tsx:791-795`).
The only fixture in the tests resolves instantly (`items.test.tsx:66-70`,
`queryFn: async () => ({ items: categories })`), and the error path is never exercised, so
the window is invisible to the suite.
**Missing test:** mount `ItemsPage` with `categoriesList.queryFn` returning a
never-resolving promise (and a second run where it rejects) while `itemsList` is already
empty; assert `items-empty` shows `itemsEmptyNoCategory` and that no `/sale`-style
`items-empty-action` button into the add form is offered. (Or fix the predicate to
`categories.data !== undefined && categories.data.items.length === 0` — the expenses page
already does exactly this with `categoriesUnavailable`, `expenses.tsx:178-182`, which is why
it is the stronger implementation.)

### E2 🟠 `apps/web/src/pages/party-detail.tsx:187-190, 439-445` — wrong copy while the party-detail query is still loading
```ts
const partyHasNoInvoices = detail.data?.stats.invoiceCount === 0;   // false when detail is pending
...
title={showUnpaidOnly && !partyHasNoInvoices ? t("partyNoUnpaid") : t("partyInvoicesEmpty")}
```
`detail` (`party-detail.tsx:169-171`) and `invoiceList` (`:199`) are separate queries, and the
empty branch is keyed only on `invoiceList.data?.total === 0`. So a slow/erroring
`customersGet` with a fast empty `invoicesList` renders the **unpaid-only** title
("لا توجد فواتير غير مدفوعة") for a customer that simply has no invoices — the exact bug the
`partyHasNoInvoices` guard was added to fix. Every existing test resolves both fixtures
before mounting.
**Missing test:** hold the detail query open (deferred promise, as `items.test.tsx` already
does with `itemsGate`) while the invoice list resolves `{ items: [], total: 0 }`; assert the
container text contains `i18n.t("partyInvoicesEmpty")` and `partyInvoicesEmptyHint` and
**not** `partyNoUnpaid`.

### E3 🟠 `apps/web/src/pages/invoice.tsx:188-190` — the `pmtEmptyJustSavedHint` branch has no test at all
```ts
hint={remaining === 0 ? t("pmtEmptySettledHint") : savedPayment !== null ? t("pmtEmptyJustSavedHint") : t("pmtEmptyHint")}
action={remaining === 0 || savedPayment !== null ? undefined : (<Button data-testid="pmt-empty-action" ...>)}
```
`grep -rn "pmtEmptyJustSavedHint" apps/web/src` returns the i18n definition and this line
only — no spec references it. The two tested states are the recordable one
(`invoice.test.tsx:238-250`) and the settled one (`:253-262`). The transient just-saved state
(payment posted, list not refetched yet, `payments.length === 0`) is the state the branch
exists for, and both its copy and its action suppression are unverified.
**Missing test:** render `PaymentPanel` with `remainingAmount > 0`, submit a payment
successfully, and while `payments` is still empty assert the empty state contains
`i18n.t("pmtEmptyJustSavedHint")`, does **not** contain `pmtEmptyHint`, and offers no
`pmt-empty-action`; then let the list refetch with the row and assert the state disappears.
Also untested: `remaining === 0 && savedPayment !== null` (settled wins) — assert the settled
hint in that combination.

### E4 🟠 `apps/web/src/pages/invoices.tsx:126-137` — the status-only clear-filter path never clicks the action
```ts
const filter = kind !== "" ? "invoices-kind-filter" : "invoices-status-filter";
setKind(""); setStatus(""); pager.reset();
document.querySelector<HTMLElement>(`[data-testid="${filter}"]`)?.focus();
```
The kind branch is fully asserted (`invoices.test.tsx:224-232`: list returns, focus lands on
`invoices-kind-filter`). The status branch (`invoices.test.tsx:210-219`) only asserts the two
labels; it never clicks. A wrong `data-testid` on the status trigger, or the focus call
silently returning because the element is mid-rerender, leaves keyboard focus on `<body>`
with no failing test. `document.querySelector` is also global, not scoped to the page
(`invoices.tsx:135`), so a stale mounted page from a previous test could take the focus and
still pass.
**Missing test:** choose status = `invoicesStatusPartial`, `waitFor` the empty state, click
`invoices-empty-action`, then assert `requests.at(-1)?.status` is `undefined` **and**
`document.activeElement === page.statusFilter()` (mirroring the kind test exactly).

### E5 🟡 `apps/web/src/pages/expenses.tsx:576-604` — filter-active + no-category combination is untested
The hint/action chain tests `historyFiltersActive` first, so with **both** a category filter
applied and no expense categories at all, the state shows "no expenses match the period or
category" + "clear filters" and never tells the owner the record form is unusable — the
no-category branch (`expensesEmptyNoCategory` / `expenseCategoryCreateFirst`) is skipped. The
suite covers each condition separately (`expenses.test.tsx:1316-1380`) but never both.
**Missing test:** empty category fixture **and** `expense-filter-all`/a category filter
selected, assert which of the three hints is authoritative and that the offered action
actually produces a usable form (the clear-filter action must leave the amount field
disabled-or-not consistent with the copy shown).

### E6 🟡 `apps/web/src/pages/invoices.tsx:126-137` — no paging interaction test for the filter-clear action
`pager.reset()` is called, but the invoices suite has no test that moves to a later page
first. The expenses suite added exactly this test for its own clear action
(`expenses.test.tsx` — "keeps a later history page…" / "resets to page one only when
clearing a bound that was applied"), invoices has none.
**Missing test:** seed `total` large enough for a second page, click `invoices-pager-next`,
apply the kind filter, click `invoices-empty-action`, and assert the last request has
`offset === 0`.

### E7 🟡 `apps/web/src/pages/items.tsx:801-812` — no test for the transition out of the no-category branch
`items.test.tsx:894-916` asserts the `/categories` link exists when the category fixture is
empty, and `:878-892` asserts the add-tab action when a category exists — but no test covers
creating the category and landing back on the now-actionable state (the exact journey the
link sends the owner on). The e2e spec covers the opposite starting point
(`items: the empty state opens the add tab once a category exists`).
**Missing test:** mount with no categories, click the `/categories` link target state by
pushing a category into the fixture + invalidating `categoriesList`, and assert `items-empty`
now shows `itemsEmpty`/`itemsEmptyAction` and that clicking it opens `#items-panel-add`.

### E8 🟡 `scripts/reset-e2e-records.mjs:41-43` — the new `DELETE FROM categories` has no ordering evidence
The reset now also deletes item categories (previously only records). `01-empty-states.spec.ts:14-24`
runs it in `beforeAll`, and the spec is wired into three `tests/e2e-selection.map.json` rules
(`apps/web/src/pages/{items,expenses,returns}.tsx`), so it can be scheduled next to
`catalog-scan.spec.ts` / `stock-ledger.spec.ts` / `expense-reports.spec.ts`. The comment
("the numeric prefix keeps it ahead of the feature specs") is an assumption about worker
scheduling, not a tested invariant, and `expense_categories` surviving while `categories`
does not is asserted nowhere.
**Missing test/evidence:** a spec-level assertion (or a documented ordering guarantee) that
a spec seeding items after this reset re-creates its own category, e.g. have one of the
touched specs assert its category exists at `beforeEach` instead of relying on prefix order.

### E9 🟡 `apps/web/src/components/ui/empty-state.tsx:26-46` — the two new props are never tested in isolation
`className` (merged via `cn`) and `testId` (rendered as `data-testid`) are the only new
component contract, and there is no component-level spec for `empty-state.tsx` at all
(`find apps/web/src -name "*empty-state*"` → only the source file). All call sites rely on
`testId` working, so a regression in the wrapper would break ~15 tests loudly, but the
`className` merge (surface classes vs. the base `flex flex-col …` string) is unverified, as is
the "no action ⇒ no interactive element" contract at the component level.
**Missing test:** `components/ui/empty-state.test.tsx` asserting base + extra classes both
survive (e.g. `items-center` and a caller's `mt-4`), `data-testid` is passed through, and an
omitted `action` renders no `button`/`a`.

---

# Pass 2 — Coverage Analyst

### Criterion → test map (all 16 design-doc rows, `.scratch/implementation/96-design.md`)

| # | Screen | Group | Test | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Activity log | A | `activity-empty.test.tsx` (empty + non-empty) | covered |
| 2 | Diagnostics | A | `diagnostics.test.tsx:133,169-175` | covered |
| 3 | Returns (customer) | A | `returns.test.tsx:155-166` (+ non-empty) | covered |
| 4 | Returns (supplier) | A | `returns.test.tsx:240-292` (empty/non-empty/error) | covered |
| 5 | Categories | B | `categories.test.tsx` (focus, create-flow, non-empty) | covered |
| 6 | Items | B | `items.test.tsx:878-916` | covered, except E1/E7 |
| 7 | Invoices list | B | `invoices.test.tsx:197-236` | covered, except E4/E6 |
| 8 | Expenses | B | `expenses.test.tsx:1300-1400` (5 branches incl. error) | covered, except E5 |
| 9 | Reports | B | `reports.test.tsx` (empty + non-empty) | covered |
| 10 | Item history | A | `history-empty.test.tsx` | covered |
| 11 | Party invoices | A | `party-detail.test.tsx:348-360, 792-806` | covered, except E2 |
| 12 | Party payments | A | `party-detail.test.tsx:808-819` | covered |
| 13 | Supplier account | A | `party-detail.test.tsx:821-832` | covered |
| 14 | Invoice payments | A/B | `invoice.test.tsx:238-262` | covered, except E3 |
| 15 | Invoice returns | A/B | `invoice-returns.test.tsx:286-308` | covered |
| 16 | Purchase link-proposals | A | **none** | **gap — C2** |

### C2 🟠 Row 16 (purchase link-proposals) has no real assertion of the new copy or the new testid
`pages/purchase.tsx:435` changed the string and added `data-testid="link-proposal-empty"`.
The only related assertion is the helper at `purchase.test.tsx:197`
(`container.textContent?.includes(i18n.t("purchasesProposalEmpty"))`) used once at
`purchase.test.tsx:252`. `grep -rn "link-proposal-empty" apps/web/src tests/e2e` → **no
match**: the new testid is dead surface. Nothing distinguishes "the new explanation is
rendered" from "some text is present", and the panel heading duplication concern from the
design doc ("an `EmptyState` would duplicate its `h3`") is not asserted either
(no check that `link-proposal` contains exactly one heading).
**Missing test:** assert `[data-testid="link-proposal-empty"]` exists and contains
`i18n.t("purchasesProposalEmpty")`, that `[data-testid="link-proposal"]` has exactly one
`h3`, and that the empty panel offers no `button`/`a`.

### C3 🟠 Every new copy is asserted tautologically — a missing/renamed i18n key ships silently
The unit specs assert `expect(empty?.textContent).toContain(i18n.t("someKey"))`
(e.g. `activity-empty.test.tsx:44-45`, `history-empty.test.tsx:52-53`,
`returns.test.tsx:160-161`, `party-detail.test.tsx:355-357`, `invoice.test.tsx:243-244`,
`expenses.test.tsx:1311-1312`). i18next returns the **key itself** when a translation is
missing, so if `activityEmptyHint` (or any of the 25 new keys) were absent from
`resources.ar`, `i18n.t("activityEmptyHint") === "activityEmptyHint"`, the component would
render that key, and the assertion still passes. Same for a text that was never wired:
`grep` proves the keys exist today, but nothing in the suite would catch their removal.
Only the e2e spec uses literal Arabic, and only for 6 of the new strings.
**Missing test:** a key-completeness spec, e.g. iterate the new key list and assert
`i18n.t(key)` differs from `key` and is non-empty (plus a `not.toContain("{{")` guard for the
interpolation keys), or a resource-parity check against the keys actually referenced from
`apps/web/src/pages`.

### C4 🟡 e2e coverage is 6 of 16 surfaces; the two most DOM-behavioural branches are browser-untested
`tests/e2e/01-empty-states.spec.ts` covers categories, items (category present), invoices
(unfiltered only), expenses (unfiltered only), reports, and the two returns lists. Missing at
browser level: items no-category, invoices **filtered** clear-filter (+ its focus target),
expenses **filtered** and **no-category**, invoice payments (settled/just-saved/recordable),
invoice returns (returnable/no-line), all three party-detail lists, activity, stock history,
diagnostics, purchase proposals. The focus-target branches (`invoices.tsx:135`,
`items.tsx:207`, `categories.tsx:69`, `expenses.tsx:600`, `invoice.tsx:190`) are exactly the
place jsdom is least trustworthy (scroll-into-view, real tab order, `:focus-visible`), and
the e2e spec exercises only three of them.
**Missing test:** add the filtered invoices branch (goto `/invoices`, pick the status filter,
click clear, assert `:focus` is on the status trigger) and the invoice-payments
"settled ⇒ no action" branch to `01-empty-states.spec.ts`; these need the seeded-state reset
the spec already performs.

### C5 🟡 The same "read-only ⇒ no action" assertion is copy-pasted in six files
`expect(empty?.querySelector("button, a")).toBeNull()` appears in `activity-empty.test.tsx`,
`history-empty.test.tsx`, `diagnostics.test.tsx`, `returns.test.tsx` (×2),
`party-detail.test.tsx` (×3) and `tests/e2e/01-empty-states.spec.ts` (×2). Correct, but it is
the central acceptance rule of the issue and would be better as one shared helper
(`expectNoAction(empty)`) so a future read-only surface cannot silently omit it.

### C6 🟡 No negative test for the "wrong hint" direction on most screens
Only two places assert the *absence* of the other hint (`invoice.test.tsx:257`
`not.toContain(pmtEmptyHint)`, `party-detail.test.tsx:357` `not.toContain(partyInvoicesEmptyHint)`).
The invoices filtered/unfiltered pair, the expenses trio, and the items pair are asserted
positively only, so a swapped ternary (e.g. `invoicesEmptyHint` shown to a filtered view)
would still pass the "contains X" assertions in the same test.

### Coverage that is genuinely good (no findings)
- Every changed empty branch has a **counter-test** for the non-empty render
  (activity, diagnostics, stock history, categories, items, invoices, expenses, reports,
  returns ×2, party-detail ×3) — the suite is not "all same pattern, empty only".
- The two error-vs-empty distinctions that existed as new code paths are covered:
  `expenses-history-error` (`expenses.test.tsx:1393-1400`) and
  `supplier-returns-error` (`returns.test.tsx:283-291`).
- The two "action must not be offered when the adjacent form is dead" judgement calls from
  the design doc are both covered: settled invoice (`invoice.test.tsx:253-262`) and
  non-returnable invoice (`invoice-returns.test.tsx:286-296`).
- `invoices.test.tsx:40-50` added a `beforeEach` seed restore so a mid-test failure cannot
  leak fixture mutations into the next test — a real isolation fix.

---

# Pass 3 — Quality Reviewer

**Grade: B** (solid, behaviour-first tests with real focus/state assertions; held back by the
tautological i18n assertions, three uncovered branches, and an unfinished shared harness.)

### Q1 ✅ Test names and intent statements are unusually good
Each name states the behaviour and the reason, e.g.
`it("offers to clear the filter when a period or category filter is active")`,
`it("does not offer a dead action on a settled invoice with no payment rows (#96)")`,
`it("shows the error box, not the empty state, when the read fails")`. The `#96` tag on the
describe block makes the intent greppable. Comments explain *why* an assertion exists
("the honest action puts the caret in the field the form already offers").
No action needed.

### Q2 🟠 Assertion quality is capped by the `i18n.t` round-trip (same defect as C3)
`toContain(i18n.t("key"))` proves the component rendered *a* translation call, not that the
copy is right or present. Where the tests do assert independently — literal Arabic in the e2e
spec, `document.activeElement`, `href.split("?")[0]`, `querySelector("button, a") === null`,
`not.toContain(otherHint)` — they are strong. The fix is the C3 key-completeness spec rather
than rewriting 40 assertions.

### Q3 🟡 The shared `page-harness.tsx` is only half adopted
`tests/page-harness.tsx:13-18` states "every page spec otherwise reimplemented the same
mount + act-wrapped poll + unmount dance. One definition keeps the act() convention … identical
across specs." In fact the new files use it (`activity-empty`, `history-empty`, `categories`)
while five touched specs still carry private copies:
`reports.test.tsx:83-127` (`mountPage` + `mountedRoots`), `expenses.test.tsx` (`mountPage` +
`ui.waitFor`), `invoices.test.tsx:96-113`, `invoice.test.tsx`, `party-detail.test.tsx`, and
`items.test.tsx:200-215` which defines its own `interface MountedPage` — the same exported
name as the harness — plus a second near-duplicate `mountEmpty()` helper (`items.test.tsx:218-236`)
that differs from `mount()` only in the final predicate.
**Missing work (not strictly a test):** either migrate the remaining `mountPage` clones or
soften the harness docstring; and de-duplicate `mount()`/`mountEmpty()` in `items.test.tsx`
into one helper taking the awaited testid — the timeout/poll logic is otherwise identical.

### Q4 🟡 Two `waitFor` implementations with different budgets in the same repo
Harness `poll` uses `attempts = 100` × 20 ms (`page-harness.tsx:51-58`); `items.test.tsx:196-202`
uses `attempts = 120`; `reports.test.tsx:107-116` uses `50` and returns `boolean`; the
`waitFor` in `expenses.test.tsx`/`party-detail.test.tsx` returns void. The inconsistent
timeout and return contract is a flake source under load (the 50-attempt one is the
tightest at 1 s) and is exactly what the harness was introduced to remove.

### Q5 ✅ Async handling in the new tests is correct
`invoice-returns.test.tsx:300-307` wraps the click in a synchronous `act()` and asserts
`document.activeElement` immediately — correct, because `firstEnabledField(...).focus()` runs
inside the click handler. `returns.test.tsx:246-255` awaits `flushAsync()` after
`renderSupplierReturns()`. `activity-empty.test.tsx:52-58` polls for the table before
asserting the empty state is gone. No missing `await` on an async assertion was found in the
changed specs.

### Q6 ✅ Test isolation is good where it matters most
- `mock.module` is process-global; every new file documents that it owns the `@/lib/rpc` seam
  for its duration (`activity-empty.test.tsx:21-22`, `categories.test.tsx:17-19`,
  `history-empty.test.tsx:28-29`) — matching the existing `tests/router-mock.tsx` convention.
- `afterEach` unmounts and resets fixtures in every new file; `invoices.test.tsx:40-50`
  restores the seed in both `beforeEach` and `afterEach` (belt and braces, justified in a
  comment).
- `categories.test.tsx:96-118` restores the shared `categories` module fixture in a
  `finally` block so the mutation cannot leak on assertion failure — good discipline.
- `items.test.tsx:243-263` deliberately does **not** restore `categories` inside the test but
  does so in `finally`; consistent with the rest of that file.

### Q7 🟡 The e2e spec is a new spec in a shared-database suite with a destructive `beforeAll`
`01-empty-states.spec.ts:14-24` `execFileSync("bun", ["scripts/reset-e2e-records.mjs"], { cwd: process.cwd(), … })`.
It is `serial` and its name follows the `00-onboarding.spec.ts` precedent, but it is now
wired into three selection-map rules, and the reset it runs is broader than before
(`DELETE FROM categories`). There is nothing in the spec that re-asserts the fixtures it
assumes after the reset (e.g. that expense categories still exist).
**Suggested follow-up:** a comment or assertion in the touched expense/item specs that their
required categories are created by those specs themselves, or a `beforeEach` guard — plus an
explicit note in `reset-e2e-records.mjs` about which tables a later spec must re-seed.

### Q8 ✅ The omitted-activity justification checks out
`01-empty-states.spec.ts:88-90` states the activity log is never empty on a clean room
because provisioning writes a row, and points at the unit-level
`activity-empty.test.tsx`. `reset-e2e-records.mjs:44` does delete `activities`, but that runs
before sign-in/provisioning, so the reasoning is sound — and the unit test it cites exists
and passes. Documented omission, not a gap.

### Q9 🟡 `purchase.test.tsx:197` reads as an assertion but proves nothing
The helper changed from a hard-coded Arabic literal to `i18n.t("purchasesProposalEmpty")`,
which removes the "test must be edited when the copy changes" coupling but also removes the
last independent check of that copy (see C2). The literal-Arabic form in the e2e spec is what
actually pins copy; this helper is now a no-op check.

---

# Synthesis (skill step 4) — ranked fix list

| # | Rating | Item | Action |
| --- | --- | --- | --- |
| E1 | 🟠 would ship a dead end | `items.tsx:796` pending/error categories → actionable wrong empty state | fix predicate (`categories.data !== undefined && …`), add pending + error tests |
| E3 | 🟠 untested branch | `invoice.tsx:188` `pmtEmptyJustSavedHint` | add just-saved + settled-wins tests |
| C2 | 🟠 uncovered surface | `purchase.tsx:435` new copy + `link-proposal-empty` testid | add assertion |
| C3 | 🟠 silent-failure risk | 25 new i18n keys asserted via `i18n.t` round-trip | add key-completeness spec |
| E2 | 🟠 wrong copy window | `party-detail.tsx:189` detail-pending | add deferred-detail test |
| E4 | 🟠 unverified focus | `invoices.tsx:126-137` status-only clear | add click + focus assertion |
| C4 / C6 / E5 / E6 / E7 | 🟡 coverage polish | e2e for the filtered/no-category branches, absence-of-wrong-hint assertions, paging + transition tests | extend existing specs |
| Q3 / Q4 / E9 / C5 | 🟡 quality polish | finish page-harness adoption, unify `waitFor`, add `empty-state.test.tsx`, shared no-action helper | refactor tests only |

No 🔴 ("would break") finding: I could not construct a case where the production change
misbehaves in the shipped path — every branch that is reachable ends in the documented
outcome, and 195 tests pass. The strong items above are unverified branches (a future edit
would ship a regression with a green suite), plus two copy-correctness windows (E1, E2) that
resolve themselves as soon as the sibling query settles.

## Residual risks / not verified by this audit
- Playwright spec never executed here (no server/browser). Claims in
  `.scratch/reviews/96/decisions.md` — "6 passed", "1164 pass", screenshots
  (`.scratch/reviews/96/screenshots/**` were not opened) — are taken as claimed only.
- `bun run typecheck` / `bun run lint` not re-run.
- Nothing outside the changed files was re-audited (scope = base `071a1c4` → head `9c856bb`).
