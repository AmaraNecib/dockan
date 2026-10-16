# Issue #96 round 3 — the new e2e spec perturbs a later spec

Tier: **Standard**. Justification: test-infrastructure only, no product behaviour
and no path that can move money, stock, debt direction, auth or backup data — the
diff touches two Playwright specs. Base: `origin/issue-96-empty-states` (`294a9af`).

## The defect

`tests/e2e/debts.spec.ts:77` fails in CI:

```
Locator: getByTestId('debts-group-weowe-total')
Expected substring: "1200 دج"
Received string:    "3200 دج"
```

`debts.spec.ts` asserts an **exact global figure** — the /debts "we owe" group is
1200 دج over one invoice — but the suite runs every spec against **one** sqlite
database with `workers: 1` in path order:

```
00-onboarding, 01-empty-states, 96-returns-supplier-action, … , debts, …
```

The round-2 spec `96-returns-supplier-action.spec.ts` records a purchase with
`purchase-paid: "0"`, so its full 2000 دج stays unpaid and joins the "we owe"
group. `3200 - 1200 = 2000`: the delta is exactly that invoice. `debts.spec.ts`
passes alone, so this is interference, not a product defect — nothing in
`debts.tsx` changed.

Reproduced locally before the fix, in the same order the brief gives:

```
bunx playwright test tests/e2e/01-empty-states.spec.ts \
                    tests/e2e/96-returns-supplier-action.spec.ts \
                    tests/e2e/debts.spec.ts
→ 1 failed, 8 passed · Received "3200 دج"
```

## The principle

**A spec must not change global state for the specs that run after it.** Both
halves of that sentence need an owner, so this change fixes both:

1. **The leaker cleans up.** `96-returns-supplier-action.spec.ts` gets a
   file-level `afterAll` running `scripts/reset-e2e-records.mjs`.
2. **The global assertion owns its precondition.** `debts.spec.ts` gets a
   file-level `beforeAll` running the same script, the way `00-onboarding` and
   `01-empty-states` already do.

Why not (1) alone: it fixes the one known leaker. Any future spec that leaves an
unpaid invoice re-breaks `debts.spec.ts`, and the failure would again surface as
a wrong number in an unrelated file. A spec that reads the database's *sum* has
to control the database's starting state.

Why not (2) alone: it defends `debts.spec.ts` only. The 96 spec would still hand
a polluted database to everything after it, and the next spec to assert a global
figure would be the one to find out — with a red CI and no obvious cause. The
brief's principle is about the leaker, so the leaker is fixed at the source.

Why `afterAll` and not `afterEach` in the 96 spec: both of its tests share the
one leak, and a single reset per file is cheaper than two. `afterAll` also runs
when a test fails — the case where a leaked row would otherwise sit in the
database for the rest of the run.

Why a plain inline `execFileSync` and not a new shared helper: `00-onboarding`
and `01-empty-states` already carry this exact pattern with their own
env-defaulting, and extracting it would widen the diff into the fixtures of two
green, already-reviewed specs. Minimal blast radius wins here.

## Sweep — every spec asserting an exact count or total

`debts.spec.ts` is *evidence about which assertion was checked*, not about which
one is at risk. Every spec that asserts an exact count/total, and whether it is
precondition-independent:

