# #231 code-review — HEAD `4b593e8955be5d7cd4e2ca68e6197f42fba63bfd`

**Tier:** Standard (CI / workflow / test / docs). **Diff reviewed:** `git diff origin/develop...HEAD`
(base `1ea76b5`); the #231 delta is `b12a618..HEAD`.
**Reviewers:** two independent `reviewer` sub-agents (Standards and Spec axes), fresh context, run
against the SHA above. Per `docs/engineering-workflow.md`, the axes are reported separately.

## Standards

No hard violations of `AGENTS.md`, `docs/engineering-workflow.md`, `docs/ci.md`, `CONTEXT.md` or
`oxlint.config.ts`. The workflow guards are pinned to the real workflow (the rust ERE is read out of
the step, the decide step is executed, `Bun.YAML.parse` parses the whole file), and every `docs/ci.md`
claim was spot-checked against `ci.yml` / `package.json`.

Process notes (not code defects):

- **`AGENTS.md` §Merging / CI change.** Anything under `.github/` goes to the owner for the diff
  before it merges, whatever the review says. Satisfied only by owner sign-off.
- **226 evidence is historical.** `.scratch/reviews/226/1a9d2f40…-*.md` pins `1a9d2f4`; later commits
  changed reviewable files. The #231 brief requires keeping the 226 round, so it is retained as
  history and this #231 round (same HEAD) is the current-tree evidence.

Baseline smells, all judgement calls, none blocking:

- **Repeated Switches** (`ci.yml`): the event type is switched in `Compute the changed-file list`
  (`case`) and again in `Decide the scope` (`if/elif`). Two tables to keep in step; the second fails
  closed to the selector. Left as-is (small, and merging them would move diff logic into the
  decision step).
- **Duplicated Code (minor):** the `$comment` filter is expressed in `e2e-selection.ts` and again
  inline in the test. Intentional layering at a checked-in-artifact boundary.
- **Primitive Obsession (minor):** `mode`/`specs`/`reason` cross the shell boundary as three `k=v`
  lines. The TS side already models `Scope` as a typed union; the text is the job contract.

## Spec

Each of the brief's six findings is fixed, with the required regression/proof:

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | Missing affected checks | Fixed — invoice rule + `returns.spec.ts`, purchase rule + `learnability.spec.ts`, `vault-gate.tsx` → `always_full` (the brief's second allowed option, marked as a cost decision in `docs/ci.md`); regression case each |
| 2 | Renames skip Rust | Fixed — `git diff --no-renames`; both directions explained; behavioural temp-repo test incl. the pre-fix counter-case |
| 3 | `e2e:full` starts no run | Fixed — `types: [opened, synchronize, reopened, labeled]`; trigger pinned by a test and the decide step executed to `full` for a labeled event |
| 4 | No skip explanation | Fixed — summary moved to the always-running `changes` job (`if: always()`), guarded |
| 5 | Wrong required-check guidance | Fixed — shim claim removed in both places; corrected to the job-level-skip rule |
| 6 | Guard can disable itself | Fixed — wiring assertion moved to `ci-workflow.test.ts` (reached by `turbo test`), independent of `bun test ./scripts/` |
| — | Drift (#209 specs) | Fixed — `phone-identity.spec.ts` and `rpc-helpers.spec.ts` mapped to the parties rule; the drift guard is green |
| — | Tier recorded | Yes, `.scratch/implementation/231-design.md` line 3, with justification |

No scope creep beyond the six findings; the only extra edits are the `#226` wisdom correction (the
same false claim) and the design doc the brief asked for.

Residual notes (accepted): the evidence files named above are produced by this same round; the
finding-6 relocation does not assert `ci-workflow.test.ts` is still reached by `turbo test` (deleting
the desktop package's test task would stop it — inherent recursion).

## Commands at the reviewed SHA

| Command | Exit |
| --- | --- |
| `bun run typecheck` | 0 |
| `bun run lint` | 0 |
| `bun run test` | 0 |
| `bun run skills:check` (pre-commit hook) | 0 |
| `DOKAN_PORT=5617 DOKAN_WEB_PORT=6473 bun run test:e2e tests/e2e/learnability.spec.ts` | 0 (7 passed, 55s) |
| selector CLI sweep (docs/one/two/critical/README/unmapped/desktop/.github/empty/spec-edit) | expected modes |
| rename temp-repo probe (out of the crate) | `rust=true` with `--no-renames`, hidden without |
