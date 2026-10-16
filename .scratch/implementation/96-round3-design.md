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

Why a shared `tests/e2e/reset-helpers.ts` and not an inline `execFileSync` in
each spec: with two new call sites the block existed in four places
(`00-onboarding`, `01-empty-states`, `96-returns-…`, `debts`), each repeating
`E2E_DATA_DIR ?? path.join(process.cwd(), ".e2e-data")` — the same default
`playwright.config.ts` computes. One copy of that line cannot drift; four can.
`runE2eReset()` takes the script name as a union, so a typo is a compile error
at the source instead of a failed subprocess at run time. The file-specific
intent comments stay in the specs, next to the hooks they explain.

`00-onboarding.spec.ts` already had a local `runReset(script)` wrapper, so this
is the same shape moved to one module rather than a new convention — it now uses
the helper and lost its local copy.

## Sweep — every spec asserting an exact count or total

`debts.spec.ts` is *evidence about which assertion was checked*, not about which
one is at risk. Every spec that asserts an exact count/total, and whether it is
precondition-independent:

| Spec | Exact count/total asserted | Precondition-independent? |
| --- | --- | --- |
| `debts.spec.ts` | **GLOBAL** `debts-group-owed-total` 1500, `-owed-count` 1, `-weowe-total` 1200, `-weowe-count` 1 | **No** — fixed here (owns its reset in `beforeAll`) |
| `96-returns-supplier-action.spec.ts` | none (asserts presence/absence only) | n/a — but it left the leak; fixed here (`afterAll` reset) |
| `expense-reports.spec.ts:77` | `expense-history` tbody rows `toHaveCount(2)` — the current-month window over ALL expenses, plus the sort assertions beside it | **By convention, and double-protected**: the file header states "Expenses are only ever recorded by this spec", and no other spec writes one (`expensesCreate`/`expense-amount` appear only here, verified by grep). `debts.spec.ts`'s new `beforeAll` also deletes `expenses`, so the convention is re-established mid-run. Hardening means scoping the count *and* the sort assertions to rows this spec gave a unique note — deferred, see below. Round 1 recorded this as "the one assertion exposed if the 96 `afterAll` never runs"; round 2 showed that was wrong — the 96 spec leaks invoices and stock, never expenses |
| `rpc-helpers.spec.ts` | none — it pins `actAndAck`'s error semantics and stubs `customersCreate` to 500, asserting the mock answered so no real row can be written | Yes — nothing global is read; it needs only a provisioned owner, which `signIn` establishes |
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

## Third finding — the records reset did not reset three shop-record tables

`scripts/reset-e2e-records.mjs` is the script this fix leans on for "clean shop
records", and it was **incomplete**: against `apps/api/src/db/schema.ts` it reset
14 of the 17 shop-record tables and left `supplier_account_entries`,
`supplier_returns` and `supplier_return_lines` alone. Its own comment claimed
"children before parents" for a complete set, so the contract was wrong, not just
the list.

Both new hooks create those rows: the 96 spec's first test records a purchase
against an inline supplier, which writes a supplier-account charge. Because the
reset deletes `suppliers`/`invoices` first, the survivors become orphans that no
later assertion can see — until a future spec reads a supplier total across the
whole database, which is exactly the class this round is about.

Fix: add the three `DELETE`s (children first) and state the survivors explicitly
— `settings`, the auth tables, `expense_categories` (a seeded default) and the
three number sequences (invoice numbering must stay honest).

### Proof the three deletes matter

E2E runs, not a code reading. The 96 spec alone, then a row count on the shared
database:

| `reset-e2e-records.mjs` | `supplier_account_entries` | `supplier_returns` | `supplier_return_lines` |
| --- | --- | --- | --- |
| **before** (three deletes removed) | **1** | 0 | 0 |
| **after** (three deletes present) | **0** | 0 | 0 |

`supplier_returns`/`supplier_return_lines` are 0 in this run because the 96 spec
does not record a supplier return; `supplier-account.spec.ts` does, which is why
they are in the fix rather than only the table that showed a row here.

## Decisions taken after the first review round

Five independent reviewer sub-agents ran against the first code commit (three
test-audit lenses: edge cases, coverage, quality; two code-review axes:
standards, spec). Dispositions:

