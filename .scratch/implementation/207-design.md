# Design: #207 (extract a `submitForm()` helper and close the opening-balance boundary gaps)

**Tier:** Standard. Justification: the change is test-only (no production, contract
or schema change), but it edits a reviewed test file, so the Standard gates apply.
**Base:** `origin/develop` @ `1ea76b5` (merge-base with this lane's branch; this
branch is the abandoned `fix-207-submitform-helper` work cherry-picked onto
current `develop`).
**Issue:** #207, follow-up to #183 / PR #203.
**Files:** `apps/web/src/pages/supplier-opening-balance.test.tsx` only.

## Problem

PR #203 converted 8 tests that asserted "nothing was sent" but were masked by an
unrelated guard: an empty batch, a disabled control, or a confirmation
precondition. Each conversion repeated the same three-line scaffold: fill a
valid no-entry row, arm the failure, submit through the form (`requestSubmit()`)
rather than a click on the disabled save control. The repeated scaffold is
exactly what drifts: a future test can go back to `clickOn("...-save")` and pass
vacuously. The sweep also surfaced boundary cases never covered at all.

The 8 sites are the tests where PR #203 added `requestSubmit()`:
`blocks the save and marks the row when an amount draft is invalid`,
`rejects a decimal-grouped amount...`, `blocks an incomplete inline supplier...`,
`blocks a batch over the 200-row contract limit...`,
`blocks two outgoing rows folding to one name...`,
`blocks the save when the account summary fails...`,
`blocks the save when the names read fails...`,
`blocks a typed name whose supplier already has a filled row...`.

## Interface

One new test-local helper beside the existing test helpers (`typeIntoRow`,
`fillAmounts`, `clickOn`, and so on):

```ts
async function submitForm(
  arm: () => void | Promise<void>,
  validRowAmount: string | null = "300",
): Promise<void>
```

Behaviour:

1. When `validRowAmount !== null`, fill row 1 (`s-2`, no account entries) with
   that amount. One valid no-entry row defeats **both** masking guards: it keeps
   `totalRows > 0` (the empty-batch check) and its supplier has no entries (the
   confirmation precondition, so no dialog can swallow the submit).
2. `await arm()` builds the failure under test. `arm` may be async because the
   read-failure cases must refetch and `settle()` before submitting.
3. Submit through `form.requestSubmit()` inside a single `await act(async ...)`.
   Never `clickOn("opening-balance-save")`: the save control is disabled
   precisely where these tests live, and React swallows the click, so the
   request never runs and the "nothing was sent" assertion is vacuous.

`validRowAmount: null` is for the sites that build their whole valid batch
themselves: the over-limit cases (200 filled rows plus a typed row, and 199
filled rows plus a typed row) and the two read-failure cases (a valid typed-name
row on a no-entry supplier). Those still get the helper's submit ownership,
which is the drift-prone half.

Assertions stay in the test body after `await submitForm(...)`, because a blocked
submit leaves the visible state (error banners, disabled control) and
`captured === null` unchanged.

The helper is used by the 8 converted sites and by the new boundary tests. The
other `requestSubmit()` sites in the file (the Enter-key test, the #204 removal
test, the typed-name-limit test) have a different arrangement and are left
alone.

## Boundary cases to add

| Test | Boundary | Expectation |
|---|---|---|
| negative draft `-5` on a row beside a valid no-entry row | a sign is rejected by `parseGroupedAmount` (plain and grouped digit regexes) | row error, save blocked, `captured === null` |
| amount `1` on a no-entry row | low end of the accepted range (whole DZD `> 0`) | saved with `amount: 1` |
| amount `0` beside a valid no-entry row | one below the accepted range | row error, `captured === null` |
| amount `0` in the typed new row | the typed reader's own `amount <= 0` branch | typed-row error, save blocked, `captured === null` |
| `String(Number.MAX_SAFE_INTEGER)` on a no-entry row | high end (`dinarsSchema` max; `Number.isSafeInteger`) | saved with that exact amount |
| `String(Number.MAX_SAFE_INTEGER + 1)` beside a valid no-entry row | one above the accepted range | row error, `captured === null` |
| exactly 200 filled rows, 200 suppliers | the 200-row contract cap **at** the boundary | not blocked, saved with 200 rows, every row keeps its amount |
| 199 filled rows plus one typed row | the cap counts the typed row; the batch is exactly 200 | not blocked, saved with 200 rows including the typed row |

The existing coverage is `abc`, `1 000,00` (invalid), and a batch of 201
(over-limit). The new cases fill the rest of the boundary.

## Which new cases discriminate

