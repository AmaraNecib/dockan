# Guard — issue #161, Greptile round-2 fix commit

## Phase 1 — pre-commit (Husky `oxlint` hook ran on the commit)

| Check | Command | Result |
|---|---|---|
| typecheck | `bun run typecheck` | 3/3 workspaces pass |
| lint | `bun run lint` | 0 errors |
| unit + store tests | `bun run test` | api 752 pass / 0 fail; web 759 pass / 0 fail |

## Phase 2 — pre-push (HEAD `0e56e48a6ff2b09bd273b7b1001df8fe4c584857`)

| Check | Command | Result |
|---|---|---|
| typecheck | `bun run typecheck` | 3/3 pass |
| lint | `bun run lint` | 0 errors |
| tests | `bun run test` | api 752 pass; web 759 pass; 0 fail |
| e2e (UI changed) | `bun run test:e2e` | 51 passed (3.0m) |
| working tree | `git status --short` | only `.scratch/` evidence (non-reviewable) |
| evidence | `.scratch/reviews/161/<sha>-{test-audit,code-review}.md` | present for `0e56e48`; older rounds archived under `superseded/` |

Note: the test-audit reviewer's isolation experiment damaged this worktree's
`node_modules` and deleted `packages/contracts/**`; the lane restored the
sources with `git restore`, re-ran `bun install`, and re-ran every gate above
green. No tracked source was changed by the reviewer.

## Review evidence

- Reviewed implementation SHA: `0e56e48a6ff2b09bd273b7b1001df8fe4c584857`
- Test-audit: the round-2 regression test drives the real panel and fails
  without the one-line gate (empirically verified at the exact assertion);
  `cashInvalid` stays shared and is guarded in free-standing.
- Code-review: both axes pass; the gate matches `disabled` in each mode and the
  free-standing submit never reads the hidden invoice drafts.

## Greptile round-2 finding → fix

Hidden invoice quantity drafts warned in free-standing mode. The warning is now
gated on `mode === "INVOICE_LINKED"`; `cashInvalid` stays shared
(`supplier-return-panel.tsx:235`). Regression test in
`supplier-return-panel.test.tsx`.

## Deferred (non-blocking)

- Assertion-width notes from the test-audit (N1/N3): the free-standing cash test
  could also assert the confirm button is disabled; `openSelect` could assert the
  committed value.
