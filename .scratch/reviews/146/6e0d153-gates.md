# #146 guard record

- **Issue:** #146, one invoice-draft module behind the sale and purchase screens
- **Tier:** Standard (web UI)
- **Base SHA:** `fc951133134a9b0b18b5ae38f9658665c29e73ec` (`origin/develop` at the time
  the base was pinned, and still the merge-base with `HEAD`)
- **Code SHA (the tree these gates ran against):** `6e0d153059a8d0197e62a67cdec2ac9a651509d2`
- **Branch HEAD at the time of writing:** `bea98ab12f46b93f3502de9594d922d8b207e9a8`
  (the evidence commit; it adds only `.scratch/reviews/146/*.md`)

## Guard Phase 1 and Phase 2

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `bun run typecheck` | 0 | `Tasks: 3 successful, 3 total` |
| 2 | `bun run lint` | 0 | `oxlint` with no findings |
| 3 | `bun run test` | 0 | `904 pass / 0 fail`, 69 files, 4691 assertions |
| 4 | `bun run test:e2e` | 0 | `55 passed` (4.1m) |
| 5 | `git status` | 0 | clean |

Notes:

- The change touches no Rust (`apps/desktop/src-tauri/`), so the cargo gates do
  not apply.
- The e2e run was made with `DOKAN_PORT=4617 DOKAN_WEB_PORT=5473` because a
  sibling lane (`feat-130-arabic-name-variants`) was running the same suite on
  the shared 4317/5173 pair. See
  `.agents/wisdom/2026-10-15-concurrent-lane-e2e-ports.md`.
- The pre-commit hook (oxlint, then `tsc --noEmit` in `apps/api`) ran on every
  commit and passed.
- The `test` and `test:e2e` runs above were made against the tree that became
  `6e0d153`. The only later change on the branch is the evidence and wisdom
  markdown, which no gate inspects. `typecheck`, `lint` and `test` were re-run
  after the amend and are recorded above with exit codes.

## Guard Phase 2 evidence checks

For each file in `.scratch/reviews/146/`: its name carries `6e0d153`, which was
`HEAD` when the file was written. `git diff --name-only 6e0d153 HEAD` lists only
the three evidence files under `.scratch/reviews/146/`, which the guard treats as
non-reviewable, so the evidence is valid for the branch.

- `6e0d153-debate.md` (critic + defender, two rounds)
- `6e0d153-test-audit.md` (edge cases, coverage, test quality, two rounds)
- `6e0d153-code-review.md` (standards axis + spec axis, two rounds)

## Guard Phase 3

| Check | Status |
|---|---|
| Local checks green | yes (table above) |
| Review evidence current for the tier | yes (Standard requires test-audit and code-review; both exist and match the code SHA, plus the requested debate file) |
| Greptile CLI for the final HEAD with no actionable findings | **not run**: `greptile review --json --branch develop` exits 1 with "this review is too large to send" (the known limitation in `.agents/wisdom/2026-08-24-greptile-cli-large-diff.md`), and the documented hosted path needs a push and a PR, which this lane is forbidden to do |
| CI | the repo has no CI workflow, so the local Guard Phase 2 run is the gate |
| PR description | not applicable, no PR in this lane |
| Deferred items documented | yes, design doc section 8 and the debate evidence |
| Wisdom captured | yes: concurrent lane e2e ports, and extraction must not tighten a money reader |

The Greptile gap is a lane constraint (no push allowed), not a clean result.
It is raised in the handoff so the parent can run the hosted review after landing.