A new case is only worth keeping if weakening the guard it names makes it fail.
All four mutations below were applied in this lane to the production files (no
production file changed on this branch, so the guarded code is byte-identical at
every commit here), then reverted (`git status --short` clean afterwards). Exact
commands and exit codes are recorded in `.scratch/reviews/207/<sha>-test-audit.md`.

| Mutation | Failing test | Observed |
|---|---|---|
| `openingRowStatus`: `amount === null \|\| amount <= 0` to `amount === null` | `rejects amount 0, one below the accepted range` | exit 1, `expect(...amount-error).not.toBeNull()` received `null` |
| `parseGroupedAmount` path: strip `-` before parsing | `rejects a negative amount draft instead of saving its magnitude` | exit 1, `expect(...amount-error).not.toBeNull()` received `null` |
| `parseWholeAmount`: drop the `Number.isSafeInteger` check | `rejects an amount one above the largest safe integer` | exit 1, `expect(...amount-error).not.toBeNull()` received `null` |
| `isOpeningBatchOverLimit`: `>` to `>=` | `MAX_OPENING_BALANCE_ROWS` unit test (`isOpeningBatchOverLimit(200) === false`) | exit 1, `expect(isOpeningBatchOverLimit(200)).toBe(false)` received `true` |

The three reject tests run their batch on `TWO_NO_ENTRY_SUPPLIERS` (both
suppliers carry no account entries). With no supplier carrying entries, a
dropped guard must SEND the batch, so the `captured === null` assertion fails on
its own, not only the visible-error assertions.

The two accept-side tests (`amount 1`, `MAX_SAFE_INTEGER`) are positive
tripwires rather than guard falsifiers: they pin the accepted value exactly, so
an off-by-one, a truncation or a rejected boundary fails them. They are the
counterpart the reject cases need, not redundant with them.

The page-level `>=` mutation hangs the bun/happy-dom runner when the 200-row
test fails (the process does not exit), so that boundary is pinned by the pure
predicate unit test, which fails cleanly under the same mutation.
All eight new tests call `submitForm`; the two accept-side tripwires assert the
enabled control from inside `arm`, so the enabled state is checked without
re-introducing the hand-rolled `typeIntoRow` + `clickOn` shape the helper exists
to remove.

## Deferred (not required by #207)

Swept but left out to keep the ticket scoped to the boundaries it names. Each is
a real untested branch; file a follow-up if the owner wants them.

- **Whitespace-only row draft** (`openingRowStatus`'s `raw.trim() === ""`
  branch) at the page level.
- **Arabic-Indic digits** on a page-level amount (`normalizeArabicIndicDigits`;
  covered at the parser level in `amount-parse.test.ts`).
- **Negative amount in the typed new row** (same parser branch as the
  existing-row negative case, so it adds no new discrimination).
- **An empty supplier list** submitted through the page: `submit()` reports
  "nothing entered" (no write), but no test drives that branch.
- **A runtime non-empty-batch guard in the helper.** Attempted this lane, then
  reverted: the two read-failure callers submit while a list error has replaced
  the table, so the typed inputs are unmounted and the batch is invisible to a
  DOM query. A DOM-based guard fails those tests without protecting anything; the
  `null` callers stay a documented, hand-verified invariant. The four null call
  sites (over-limit, 199+typed, and the two read-failure cases) each build a
  non-empty batch, and would fail loudly if the guard they exercise were dropped.

## Documentation-only fix: the confirm-save known exception

`blocks the confirm-save when the account summary fails after the dialog opens`
asserts `captured === null` after clicking the confirm control, but that
assertion is masked: the same `listFailed` flag disables the control **and**
backs `save()`, and React suppresses `onClick` on a control whose memoized
`props.disabled` is true, so `save(true)` is unreachable through the UI. Making
it reachable needs a **production** change and belongs in its own issue. Record
that reason in the test's comment, with a "do not weaken the assertion" warning,
instead of removing the assertion.

## Do not weaken

- The 8 converted tests keep asserting that nothing was sent, and keep failing if
  the guard they bypass is removed.
- PR #219's additions (removal notice, `livePresentSupplierIds`, namesHold, the
  blocked-save tests) stay intact; the helper fits beside them.
- No production file changes.

## Tests

- Unit: the affected file, `apps/web/src/pages/supplier-opening-balance.test.tsx`
  (`cd apps/web && bun test src/pages/...`), then `bun run test` at the root.
- E2E: not run. No production file changed and no user-visible flow changed, so
  the Playwright suite has nothing new to exercise; the whole change surface is
  the component test file above.
- Discrimination: the mutation table above.

## Risks

- The helper's `null` escape hatch could itself drift; the comment states when it
  is legitimate and the self-built-batch sites are the only callers.
- The 200-row cases are load-sensitive by nature (#193): batched fill via
  `fillAmounts` and the existing `BATCH_LIMIT_TEST_TIMEOUT_MS` budget.