| Finding | Severity claimed | Decision |
| --- | --- | --- |
| Reset script omits three supplier tables | 🟠 | **Fixed** in its own commit, with the before/after counts above |
| Reset block duplicated in four specs (Duplicated Code / Shotgun Surgery) | smell | **Fixed** — `tests/e2e/reset-helpers.ts`; the doc's former "they already carry this exact pattern" defence was inaccurate and is corrected above |
| `afterAll` does not run on a killed worker / aborted run, so the leak can still reach later specs | 🔴 | **Accepted as a limit, recorded.** No hook survives `SIGKILL`; the alternatives are a `beforeAll` in every global-assertion spec (which `debts` now has) or a per-test reset. `expense-reports:77` is the one assertion still exposed, and it is recorded rather than hardenend because hardening it means rewriting its sort assertions too (see the sweep row) |
| The two resets are redundant for *this* regression — removing either one alone still passes | — | **Accepted, not changed.** They are not covering the same failure: `debts`'s `beforeAll` protects the global assertion against *any* leaker, and the 96 spec's `afterAll` stops *this* leaker from reaching every later spec. The brief asked for both and for the reason the other is not relied on, which the section above gives |
| `cwd: process.cwd()` and a relative script path (copied from `00`/`01`) | 🟡 | **Accepted.** Playwright runs specs from the config root; this is the pre-existing pattern and the helper keeps it in one place |
| Evidence was "claimed, not committed" | blocker | **Fixed** — the raw run logs are committed under `.scratch/reviews/96/` and the test-audit / code-review evidence files are added |
| Mutation harness for the expense race not committed | weakness | **Accepted.** The mutation is three lines and is described in this doc; committing a deliberately failing route into a spec would need it behind a flag. The failing trace that motivated it is not in the diff either — it was the parent's full-suite run, and the pre-fix failure signature is recorded above |

## Decisions taken after the second review round

The same five lenses ran again against the final code commit (`7e6622e`). What
changed as a result:

| Finding | Decision |
| --- | --- |
| The brief's **before-fix reproduction was prose, not a committed log** (both rounds) | **Fixed** — `round3/order3-before.log` re-runs the exact three-file order against the base versions of the two changed specs and records `1 failed, 8 passed · Expected "1200 دج" · Received "3200 دج"` |
| The sweep table gave **no verdict for `tests/e2e/rpc-helpers.spec.ts`** (the closing row dismissed it as a helper) | **Fixed** — its own row is in the table above |
| The doc claimed `expense-reports:77` was exposed if the 96 `afterAll` never runs | **Fixed** — wrong: no other spec writes an expense, and `debts`' `beforeAll` deletes `expenses` before that spec runs. That cell now says so |
| `actAndAck` resolves at the response body, **before** React's success handler clears the amount — the race narrows, it is not closed | **Fixed** — each save now also asserts the cleared end state (`expect(expense-amount).toHaveValue("")`) before the next fill. This is the same "prove the end state, not the click" rule as wisdom `2026-10-14-e2e-cleanup-must-prove-the-end-state` |
| The script comment named one surviving sequence where three survive | **Fixed** — the comment now names invoice, customer-return and supplier-return numbering |
| The 96 `afterAll` cannot be falsified by any run (it only proves the script exited 0) | **Accepted, deferred** — the schema-vs-DELETE-list drift guard would close it; it needs a maintained exclusion list, so it is in Deferred rather than bolted on |
| No green full-suite run on the final commit (the three extra `DELETE`s change what the seven specs between `96-…` and `debts` see) | **Attempted six times, not achieved, recorded.** Row 3b and `round3/full-suite-final.log`: the final commit's best run is 92/93, and the one failure is the shared `signIn` wait timing out on a machine running another crew lane (suite wall time 13–17 m against 11.9 m). Every flaking spec passes alone on this code. The full ordering green on the fix itself is row 3 (run A, `f5b8b0d`); the only behaviour `7e6622e` adds on top is three extra `DELETE`s, whose own before/after probe is row 6 |

## Decisions taken after the third (final verification) round

Two lenses ran over the post-round-2 delta (`7e6622e...dc00913`) against the
whole lane. No blockers. What changed as a result:

| Finding | Decision |
| --- | --- |
| `order3-before.log` did not name the failing test — every `ok` line was there, but the `1) …` identity line had been filtered out, so the log alone did not prove *which* file failed at the base | **Fixed** — the log was regenerated and now carries `1) tests\e2e\debts.spec.ts:14:1` beside the `1200 دج` / `3200 دج` pair. (The same review claimed the log cited `debts.spec.ts:35`; that line appears nowhere in it — `35` is the *post-fix* declaration, and the regenerated log shows the base line, `14`, verified with `git show 294a9af:tests/e2e/debts.spec.ts`) |
| The lane had no `<head-sha>-test-audit.md` / `-code-review.md` in the required evidence path, and the round-3 `.log` files carry no SHA in their names | **Fixed** — `.scratch/reviews/96/dc00913-test-audit.md` and `dc00913-code-review.md`, both naming the reviewed commit and the commands behind every claim |
| The end-state assertion could have been vacuous (reading `""` from an empty form that never had a value) | **Verified non-vacuous, nothing to change** — `expense-amount` is a controlled input (`value={amount}`), so it can only read `""` after `onSuccess` cleared the just-filled value |

