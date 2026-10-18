# #183 guard evidence (review-fix round 2)

- Issue: #183, names-only supplier lookup for the opening-balance conflict check
- Tier: standard (test-only change)
- Branch: `feat-183-names-lookup`
- Base for the reviewed diff: `80fdd94` (round-1 head); merge-base with `origin/develop` is `f757211`
- Reviewed head: `cbd2337c71efdb9bb999941f922e7e39b22299c7`
- Round delta: `apps/web/src/pages/supplier-opening-balance.test.tsx` only (test-only)
- Guard 1 and Guard 2 ran on the reviewed head, before the evidence commit

## Guard 1, pre-commit

| Check | Command | Exit |
|---|---|---|
| Typecheck | `bun run typecheck` (turbo, 3 packages) | 0 |
| Lint | `bun run lint` (oxlint) | 0 |
| Tests | `bun run test` (turbo, concurrency 2) | 0, api 888/0, web 963/0, desktop 57/0 |
| Rust | not applicable (no `apps/desktop/src-tauri/src/` change) | n/a |
| Focused | `cd apps/web && bun test --max-concurrency=2 src/pages/supplier-opening-balance.test.tsx` | 0, 25 pass / 0 fail |

Logs: `.scratch/reviews/183/logs/r2-guard1-{typecheck,lint,test}.log`.

## Guard 2, pre-review

| Check | Command | Exit |
|---|---|---|
| Typecheck | `bun run typecheck` | 0 |
| Lint | `bun run lint` | 0 |
| Tests | `bun run test` | 0 |
| E2E | `DOKAN_PORT=4523 DOKAN_WEB_PORT=5323 bun run test:e2e` | 0, 57 passed / 0 failed (4.9m) |
| Working tree | clean after the evidence commit (only ignored `.dokan-port` churn) | clean |
| Evidence current | `.scratch/reviews/183/cbd2337-*.md` names the reviewed head | valid |

Log: `.scratch/reviews/183/logs/r2-guard2-e2e.log` (57 `ok` lines, `57 passed`).

Ports: 4523/5323. I avoided 4399/5174 (`vault.spec.ts` hardcodes them) and the shared 4317/5173 pair. The run was green in one pass, including `vault.spec.ts:166`.

## Mutations run during the fix

1. Removed both `listFailed` guards (`|| listFailed` in `submit()`, the `if (listFailed)` block in `save()`). The two read-failure tests failed. This is the Greptile finding's proof.
2. Set `blockedReason` to `null` (removed `overLimit`, `invalidExisting`, `typedNameConflict`, `newRowError`). Seven blocked-reason tests failed.

The page was restored after each and the clean tree re-verified. Details in `cbd2337-test-audit.md`. The mutation logs are local and gitignored under `.scratch/reviews/183/logs/`.

## `origin/develop` and #190 re-check (end of round)

Final `git fetch origin develop`:

- `origin/develop` is `21dbc13` ("test: configurable vault ports and a load-proof 201-supplier test (closes #193, closes #202)"). It moved twice since the round-1 base `f757211`: first `779f671` ("ci: upload e2e failure evidence so a red run leaves a trace (closes #197)"), then `21dbc13`. Both are outside this branch, so the branch is 2 develop commits behind.
- Relevant after a rebase: `21dbc13` makes the vault e2e ports configurable (retiring the hardcoded 4399/5174) and adds a "load-proof 201-supplier test" that may overlap with this branch's 200/201-row tests. The rebase should reconcile the two rather than leave both.
- `gh pr view 190` -> `{"number":190,"state":"OPEN","mergedAt":null,"mergeCommit":null}` on branch `feat-184-server-name-resolution`.

PR #190 has NOT landed. It edits the same files (`rpc/router.ts`, `packages/contracts/src/{core,app-contract}.ts`, `supplier-opening-balance.tsx`) and must land first, so this branch still needs a further rebase onto the post-#190 `develop` once it merges. That rebase is out of scope for this round and was not started.

## Not done (authority boundary)

No push, no PR update, no merge, no remote writes.
