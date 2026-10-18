# Code-review evidence — #184 rebase round 2 (PR #190)

- PR base: `origin/develop` @ `21dbc13` (#197, #193, #202 merged); previous
  merge-base `f757211`; pre-rebase head `fbc30ee`; rebased final code `7bca6a6`;
  certified head `81a337d` (this evidence's header SHA).
- Tier: **High-assurance** (opening-balance money math). Standards + Spec axes
  re-run over the rebase delta; the round-4 findings below still hold for the
  unchanged code.

## Rebase (the only delta)

`git rebase origin/develop` replayed 27 commits. Exactly one conflict, in
`apps/web/src/pages/supplier-opening-balance.test.tsx` — the same file both
sides edit; every other file auto-merged. Git stopped on two of this branch's own
round-4 commits (`d36ce3b`, `76ac83e`), both in that one file.

- **develop (#202/#193)** added `setNativeValue`, the batched `fillAmounts`
  helper and the named `BATCH_LIMIT_TEST_TIMEOUT_MS`, and converted both
  batch-limit tests (the 200-row "Greptile finding 4" case and the 201-supplier
  "round 5" case) from a per-input `act`/`dispatchEvent` loop to `fillAmounts`.
  Reason: 200 discrete controlled-input events re-render the 200-row table 200
  times (~15 s isolated, 60 s under contention).
- **this branch** had rewritten the same file across rounds 1–4: the
  `clickTarget` / `clickOn` / `dispatchClickOn` helpers, `NEW_TAB_ACTIVATIONS`,
  and all five round-4 new-tab tests plus the plain-click control and the
  `target="_blank"` case.

Resolution — **kept both intents, weakened neither**:

- took develop's `setNativeValue` / `fillAmounts` / `BATCH_LIMIT_TEST_TIMEOUT_MS`
  verbatim and adapted this branch's two batch-limit tests to `fillAmounts`.
  There is now exactly **one** fill helper, not two.
- kept this branch's helper shape. `modifiedClickOn` (round 4) is superseded by
  this branch's own next commit (`76ac83e`), so the merged file has `clickOn` +
  `dispatchClickOn` over the shared `clickTarget`; develop's constant sits beside
  them.
- no test was deleted, renamed or relaxed. `diff` of the merged file against the
  pre-rebase branch file is exactly develop's #202 additions (`setNativeValue`,
  `fillAmounts`, the named constant, the two `fillAmounts` call sites, the two
  `BATCH_LIMIT_TEST_TIMEOUT_MS` budgets) and nothing else.

Proof (see test-audit): the 200-row and 201-supplier tests pass (1204 ms and
1124 ms — batched) and all seven round-4 new-tab cases pass.

## Standards axis

Sources: `AGENTS.md` (search-scope rule), `docs/engineering-workflow.md`,
`docs/development-workflow.md`, the `oxlint` + `tsc` gates, and the round-4
skill baseline.

- **No duplicated helper** — the merge deliberately keeps a single fill helper
  (develop's) rather than two; `setInput` and `fillAmounts` share
  `setNativeValue`.
- **No dead helper** — `modifiedClickOn` is absent and unreferenced;
  `clickOn`/`dispatchClickOn` both route through `clickTarget`, so the null-throw
  exists once.
- Round-4 standards findings (fixed at `76ac83e` / `7bca6a6`) carry forward
  unchanged: shared `clickTarget`, extracted `openConfirmWithRefusedSaveHeld` /
  `releaseHeldRecovery`, reworded predicate docstring, narrowed `ReactMouseEvent`.
- `bun run lint` (oxlint 1.85.0) → 0.

## Spec axis

| Requirement | Status |
|---|---|
| Rebase onto `origin/develop` @ `21dbc13` | done; `origin/develop` is an ancestor of the rebased head |
| Keep develop's 201-supplier / 200-row load-proof tests | kept, on `fillAmounts` + `BATCH_LIMIT_TEST_TIMEOUT_MS`, passing |
| Keep the round-4 `navigatesCurrentTab` cases (Ctrl/Cmd/Shift/Alt/middle + plain-click control + `target="_blank"`) | kept, passing |
| Weaken neither side | file diff shows only develop's #202 additions; no assertion changed |
| Single fill helper if both exist | done — develop's kept, this branch's adapted |
| Re-run Guard 1+2 on isolated ports | green (below) |

## Verification (at `7bca6a6` / certified `81a337d`)

- `bun run typecheck` → **0** (3/3 tasks).
- `bun run lint` → **0**.
- `bun run test` → **0**; web **986 pass / 0 fail**.
- `DOKAN_PORT=5417 DOKAN_WEB_PORT=6273 DOKAN_VAULT_PORT=4599 DOKAN_VAULT_WEB_PORT=5274 bun run test:e2e` → **0**; **64 passed / 0 failed** (6.8 m), vault spec on its isolated pair included.
- Working tree clean after restoring the tracked `.dokan-port` the e2e run rewrites.