| Spec | Exact count/total asserted | Precondition-independent? |
| --- | --- | --- |
| `debts.spec.ts` | **GLOBAL** `debts-group-owed-total` 1500, `-owed-count` 1, `-weowe-total` 1200, `-weowe-count` 1 | **No** — fixed here (owns its reset in `beforeAll`) |
| `96-returns-supplier-action.spec.ts` | none (asserts presence/absence only) | n/a — but it left the leak; fixed here (`afterAll` reset) |
| `expense-reports.spec.ts:77` | `expense-history` tbody rows `toHaveCount(2)` — the current-month window over ALL expenses | **By convention only**: file header states "Expenses are only ever recorded by this spec". No other spec records an expense today, so it holds; recorded here as the second assertion of this class |
| `expense-reports.spec.ts:301` | breakdown row count per seeded window | Yes — filtered by `categoryName` it created |
| `pagination.spec.ts:80–109` | `invoice-row` 10 / 20 / min(20, total) | Yes, **by construction** — it reads `total` from `invoicesList` instead of pinning a number ("so the spec does not depend on what other specs already recorded") |
| `pagination.spec.ts:186–242` | `party-invoice-row` / `supplier-account-row` 10 and 2 | Yes — scoped to the party it seeds |
| `customers.spec.ts:107–185, 267–285` | `debts-person-count`, `party-row-count`, `party-stat-*`, `party-unpaid-total` | Yes — every one filtered by a stamp-unique name it created; it also settles its own debts to 0 because "later specs' global debt totals break" |
| `supplier-account.spec.ts:60–116` | `supplier-balance-value` 2000→0 | Yes — the balance of the supplier it created |
| `supplier-adjustment.spec.ts:163–167` | `debts-group-weowe-total` — asserts only that it contains "دج" and not "-" | Yes — deliberately loose; it cannot depend on a global number |
| `invoice-print-a4.spec.ts:190–351` | `receipt-sheet` 2, `receipt-line` 12/6/6 | Yes — scoped to the invoice it seeds |
| `invoice-payments.spec.ts:103–118` | `history` / `auditRows` `toHaveCount(2)` | Yes — its own invoice (filtered by its number) |
| `receipts.spec.ts:106` | `history` `toHaveCount(2)` | Yes — its own invoice |
| `returns.spec.ts:74–111` | `returns-value`, `stock-after-cell` 2 | Yes — its own item/invoice |
| `stock-ledger.spec.ts:268` | `history-pager-page-2` | Yes — its own item's history |
| `items-flow.spec.ts:61–86` | `stock-after-cell` 9 / 12 | Yes — its own rows |
| `items-categories.spec.ts:47` | `"0 / 5"` | Yes — its own dashboard row |
| `catalog-scan.spec.ts:152` | row contains "7" | Yes — its own named row |
| `purchase-intake.spec.ts:90–107` | row counts 2 / 3 | Yes — rows filtered by its own names |
| `sale-checkout.spec.ts:190–432` | `sale-subtotal` / `sale-total` / `sale-saved-debt` | Yes — its own draft/saved invoice |
| `00-onboarding.spec.ts:58` | `getting-started-step` `toHaveCount(4)` | Yes — a static UI list, not a DB count; the spec also resets in `beforeAll` |
| `00-onboarding.spec.ts:226` | `invoice-remaining` contains "0" | Yes — its own invoice |
| `01-empty-states.spec.ts` | empty-state presence only | Yes — resets in `beforeAll` |
| `activity`, `arabic-search`, `backups`, `completion-screens`, `customer-name-variants`, `diagnostics`, `learnability`, `login`, `no-write-window`, `phone-identity`, `settings` | none global — counts are `toHaveCount(0)` of things they did not create, or rows filtered by their own names | Yes |
| `vault.spec.ts` | none — runs on its own api/web pair and its own database | Yes |
| `phase`/helpers (`*-helpers.ts`, `pdf-helpers.ts`, `rpc-helpers.ts`) | none — helpers, not specs | n/a |

**Conclusion:** `debts.spec.ts` was the only assertion reading a *global sum*, and
it is now hard. `expense-reports.spec.ts`'s 2-row history count is the one other
assertion that depends on all earlier specs; it is independent today because no
other spec records an expense, and that dependency is already written down in
that file's header. Nothing else needed hardening, so nothing else was touched.

The `tests/e2e/**` path is `always_full` in `tests/e2e-selection.map.json`, so
this diff forces a full e2e run in CI — the map itself is not touched and its
guard test stays green.

## Second defect found while producing the evidence — a pre-existing save race in `expense-reports.spec.ts`

The full-suite run after the interference fix was **not** green. One further test
failed, and it is a different class — a bare-click race, not a shared-state leak:

```
tests/e2e/expense-reports.spec.ts:196
expect(received).toBe(expected)  // Object.is equality
Expected: 3250   Received: 3000
```

The spec records a rent expense and a withdrawal with two consecutive bare
`expense-save` clicks and no wait between them:

```ts
await selectExpenseCategory(page, "كراء المحل");
await page.getByTestId("expense-amount").fill(String(rentAmount));
await page.getByTestId("expense-save").click();          // bare
await selectExpenseCategory(page, "سحوبات المالك");
await page.getByTestId("expense-amount").fill(String(withdrawalAmount));
await page.getByTestId("expense-save").click();          // bare
await page.goto("/reports");
```

`expense-save` is `disabled={createExpense.isPending}`, and the success handler
**clears the amount field**. So the second `click()` auto-waits on the disabled
button; the first save lands, the success reset empties the field, the click then
proceeds against an empty form, the client refuses it, and **no request is sent**.
The withdrawal never exists.

Evidence, in the trace of the failing CI-order run: the network log holds exactly
**one** `POST /api/rpc/expensesCreate` (the 950 rent), and no second one. A
client-side refusal by definition cannot be caused by a database reset in another
spec file, so this is not this lane's doing.

This file already knows the rule — the third test waits for each write's own
acknowledgement, with the comment "await each write's own acknowledgement, never
a bare click", and the first test waits for the saved row. Test 2 was the only
place with two bare clicks in a row, so the fix makes it consistent with its own
file, not a new convention:

```ts
await actAndAck(page, "expensesCreate", async () => {
  await page.getByTestId("expense-save").click();
});
```

### Proof the fix has teeth (mutation)

The race is timing-dependent, so a plain green run proves nothing. It was made
deterministic by holding the first `expensesCreate` response open (`page.route` +
a 1500 ms delay), then running only test 2:

| Shape | Result |
| --- | --- |
| bare click (pre-fix) | **fails** — `Expected: 250, Received: 0` (the withdrawal is missing, the same signature as the CI failure) |
| `actAndAck` (post-fix) | **passes** under the identical mutation |

The mutation was removed before committing (`diff` against a backup is the
two-hunk `actAndAck` change only).

This is outside the brief's two named fix options, so it is a **separate commit**
and the parent can drop it. It is included because the round exists to make CI
green, and this failure lands in the same suite the round is about.

## Evidence

All commands run from the worktree root, on a lane-private port pair
(`DOKAN_PORT=4341 DOKAN_WEB_PORT=5193`, vault `4409`/`5184`), with every listener
on those ports killed and `.dokan-port` removed first (wisdom
`2026-10-13-e2e-stale-server-and-checksum-flake`).

| # | Command | Result |
| --- | --- |
| 1a | `bunx playwright test 01-empty-states 96-returns-supplier-action debts` — **before** | **1 failed, 8 passed** · `Received "3200 دج"` at `debts.spec.ts:77` |
| 1b | the same three files — **after** | **9 passed** (both 96 tests, both empty-state files, debts) |
| 2 | `bunx playwright test tests/e2e/debts.spec.ts` | **1 passed** (alone, with its new `beforeAll`) |
| 3 | `bun run test:e2e` (full suite, path order) | **93 passed, 0 failed** (11.9 m) |
| 4 | `bun run typecheck` | exit 0 |
| 5 | `bun run lint` | exit 0 |
| 6 | `bun run test` | exit 0 |
| 7 | `bun test scripts/e2e-selection.test.ts` | 35 pass, 0 fail (map untouched, guard green) |
| 8 | mutation: delayed first `expensesCreate`, test 2 pre-fix / post-fix | fail / pass |

A first full-suite attempt (before the `actAndAck` fix) is what surfaced #3's
failure: **92 passed, 1 failed** on `expense-reports.spec.ts:196`.

## Risks

- The `debts.spec.ts` reset deletes shop records created by the specs between
  `96-` and `debts` (activity, arabic-search, backups, catalog-scan,
  completion-screens, customer-name-variants, customers). Evidence row 3 is the
  test of that: the full suite stayed green.
- The reset clears server-side UI preferences. `pagination.spec.ts` sets its own
  `ui.pageSize` explicitly for exactly this reason, and `00-onboarding` already
  clears preferences mid-run, so this is not a new class of clearing.
- The `expense-reports` fix is a second concern in a narrow brief. It is a
  separate commit so the parent can drop it without touching the interference
  fix.
- A one-spec-flake rerun is not proof by itself; the `actAndAck` change is the
  only one here whose proof came from a deterministic mutation rather than a
  green run.

