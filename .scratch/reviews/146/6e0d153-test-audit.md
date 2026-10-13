# #146 test-audit evidence

- **Issue:** #146, one invoice-draft module behind the sale and purchase screens
- **Tier:** Standard (test audit is required for Standard and High-assurance)
- **Base:** `origin/develop` @ `fc951133134a9b0b18b5ae38f9658665c29e73ec`
- **Evidence HEAD:** `6e0d153059a8d0197e62a67cdec2ac9a651509d2`
- **Provenance:** round 1 (three children: edge-case hunter, coverage analyst,
  test-quality reviewer) reviewed `6c6e9f4`; round 2 ran the same three roles on
  `e231b47`. Their accepted findings were applied in `6e0d153`, which is the HEAD
  this file is named for. No reviewable file changed after `6e0d153`.

## Files under audit

- `apps/web/src/lib/invoice-draft.test.ts` (pure rules)
- `apps/web/src/lib/use-invoice-draft.test.tsx` (new in `6e0d153`: the React adapter)
- `apps/web/src/pages/sale.test.tsx`
- `apps/web/src/pages/purchase.test.tsx`
- `tests/e2e/purchase-intake.spec.ts` (the new browser-level drift proof)

## Round 1 findings

### Edge case hunter

| # | Gap | Risk |
|---|---|---|
| 1 | A repeat pick on a line already at `MAX_DRAFT_QUANTITY` bumped the draft to `1000001`, which resolves to 0, so a maxed line silently went dead and blocked the save. | ORANGE |
| 2 | Purchase's quick-add accepted an over-cap quantity and landed a line that resolves to zero. | ORANGE |
| 3 | An amount-typed payment plus a 100% discount leaves an unsaveable cart (the transition cannot tell an empty cart from a zeroed total). | ORANGE |
| 4 | Percentage boundaries (0, 100, and the uncapped override preview) were unpinned. | YELLOW |

### Coverage analyst

| # | Gap | Closing test |
|---|---|---|
| 1 | No rendered test proved *sale* still behaves as the shared draft, so "purchase behaves like sale" rested on an import. | a rendered sale cleared-draft test |
| 2 | Purchase's unit-cost field handler changed to `nextUnitCost` with no page-level pin. | a rendered unit-cost money-contract test |
| 3 | No rendered sale total pin. | a rendered discounted-total test |
| 4 | "Before and after" is anchored only by the pre-existing E2E specs. | accepted; the E2E specs pin sale and purchase totals |

The analyst also noted one duplicate: the "deterministic pin table" in
`invoice-draft.test.ts` re-asserted cases from the three preceding tests. Kept
deliberately as the regression pin for the parser, and noted here.

### Test quality reviewer

Grade B. Non-vacuous core drift test (it fails under the old silent-keep
handler), good names, money math genuinely pinned. Fixes requested:

1. setup-helper duplication in `purchase.test.tsx`;
2. teardown inline instead of in `afterEach`;
3. `chooseOption` called outside `act()`;
4. a misleading comment (`500 x 33%` next to an assertion about `101 x 50%`);
5. "exactly like sale" asserted only by comment.

## Round 1 disposition

Fixed in `e231b47`:

- edge 1: `addDraftLine` clamps at the cap; pinned in `invoice-draft.test.ts`.
- edge 2: purchase's quick-add quantity goes through `parseQuantityDraft`; pinned
  by a rendered test that asserts no line landed and no invoice was sent.
- edge 4: percentage boundary and uncapped-preview assertions added.
- coverage 1, 2, 3: rendered sale cleared-draft test, rendered sale
  discounted-total test, rendered purchase unit-cost test.
- test quality 4: comment corrected.
- test quality 5: sale now has its own rendered cleared-draft test, so parity is
  demonstrated by parallel executable tests.
- test quality 2 and 3: the new block tracks its roots and tears them down in
  `afterEach`, and its `chooseOption` call is wrapped in `act()`.

Deferred:

- edge 3: pre-existing and unchanged. `nextPaymentPair` cannot distinguish an
  empty cart from a discount-zeroed total without new state, and what the
  operator meant is a product decision. Recorded in design doc section 8. A pure
  test now pins the current behaviour and the refusal it causes.
- coverage 4: accepted. The unchanged E2E specs are the before and after anchor.
- test quality 1: pre-existing helper duplication in `purchase.test.tsx`. The new
  block follows the file's existing pattern; hoisting one file-level helper is a
  test-only cleanup for another lane.
- the deterministic pin table: kept, with the reason above.

## Round 2 findings

### Edge case hunter

| # | Finding | Risk |
|---|---|---|
| 1 | `firstUnusableQuantity`'s draft-order claim was asserted only with at most one offender, so a `findLast` implementation would have passed. | YELLOW |
| 2 | Round-1 fix 5 added an `openForm` seed-merge branch that production never reaches and no test covered. | ORANGE |
| 3 | `resolveInitialPaid` whitespace drafts were unpinned. | YELLOW |
| 4 | The amount and percentage pair's digit asymmetry (Arabic-Indic amounts accepted, percentages ASCII-only) was unpinned. | YELLOW |
| 5 | The deferred amount-source case had no explicit pin. | YELLOW |
| 6 | The merge's behaviour with an over-cap or unreadable existing draft was unpinned. | YELLOW |

### Coverage analyst

All six acceptance criteria covered at the round-2 head; round-1 gaps closed.
One optional note: no test names the *legacy* purchase silent-keep as a
regression sentinel.

### Test quality reviewer

Grade B. Remaining fixes: wrap sale's new `chooseOption` in `act()`, remove the
redundant inline teardown, and strengthen the `toContain("0")` total assertions,
which could pass vacuously because `"2400"` already contains `"0"`.

## Round 2 disposition

Fixed in `6e0d153`:

- edge 1: `firstLineError` replaced `firstUnusableQuantity`, with a pure test
  that has two offenders and a second test for per-line override-then-quantity
  precedence.
- edge 2: a new `apps/web/src/lib/use-invoice-draft.test.tsx` pins the seed merge
  for both reset policies, the create-then-land flow, the refusal path, the line
  list and the payment pair.
- edges 3, 4, 5, 6: pure pins added (whitespace, digit asymmetry, the deferred
  amount-source refusal, and the repair of an over-cap or unreadable draft).
- test quality: the new sale `chooseOption` call is wrapped in `act()`; the
  rendered zero-total assertions now parse the rendered number and assert `0`
  instead of matching a substring.

Accepted with a reason:

- the coverage analyst's optional named-sentinel note: the drift tests already
  assert the new behaviour and the comments name the old handler, so a separate
  sentinel constant would restate the same fact.
- the redundant inline teardown in the new purchase block: the `afterEach` is the
  safety net for a throwing test, and the inline calls keep each test
  self-contained. Cosmetic, no isolation risk.

## Gates at the evidence HEAD

| command | result |
|---|---|
| `bun run typecheck` | exit 0, `Tasks: 3 successful` |
| `bun run lint` | exit 0, no output |
| `bun run test` | exit 0, `904 pass / 0 fail` across 69 files, 4691 assertions |
| `bun run test:e2e` | exit 0, `55 passed` |

The E2E run was made on an isolated port pair (`DOKAN_PORT=4617`,
`DOKAN_WEB_PORT=5473`) because a sibling worktree lane
(`feat-130-arabic-name-variants`) was running the same suite on the shared
4317/5173 pair at the same time. Two consecutive full runs on the shared ports
failed 7 and then 8 specs from different files with
`net::ERR_CONNECTION_REFUSED` and `page.goto` timeouts, which is the
contention symptom described in
`.agents/wisdom/2026-10-13-e2e-stale-server-and-checksum-flake.md`. The isolated
run passed 55/55, and the individual specs that failed during the overlap pass in
isolation.

## Verdict

Coverage is sound at `6e0d153`: the pure rules, the React adapter, both rendered
screens and the browser flow each have tests, the drift fix has tests that fail
under the old behaviour, and every remaining gap is recorded with a reason.
