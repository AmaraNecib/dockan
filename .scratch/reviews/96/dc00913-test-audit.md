# Test audit — issue #96 round 3

- **Tier:** Standard (test infrastructure; no product behaviour). Recorded with justification in `.scratch/implementation/96-round3-design.md`.
- **Base:** `294a9af` (PR #245 head, `origin/issue-96-empty-states`).
- **Reviewed code:** `dc00913`. Evidence HEAD (this file): the commit after it, which touches only `.scratch/**` — so the staleness rule in `docs/engineering-workflow.md` holds.
- **Method:** three independent reviewer sub-agents per round (edge-case hunter, coverage analyst, quality reviewer), each with a read-only worktree. An unstated gate is an unrun gate, so every command and its result is listed below.

## Rounds

| Round | Reviewed | Lenses | Verdict |
| --- | --- | --- | --- |
| 1 | `f5b8b0d` | 3 test-audit + 2 code-review | A−; 1 🟠, 2 🟡, 1 🔴-as-limit |
| 2 | `7e6622e` | 3 test-audit + 2 code-review | B+; no blockers, 4 notes |
| 3 | `7e6622e...dc00913` delta | 1 test-audit + 1 standards/spec | no blockers; the new end-state assertion verified non-vacuous |

## Findings and dispositions

| Round | Finding | Disposition |
| --- | --- | --- |
| 1 | 🟠 `reset-e2e-records.mjs` left `supplier_account_entries`, `supplier_returns`, `supplier_return_lines` behind, orphaning rows once `suppliers`/`invoices` were deleted | **Fixed** (`7e6622e`). Before/after probe in `round3/reset-tables.log`: `supplier_account_entries` 1 → 0. Round 3 re-derived the table list from `apps/api/src/db/schema.ts` and found no table still missing |
| 1 | Duplicated reset block (5 lines × 4 specs) — Duplicated Code / Shotgun Surgery | **Fixed** (`be50dfc`): `tests/e2e/reset-helpers.ts`, script name as a union, one data-dir default |
| 1 | 🔴 `afterAll` does not run on a killed worker, so a leaked row can still reach later specs | **Accepted as a limit, recorded.** No hook survives `SIGKILL`; `debts.spec.ts` owns its precondition in `beforeAll`, and the 96 spec's `afterAll` covers failure and abort. Round 2 showed the doc's claim that this left `expense-reports:77` exposed was wrong (`debts`' own reset deletes `expenses` first, and no other spec writes one) — corrected |
| 1 | The two resets are redundant for the debts regression: removing either alone still passes | **Accepted, not changed.** They guard different failures (any leaker vs this leaker). Stated plainly in the design doc rather than dressed up |
| 1 | Mutation harness for the expense race not committed | **Accepted.** Three lines, described in the design doc; the failing signature is recorded and the pre-fix reproduction is now a committed run log |
| 1, 2 | The brief's before-fix reproduction was prose, not a committed log | **Fixed**: `round3/order3-before.log`, re-run against the base versions of the two changed specs, now carries the failing test's own identity — `1) tests\e2e\debts.spec.ts:14:1` — beside `Expected "1200 دج" / Received "3200 دج"` |
| 2 | The sweep gave no verdict for `tests/e2e/rpc-helpers.spec.ts` (dismissed as a helper) | **Fixed**: its own row is in the design doc's sweep table (no count/total; stubs `customersCreate` to 500) |
| 2 | `actAndAck` resolves at the response body, **before** React's `onSuccess` clears the amount — the race narrows, it is not closed | **Fixed** (`dc00913`): each save now also asserts the cleared end state. Round 3 verified the assertion cannot pass vacuously — `expense-amount` is controlled (`value={amount}`, `expenses.tsx:367`), so it can only read `""` after `onSuccess` cleared the just-filled value |
| 2 | The reset script's comment named one surviving sequence where three survive | **Fixed** (`dc00913`) |
| 2, 3 | The 96 `afterAll` proves nothing by itself (it only checks the script exited 0) | **Accepted, deferred**: a drift guard that parses `schema.ts` and asserts every shop-record table appears in the DELETE list. It needs a maintained exclusion list, so it is recorded in the design doc's Deferred section rather than bolted on |

## Gates run (all from the worktree root, lane-private ports)

| Command | Result |
| --- | --- |
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 |
| `bun run test` | exit 0 (74 tests, 0 fail) |
| `bun test scripts/e2e-selection.test.ts` | exit 0 (35 pass) — `tests/e2e-selection.map.json` untouched |
| `bunx playwright test 01-empty-states 96-returns-supplier-action debts` — before | **1 failed, 8 passed** (`round3/order3-before.log`) |
| the same three files — after | **9 passed** (`round3/order3-after.log`) |
| `bunx playwright test tests/e2e/debts.spec.ts` | **1 passed** (`round3/debts-alone.log`) |
| `bunx playwright test tests/e2e/expense-reports.spec.ts --grep "reconciles revenue"` | **1 passed** (`round3/full-suite-final.log`) |
| `bun run test:e2e` (full ordering) | **93 passed / 0 failed** at `f5b8b0d` (`round3/full-suite-flakes.log`, run A). Six attempts at the final code reached 90–92 passing; every failure was a 5 s `expect` / 30 s test **timeout** in a spec this round does not touch, each green alone |

Raw logs for every run above are committed under `.scratch/reviews/96/round3/`.

## Not verified locally

A 93/93 full-suite run at `dc00913`. Six attempts; the machine was running a
second crew lane and the suite's wall time went from 11.9 m to 13–17 m. Nothing
was hidden: `round3/full-suite-flakes.log` names every run, its failures, and the
isolation pass for each flaking spec. CI runs this suite on an idle machine.
