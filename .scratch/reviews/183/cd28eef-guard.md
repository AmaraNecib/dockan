# #183 guard evidence (PR #203 review-fix round 3)

- Issue: #183, names-only supplier lookup for the opening-balance conflict check
- Tier: standard (money-adjacent: the opening-balance write gate)
- Branch: `feat-183-names-lookup`
- Reviewed head (code): `cd28eef8c005d43a32c906add7068c9b4d60f6e6`
- Base: `origin/develop` `3c3abcf` (post-#184); previous reviewed head `6769195`
- Finding fixed: Greptile round 3 — the waiting-save path in
  `apps/web/src/pages/supplier-opening-balance.tsx` captured `listFailed` from
  the render that started `submit()`, so a supplier read that failed while the
  name resolver was held still wrote the batch behind the failure banner.
- Delta under review: `git diff 6769195 cd28eef` — one source page, one test file.
- No push. No PR update. No remote writes.

## Guard 1, pre-commit

| Check | Command | Exit | Result |
|---|---|---|---|
| Typecheck | `bun run typecheck` (turbo, 3 packages) | 0 | clean |
| Lint | `bun run lint` (oxlint) | 0 | clean |
| Tests | `bun run test` (turbo, concurrency 2) | 0 | api 907/0 (cached), web 994/0, desktop 59/0 |
| Rust | not applicable (no `apps/desktop/src-tauri/src/` change) | n/a | |
| Focused (web) | `cd apps/web && bun test src/pages/supplier-opening-balance.test.tsx` | 0 | 54 pass / 0 fail |

Logs: `.scratch/reviews/183/logs/r3-guard1-{typecheck,lint,test}.log`,
`.scratch/reviews/183/logs/r3-focused-opening-balance.log` (54 pass, 225 expect).

The web suite went 991 -> 994: the three new regression tests. API unchanged.

## Guard 2, pre-review

Isolated ports, all four set (`DOKAN_PORT=4477 DOKAN_WEB_PORT=5203
DOKAN_VAULT_PORT=4487 DOKAN_VAULT_WEB_PORT=5204`). Three sibling lanes were
running (`feat-198`, `fix-109`, `test-206`); `DOKAN_VAULT_PORT` keeps this
lane's vault pair disjoint from theirs.

| Check | Command | Exit | Result |
|---|---|---|---|
| Typecheck | `bun run typecheck` | 0 | clean |
| Lint | `bun run lint` | 0 | clean |
| Tests | `bun run test` | 0 | api 907/0 (cached), web 994/0 |
| E2E run 1 | four ports, `bun run test:e2e` | 1 | 68 passed / 1 failed (vault flake) |
| E2E vault rerun | `bunx playwright test tests/e2e/vault.spec.ts` | 0 | 3 passed / 0 failed (48.2s) |
| E2E run 2 (full) | four ports, `bun run test:e2e` | 0 | 69 passed / 0 failed (9.9m) |
| Working tree | `.dokan-port` restored to `4317` | clean | |

Logs: `.scratch/reviews/183/logs/r3-guard2-e2e.log` (run 1),
`r3-guard2-vault-rerun.log` (isolated), `r3-guard2-e2e-rerun.log` (run 2, final).

### Flake attribution (contention)

Run 1 failed one unrelated spec: `vault.spec.ts:215` "after a restart the vault
is locked; recovery unlocks it and sets a new working passphrase" — a 5s
`expect(getByTestId("vault-settings-saved")).toBeVisible()` timeout after
`vault-reset-submit` (a recovery-key passphrase rotation). The page was still
on the settings write when the deadline hit. Isolated rerun of the whole vault
spec: 3/3 passed, the same test in 17.1s. Full rerun of all 69: green. This is
CPU contention on a vault write, the same class the previous guard documented
(`fix-109`/`feat-198`/`test-206` all active); no #183/#184 code is touched by
that spec and no vault source is in the delta.

Every #183/#184 e2e test passed in both runs, including
`tests/e2e/supplier-adjustment.spec.ts` (12 tests, incl. cancel-while-pending,
dialog-cancel, back-link, browser-back, sidebar, edited-name) and
`tests/e2e/no-write-window.spec.ts` (5 tests).

## Fix summary

`save()` and the post-await `submit()` continuation now call
`liveListFailure()`, which reads `queryClient.getQueryState(...).status` for
`suppliersListNames` and `suppliersAccountSummaries` at the moment of use,
instead of the captured `listFailed` render value. See
`cd28eef-test-audit.md` for the mutation proof and the full captured-value
audit.

## Not done (authority boundary)

No push. No PR update. No remote writes.
