# Test audit — issue #207 (extract a `submitForm()` helper and close the opening-balance boundary gaps)

- **Lane:** `test-207-submitform-helper` (branch `test-207-submitform-helper`)
- **Base (target `develop`):** `origin/develop` @ `1ea76b5cd9ea7a7d88133564c73eaad12e9a8aee`
- **Reviewed HEAD SHA:** `8a43955632aad80b060511ae0697473a2d1e161a`
- **Tier:** Standard. Test-only (no production, contract or schema change), but it edits a reviewed test file, so the Standard gates apply.
- **Diff under audit:** `git diff 1ea76b5...8a43955` — `.scratch/implementation/207-design.md` (new), `apps/web/src/pages/supplier-opening-balance.test.tsx` (modified). No production file.

## Guard Phase 1 — commands and exit codes

Run from the worktree root on `8a43955`:

| Command | Exit |
|---|---|
| `bun run typecheck` | 0 (`Tasks: 4 successful, 4 total`) |
| `bun run lint` | 0 |
| `bun run test` | 0 (`Tasks: 4 successful, 4 total`) |
| `cd apps/web && bun test src/pages/supplier-opening-balance.test.tsx` | 0 (`69 pass, 0 fail, 283 expect()`) |
| `bun run skills:check` | 0 (`skills mirror in sync: 32 skills`) |
| `cd apps/api && bunx tsc --noEmit` | 0 |

The three pre-commit hook commands (`lint`, `skills:check`, `apps/api tsc`) also passed as the Husky `pre-commit` hook on the commits that produced this SHA.

## Coverage before vs after

| | `origin/develop` (`1ea76b5`) | HEAD (`8a43955`) |
|---|---|---|
| Tests run (`bun test` on the file) | 61 pass / 0 fail | **69 pass / 0 fail** |
| `expect()` calls at runtime | 256 | 283 |
| `it(` blocks (`grep -cE '^\s*it\('`) | 56 | 64 |

`git diff 1ea76b5...HEAD` adds **8** `it(` blocks and removes **0**. No test and no assertion was deleted; the only removed lines are the repeated inline `requestSubmit()` scaffolds (now inside `submitForm`) and one comment. The helper did not remove coverage.

The 8 new cases: negative draft; amount `1` (low end); amount `0` on a row; `MAX_SAFE_INTEGER` (high end); `MAX_SAFE_INTEGER + 1`; amount `0` in the typed new row; exactly 200 filled rows; 199 filled rows plus one typed row (= 200).

## Mutation discrimination (re-verified in this lane)

Each mutation was applied to the production file, the named test run, then the file restored from a backup; `git status --short` was clean after each. The guarded production files are unchanged on this branch, so the mutation result applies to every commit here.

| # | Mutation | Test command | Exit | Observed failure |
|---|---|---|---|---|
| 1 | `sed -i '28s/.*/  if (amount === null) return { status: "invalid" };/' apps/web/src/lib/supplier-opening-draft.ts` (drop `amount <= 0`) | `cd apps/web && bun test src/pages/supplier-opening-balance.test.tsx -t "rejects amount 0, one below the accepted range"` | **1** | `expect(...opening-balance-amount-error).not.toBeNull()` → received `null` |
| 2 | `sed -i 's\|const normalized = normalizeArabicIndicDigits(draft).trim();\|const normalized = ...trim().replace(/-/gu, "");\|' apps/web/src/lib/amount-parse.ts` (strip sign before parsing) | `cd apps/web && bun test src/pages/supplier-opening-balance.test.tsx -t "rejects a negative amount draft"` | **1** | `expect(...opening-balance-amount-error).not.toBeNull()` → received `null` |
| 3 | `sed -i 's\|  return Number.isSafeInteger(value) ? value : null;\|  return value;\|' apps/web/src/lib/amount-parse.ts` (drop safe-integer check) | `cd apps/web && bun test src/pages/supplier-opening-balance.test.tsx -t "rejects an amount one above the largest safe integer"` | **1** | `expect(...opening-balance-amount-error).not.toBeNull()` → received `null` |
| 4 | `sed -i 's\|return totalRows > MAX_OPENING_BALANCE_ROWS;\|return totalRows >= MAX_OPENING_BALANCE_ROWS;\|' apps/web/src/lib/supplier-opening-draft.ts` | `cd apps/web && bun test src/lib/supplier-opening-draft.test.ts -t "MAX_OPENING_BALANCE_ROWS"` | **1** | `expect(isOpeningBatchOverLimit(200)).toBe(false)` → received `true` |

The mutations were also confirmed to *not* affect any unmutated run: after every restore the affected tests passed again (`git status` clean).

Note (unchanged from the design): the page-level `>`→`>=` mutation hangs the bun/happy-dom runner when the 200-row test fails, so the exact-cap boundary is pinned by the pure predicate unit test (mutation 4), which fails cleanly.

The three reject tests run on `TWO_NO_ENTRY_SUPPLIERS` (no accounts with entries), so a dropped guard must **send** the batch and `captured === null` fails on its own, independent of the visible-error assertions.

## Test-audit lenses (independent sub-agents)

Three independent reviewer sub-agents ran the edge-case / coverage / quality lenses on `686f949`, `3925ba3` and finally `8a43955`.

- **Edge Case Hunter:** no RED gaps. Previously surfaced candidates (whitespace-only draft, Arabic-Indic digits at page level, typed-row negative, empty supplier list, a runtime guard for the helper's `null` hatch) are either safe direction, parser-covered, or explicitly deferred in the design. One soft note: the exactly-200 accept test asserts `rows.every(row => row.amount === 1)`, which a dropped-then-duplicated row would still satisfy — the inline "not met by dropping or duplicating a row" comment overstates the assertion.
- **Coverage Analyst:** every acceptance criterion in `gh issue view 207` has a test; all 8 new tests call `submitForm`; none is vacuous; no duplicate coverage (`amount 0` on a row vs typed row hit separate `<= 0` branches).
- **Quality Reviewer:** **grade A.** Assertion count 223 → 250 by line scan (runtime 256 → 283); zero removed `expect(` lines; helper async/act handling sound; JSDoc accurate.

### Disposition

| Finding | Severity | Action |
|---|---|---|
| Whitespace-only / Arabic-Indic / typed-row negative / empty list / runtime guard | YELLOW, out of scope | Deferred in `207-design.md` (`## Deferred (not required by #207)`) |
| 200-row accept assertion overstates "not dropping/duplicating" | YELLOW, assertion strength only | Left as-is; the `isOpeningBatchOverLimit(200) === false` unit test pins the cap exactly. Documented here. |
| `submitForm` row-1-has-no-entries invariant is comment-enforced only | YELLOW, drift risk | JSDoc now states it explicitly and warns when adding callers |
| Helper `null` hatch could drift vacuous | YELLOW | Attempted a runtime non-empty-batch guard; reverted because the two read-failure callers submit after a list error has unmounted the table, so a DOM guard fails them without protecting anything. Documented as deferred. |

No RED findings; nothing required a test change after the final round.
