# Test audit — issue #99 (create an expense category from the expenses screen)

- **Tier:** Standard (the lane brief mandates a test audit even though the
  `test-audit` skill defaults to high-assurance)
- **Base:** `0b4d5a16c793cb775288fd576cddc3dcc62b7d24` (`origin/develop`)
- **HEAD:** `d8a0bcdb6abb77db9a003573b3e32b281a092ad2`
- **Reviewed tests:**
  - `apps/web/src/pages/expenses.test.tsx` (new, 8 tests)
  - `tests/e2e/expense-reports.spec.ts` (new test 3, plus the untouched
    existing expense/report tests that stay green)
- **Production under test:** `apps/web/src/pages/expenses.tsx`,
  `apps/web/src/lib/i18n.ts`

## 1. Edge case hunter

| Edge case | Covered? | Where | Risk if missing |
| --- | --- | --- | --- |
| Zero categories (empty state) | yes | component test 1 | would fail at save with a technical error |
| Empty name | yes | component test 6 | would post `""` and surface a server error |
| Whitespace-only name | yes | component test 7 (added by this audit) | `"   "` would reach the api and fail there |
| Duplicate name (`EXPENSE_CATEGORY_EXISTS`) | yes | component test 5 | the form would close on a false success |
| Cancel the quick-add | yes | component test 8 | stale open form / accidental create |
| New category selected immediately | yes | component tests 1–2, E2E | the owner would have to re-pick |
| Record against the just-created category | yes | component test 3, E2E | the core flow could send a stale/empty id |
| Success message clears on reopen | yes | component test 2 (added by code-review fix) | stale confirmation beside a fresh form |
| Missing category at record submit | yes | component test 4 | the old technical `CATEGORY_NOT_FOUND` |
| Category list still loading | no | — | 🟡 the fields render with an empty select; save
  still names the recovery, so no dead end |
| Very long category name | no | — | 🟡 the trigger is `line-clamp-1`; the server has no
  max either, so this is a pre-existing, out-of-scope gap |
| Invalid amount + no category | no | — | 🟡 amount validation runs first by design; the
  message is still Arabic and actionable |
| Category-list query failure | no | — | 🟡 `categories.data` stays undefined and the
  recovery error still appears at save |

No 🔴 or 🟠 edge case is left uncovered. The one 🟠 found (whitespace-only) was
fixed in commit `2c71fbb`; the reopen-stale-message case was fixed in `d8a0bcd`.

## 2. Coverage analyst

Acceptance criterion → test map:

1. *A new expense category can be created from the expenses screen without
   leaving it.* → component tests 1–2; E2E test 3.
2. *The new category is immediately selectable and usable.* → component test 2
   (trigger shows the name, form closes) and test 3 (expense posts the new id);
   E2E asserts the trigger text and records against it.
3. *Recording an expense works on a fresh install with no ceremony.* → E2E
   test 3 records against a category created in the same screen; the empty-list
   variant is component test 1 (the seed hides it in E2E).
4. *Any remaining failure path names the problem and the recovery in Arabic.* →
   component test 4 (`expenseChooseCategory`), test 5 (duplicate), tests 6–7
   (missing name). All assert Arabic copy, not a key.
5. *`bun run test:e2e` passes.* → full suite 26/26 green at this HEAD (2.2 min).

Diversity: empty state, happy create, select-immediately, record-against,
missing-category, duplicate, empty name, whitespace name, cancel. No two tests
assert the same behavior. No duplicate coverage.

Not covered (deliberate): the owner-withdrawal flag on create (out of scope),
edit/delete of categories (out of scope), and the pre-existing amount
validation matrix (unchanged by this lane).

## 3. Quality reviewer

- **Names:** each test states the behavior and the outcome; no "works" names.
- **Async handling:** every mutation settle is flushed through `act()` +
  `waitFor`; controlled inputs use the native value setter + `input` event so
  React's tracker fires. No floating promises.
- **Setup duplication:** one shared `mountPage` helper; fixtures reset in
  `beforeEach`, query cache cleared and DOM emptied in `afterEach`.
- **Assertion quality:** assertions check user-visible Arabic text, the selected
  value, the form lifecycle, and the captured mutation payload — not merely
  "renders".
- **Isolation:** the mutable fixtures are re-initialised per test; the mock rpc
  module is deterministic.
- **E2E:** unique category name per run (`Date.now()`), role/testid locators,
  auto-retrying `expect`, no fixed sleeps.
- **Grade: A-.** The minus is the deliberately untested low-risk edges above.

## Findings applied

1. 🟠 Whitespace-only category name reached the api. Added component test 7
   (`2c71fbb`).
2. 🟠 Reopening the quick-add after a success kept the old confirmation. Added
   the reopen assertion to component test 2 and fixed the toggle handler
   (`d8a0bcd`).

## Residual risks

- The category list has no max-length guard; long names are clipped in the
  trigger but still accepted by the server. Pre-existing, out of scope.
- The empty-category state cannot be exercised in E2E because the api seeds
  categories; it is covered at the component level.
