# Test-audit evidence — #184 rebase round 2 (PR #190)

- PR base: `origin/develop` @ `21dbc13`; previous merge-base `f757211`;
  pre-rebase head `fbc30ee`; rebased final code `7bca6a6`; certified head
  `81a337d` (this evidence's header SHA).
- Tier: **High-assurance** (opening-balance money math). Delta audited: the
  merge resolution in `apps/web/src/pages/supplier-opening-balance.test.tsx`
  (round-4 findings T1–T11 carry forward for the unchanged tests).

## The proof the merge preserved both sides

| Side | Tests | Result |
|---|---|---|
| **develop (#202/#193)** load-proof batch limit | `blocks a batch over the 200-row contract limit before saving (Greptile finding 4)` — 200 rows via `fillAmounts`, `BATCH_LIMIT_TEST_TIMEOUT_MS` | **pass**, 1204 ms (batched) |
| **develop (#202/#193)** load-proof 201-supplier | `counts a typed name toward the batch limit and blocks before the server (round 5)` — 200 of 201 rows via `fillAmounts(...).slice(0, 200)`, `BATCH_LIMIT_TEST_TIMEOUT_MS` | **pass**, 1124 ms (batched) |
| **this branch** round-4 new-tab | `NEW_TAB_ACTIVATIONS` = Ctrl / Cmd / Shift / Alt / middle, each `keeps the dialog open when a <activation> hits the back link …` | **pass** (895 / 110 / 497 / 408 / 99 ms) |
| **this branch** round-4 control | `abandons the dialog on a plain back-link click …` (`{ button: 0 }`) | **pass**, 898 ms |
| **this branch** round-4 debate | `keeps the dialog open when the back link targets a new tab …` (`target="_blank"`, plain button) | **pass**, 99 ms |

Both `fillAmounts` call sites in the merged file:

```
fillAmounts(Array.from(inputs), (index) => String(index + 1));          // 200-row case
fillAmounts(Array.from(inputs).slice(0, 200), () => "1");               // 201-supplier case
```

and both tests close with `}, BATCH_LIMIT_TEST_TIMEOUT_MS);`.

## Findings and resolutions

| # | Risk | Finding | Resolution |
|---|------|---------|------------|
| M1 | 🔴 | The conflict is one file both sides rewrote; a resolution that picks a side drops the other's tests. | **Union kept**. `diff` of the merged file against the pre-rebase branch file is exactly develop's #202 additions; no assertion was removed or relaxed. Both proof sets pass in one run. |
| M2 | 🟠 | Two fill helpers (`fillAmounts` + a branch-local one) would drift. | **Single helper**: only develop's `fillAmounts` exists; this branch had no competing helper, and both batch-limit tests now call it. |
| M3 | 🟡 | The named timeout could hide a re-introduced load cost. | **Accepted**: the fills run in ~1.2 s against a 60 s budget (>40x headroom), and develop's "fix the cost — do not raise it" docstring is retained. |
| M4 | 🟡 | Round-4 tests could be silently missing after the merge. | **Closed**: all seven new-tab cases are present and pass; `modifiedClickOn` is gone because the branch's own `76ac83e` replaced it — no coverage was lost, only the helper name. |
| M5 | 🟡 | Test count regression. | **Closed**: web **986 pass / 0 fail**, equal to the pre-rebase round-4 run. |

## Round-4 findings carried forward (unchanged tests)

T1 conjunct coverage (parameterised over all five activations), T2 setup
extraction, T3 shared `clickTarget` + `dispatchClickOn`, T4 nested-`act`
removal, T5 predicate-docstring reword, T6 `ReactMouseEvent` narrowing, T7
synthetic `button: 1` documented, T11 `target="_blank"` target check — all
still present and green, verified by reading the merged file and by the run
below.

## Verification (at `7bca6a6` / certified `81a337d`)

- `bun run typecheck` → **0** (3/3 tasks).
- `bun run lint` → **0**.
- `bun run test` → **0**; web **986 pass / 0 fail / 5156 expect() calls**.
- `DOKAN_PORT=5417 DOKAN_WEB_PORT=6273 DOKAN_VAULT_PORT=4599 DOKAN_VAULT_WEB_PORT=5274 bun run test:e2e` → **0**; **64 passed / 0 failed** in 6.8 m.
  - `supplier-adjustment.spec.ts` issue-184 cases (folded-name dialog, the three
    leave paths, the round-2 dialog-cancel and row-edit cases) all pass.
  - `vault.spec.ts` passes on its isolated pair (`DOKAN_VAULT_PORT=4599`,
    `DOKAN_VAULT_WEB_PORT=5274`).
- **Contention: none.** Full suite green on the first isolated-port attempt.