## Deferred

- `expense-reports.spec.ts:77`'s global row count and its sort assertions could
  be scoped to rows this spec labelled with a unique note, removing the last
  "no earlier spec adds records" dependency in the suite. Deferred because it
  rewrites three assertions in a spec this round did not set out to touch, and
  the file's header already documents the convention honestly.
- A drift guard that reads `apps/api/src/db/schema.ts` and fails when a
  shop-record table has no `DELETE` in the reset script. Deferred: it needs a
  maintained exclusion list (settings, auth, seeded categories, sequences),
  which is its own design.

## Evidence

All commands run from the worktree root, on a lane-private port pair
(`DOKAN_PORT=4341 DOKAN_WEB_PORT=5193`, vault `4409`/`5184`), with every listener
on those ports killed and `.dokan-port` removed first (wisdom
`2026-10-13-e2e-stale-server-and-checksum-flake`).

| # | Command | Result |
| --- | --- |
| 1a | `bunx playwright test 01-empty-states 96-returns-supplier-action debts` — **before**, base versions of the two changed specs (`round3/order3-before.log`) | **1 failed, 8 passed** · `1) tests\e2e\debts.spec.ts:14:1` · `Expected "1200 دج"` / `Received "3200 دج"` (`:77` is the assertion line; `:14` is the base test's declaration) |
| 1b | the same three files — **after** (`round3/order3-after.log`) | **9 passed**, including both 96 tests and their own assertions |
| 2 | `bunx playwright test tests/e2e/debts.spec.ts` (`round3/debts-alone.log`) | **1 passed** (alone, with its new `beforeAll`) |
| 3 | `bun run test:e2e` full ordering at `f5b8b0d` (`round3/full-suite-flakes.log` run A) | **93 passed, 0 failed** (11.9 m) |
| 3b | the same at the final code, six attempts | 90–92 passed. Every failure is a 5 s `expect` or 30 s test **timeout**, and every flaking spec passes alone: `supplier-account`, `learnability`, `customers`, `stock-ledger`, `01-empty-states`, and on run F the shared `signIn` wait for the dashboard. One attempt aborted with no Playwright error at all (killed process). `debts`, `96-…` and `01-empty-states` passed in every run that produced results — see `round3/full-suite-flakes.log` and `round3/full-suite-final.log` |
| 4 | `bun run typecheck` / `bun run lint` / `bun run test` / `bun test scripts/e2e-selection.test.ts` (`round3/guard-phase1.log`) | all exit 0; selection guard 35 pass, 0 fail, map untouched |
| 5 | mutation: delayed first `expensesCreate`, test 2 pre-fix / post-fix | fail / pass |
| 6 | `reset-e2e-records.mjs` table probe, three `DELETE`s removed then present (`round3/reset-tables.log`) | `supplier_account_entries` **1 → 0** |

A first full-suite attempt (before the `actAndAck` fix) is what surfaced the
expense race: **92 passed, 1 failed** on `expense-reports.spec.ts:196`. Raw logs
for every run named above are committed under `.scratch/reviews/96/round3/`.

## Risks

- The `debts.spec.ts` reset deletes shop records created by the specs between
  `96-` and `debts` (activity, arabic-search, backups, catalog-scan,
  completion-screens, customer-name-variants, customers). Evidence row 3 is the
  test of that: the full suite was green at `f5b8b0d`, and `debts` itself never
  failed in any later run either.
- E2E run-to-run flakiness on a loaded machine: Evidence rows 3b and
  `full-suite-flakes.log`. Not caused by this diff — every flaking spec is one
  this round does not touch and every one passes alone — but the parent should
  read a local 92/93 as load, not as a regression.
- A 96-spec run rewrites the committed round-2 screenshots under
  `.scratch/reviews/96/screenshots/round2/` (a 4-byte PNG difference) and
  `.dokan-port`, so the tree is dirty after any e2e run. Pre-existing; restored
  before committing, and recorded because Guard Phase 2 asks for a clean tree.
- The reset clears server-side UI preferences. `pagination.spec.ts` sets its own
  `ui.pageSize` explicitly for exactly this reason, and `00-onboarding` already
  clears preferences mid-run, so this is not a new class of clearing.
- The `expense-reports` fix is a second concern in a narrow brief. It is a
  separate commit so the parent can drop it without touching the interference
  fix.
- A one-spec-flake rerun is not proof by itself; the `actAndAck` change is the
  only one here whose proof came from a deterministic mutation rather than a
  green run.

