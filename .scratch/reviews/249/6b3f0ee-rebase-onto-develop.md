# #249 rebase onto develop — verification at 6b3f0ee

Rebranch of PR #251 (`issue-249-ast-walk`) onto `origin/develop` `b517553`, after
#246 squash-merged and left no shared SHA with the stacked branch.

## Method

Fresh worktree at `origin/develop` (`b517553`); cherry-picked exactly the four
AST-walk commits: `git cherry-pick ad8445f..issue-249-ast-walk`.

| stacked | rebased | subject |
|---|---|---|
| `353089e` | `f83502c` | replace the raw-`.trim()` scanner with a TypeScript AST walk |
| `53ed964` | `72de102` | refuse a raw `.trim().length` truthiness test |
| `74133fb` | `2fa379d` | docs: review round 1 evidence |
| `3eb475c` | `e4f7643` | docs: guard Phase 2 log |

Why cherry-pick and not `git rebase --onto`: the branch is checked out in the old
lane's worktree, and `--onto` replays through a checked-out ref. The four-commit
range is the same set `--onto origin/develop ad8445f` replays; a plain
`git rebase origin/develop` would replay #246's own commits and conflict on every
file they touched (a squash merge leaves no shared SHA).

## Conflicts, per file

- **`apps/web/src/tests/blankness-gates.ts` — the AST walk wins** (`--theirs`).
  Develop held #246's regex scanner; this PR replaces it wholesale. #246's
  round-5 source fix lived in `breaksStatement` (skip an unmatched `)`/`]` at
  bracket depth 0 inside `${...}`, so JSX child text is not read as code). That
  code is gone with the regex scanner and nothing is lost: the AST parses
  `${...}` as a TemplateSpan and the JSX child as JSX, so the round-5 shape is
  detected natively.
- **`apps/web/src/lib/blankness-ratchet.test.ts` — auto-merged, no conflict.** The
  result is a union: the branch's AST fixtures plus develop's round-5 fixture
  (`reads JSX child text inside a template expression as text, not code`), which
  passes against the AST walk and is kept (a stricter pin, not a loss).
- **No `.scratch/**` path conflicted.** Only new `249` files were added; 0 of
  develop's `244` files appear in the diff. No conflict fell outside the two
  groups the brief named.

## Verification (all at `6b3f0ee`)

| command | result | exit |
|---|---|---|
| `bash .scratch/reviews/244/gate-set-diff.sh b517553` | `ADDED []` / `REMOVED []`, 32 gates | 0 |
| `bash .scratch/reviews/244/390da2d-mutation-proof.sh b517553^` | 11/11 file reverts redden the ratchet | 0 |
| `bash .scratch/reviews/249/ratchet-first-red.sh b517553` | baseline green; 43 pass / 13 fail against the regex scanner | 0 |
| `bash .scratch/reviews/249/ast-branch-pin-proof.sh` | 16/16 branches redden; scanner restored byte-identical | 0 |
| `bun run typecheck` | 4/4 packages | 0 |
| `bun run lint` | oxlint clean | 0 |
| `bun run test` | api 936/0, web 1275/0, scripts 74/0 | 0 |
| `bun test src/lib/blankness-ratchet.test.ts` | 56 pass / 0 fail | 0 |

**Gate-set claim:** develop `b517553` (regex scanner) and this tree (AST walk)
produce the same 32 gate signatures, `ADDED []` / `REMOVED []`. The rebase did not
change what the ratchet means.

**Ratchet count:** 52 pass / 0 fail at the pre-rebase branch tip, 56 pass / 0 fail
here. The +4 is develop's round-5 fixture (+1) and three review-fix fixtures
(+3); no pin was lost and no #244 fixture changed verdict.

## Review findings closed in `6b3f0ee`

1. `blankness-gates.ts` — a comment inside a receiver (`draft./* gap */amount`)
   changed the gate's identity. Canonical text now comes from a `removeComments`
   printer, so comment trivia is dropped and literal text is preserved.
2. `blankness-gates.ts` — `const t = draft?.trim() ?? ""` was a silently lost
   gate (the regex scanner reported it, the AST walk returned `[]`). The `??`
   fallback binding is now a gate source.
3. `blankness-gates.ts` — a bound raw trim in a truthiness position
   (`const t = draft.trim(); if (t)`) escaped the fail-closed contract. Bound-name
   reads now go through `refuseIfTestPosition`, like `t.length` already did.
4. `.scratch/reviews/249/ratchet-first-red.sh` — a setup error (bad ref, empty
   scanner, missing dependency) exited non-zero and read as failing-first proof.
   The script now verifies the ref and the non-empty read, requires a green
   baseline, and requires passing tests plus a `(fail)` assertion failure.

## Force-push (parent only — this lane did not push)

Run from the `fix-251-rebase` worktree:

```
git push --force-with-lease=refs/heads/issue-249-ast-walk:3eb475cf14693aa2fa49259e08d00a738aa80039 origin fix-251-rebase:refs/heads/issue-249-ast-walk
```
