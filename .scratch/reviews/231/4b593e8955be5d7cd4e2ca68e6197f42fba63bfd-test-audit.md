# #231 test-audit — HEAD `4b593e8955be5d7cd4e2ca68e6197f42fba63bfd`

**Tier:** Standard. **Delta base:** `b12a618` (the #226 evidence commit).
**Reviewer:** independent `reviewer` sub-agent, fresh context, run against the SHA above.
**Result:** **A** — every fix has a guard that fails when it is reverted.

## Round 1 (at `cf40f03`) found two gaps; both are fixed in the reviewed SHA

1. **Finding 4 (skip explanation) had no guard test.** Moving the summary step
   back into the `e2e` job, or dropping its `if: always()`, changed no test.
   Fixed by `publishes the skip explanation from the always-running changes job`,
   which pins the step's home (`changes`, so a revert throws in `stepNamed`),
   its `always()` condition, its absence from `e2e`, and the text it writes.
2. **The `reaches full for a labeled pull_request event` test was vacuous for
   finding 3 on its own** — the decide step's label branch pre-existed. The
   trigger is pinned by `subscribes to \`labeled\` …`; the test comment now says
   the two are the proof together, and the audit confirms each fails when its
   own half is reverted.

## Mutation checks the reviewer ran (isolated copy; repo untouched)

| Mutation | Guard that fails |
| --- | --- |
| remove `labeled` from `types:` | `subscribes to \`labeled\` …` |
| remove the decide step's label branch | `reaches \`full\` for a labeled …` |
| drop `if: always()` on the summary step | `publishes the skip explanation …` |
| move the summary step back into `e2e` | `publishes the skip explanation …` (`stepNamed` throws) |
| remove `returns.spec.ts` from the invoice rule | `an invoice page edit runs the new-return form's spec` |
| remove `learnability.spec.ts` from the purchase rule | `a purchase page edit runs the short-window learnability checks` |
| remove `vault-gate.tsx` from `always_full` | `the vault gate is critical …` |
| drop `--no-renames` | `collects both sides of a rename …` |

## Coverage

- Findings 1, 2, 3, 4 and 6 each have a guard that fails on revert. Finding 5 is
  prose in `docs/ci.md`; the reviewer confirmed it is not testable in-repo (it
  rests on GitHub's documented branch-protection behaviour, verified separately
  against `github/docs`).
- The rename test is a real temp git repo: it moves a crate file out and back and
  asserts the pre-fix `git diff --name-only` output hides the gated side (rename
  detection forced on).
- The map regressions are non-duplicate: the orphan guard alone would not catch
  the invoice→`returns.spec.ts` widening (`returns.spec.ts` was already
  reachable), so the added tests are load-bearing.
- Drift: `phone-identity.spec.ts` and `rpc-helpers.spec.ts` (#209) are now
  reachable from the parties rule; the "every spec on disk is reachable" guard
  passes.

## Residual (accepted, none blocking)

- `${E2E_MODE:-unknown}` "decision failed" fallback is untested (CI always sets
  the env).
- The relocated wiring guard still cannot protect its own runner: deleting
  `apps/desktop`'s `test` script would stop `ci-workflow.test.ts`. Inherent
  recursion; a comment records the limit.
- The `types:` assertion pins an exact line (deliberate for a pin).

## Commands at the reviewed SHA

| Command | Exit |
| --- | --- |
| `bun run typecheck` | 0 |
| `bun run lint` | 0 |
| `bun run test` (`turbo test` + `bun test ./scripts/`) | 0 |
| `bun test apps/desktop/scripts/ci-workflow.test.ts` | 25 pass / 0 fail |
| `bun test ./scripts/e2e-selection.test.ts` | 30 pass / 0 fail |
