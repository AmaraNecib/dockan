# #244 round 2 — code review (standards + spec) at `c143fa8`

Two read-only code-review children per round (five rounds), run by this lane.
Independently run, not "in-lane": standards and spec were separate children.

## Spec — the brief is the specification

| requirement | met? | closing line | failing-first evidence |
| --- | --- | --- | --- |
| F1 line layout hides checks | yes | whole-source `matchAll` in `findBlanknessGates`; inline matchers claim their spans and `if (inline) continue` is gone | `c143fa8-ratchet-first-red.log` §1: split comparison `[]`; inline+two-step line missing the two-step gate; split declaration `[]` |
| F2 an inner variable hides an outer check | yes | `visibleDeclaration`: `declaration.enclosing.every((pair) => comparisonScope.some((scope) => scope.open === pair.open))` | §1: inner normalised declaration masking an outer raw gate returned `[]` |
| F3 the mutation proof discards local edits | yes | `390da2d-mutation-proof.sh`: dirty-file refusal, `mktemp -d` backup, `EXIT`-trap `cp -p` restore, checked `git apply -R`; no `git stash` | `-guard-demo.log`: CASE A the unfixed tool destroys the edit, CASE B the fixed tool refuses and the edit is byte-identical, CASE C restores byte-identical after reddening on every revert |
| F4 the two-step matchers have no self-tests | yes | `USE_FWD`/`USE_LEN_FWD`/`USE_REV`/`USE_LEN_REV`, the reversed canonical keeping operand order | §1: the reversed fixture failed on the round-1 scanner because the signature collapsed onto the forward branch; `-branch-pin-proof.log` now deletes each branch |
| every fix needs a failing-first demonstration | yes | — | 18 red fixtures across five sections, each against the pre-fix scanner |
| state plainly which of the four the matcher cannot handle | yes | design doc §Deliberate ceiling: "None of the four findings is in this ceiling; each of the four is fixed and pinned by a test that fails without the fix." | — |
| the ceiling is stated, not implied | yes | design doc ceiling list with a reason per deliberate omission; the module docstring carries the same boundary | `c143fa8-scanner-shapes.log` (33 observed shapes) makes it inspectable |
| added scope must not change the classification set | yes | — | `-gate-set-diff.log` (32 gates, `ADDED []`, `REMOVED []` at five SHAs) plus 0 changed `CLASSIFIED` lines in `git diff 5fbe0f0..c143fa8` |
| authority: commit only, no push/PR/merge, no wisdom write | yes | five commits, no `.agents/wisdom/` in the delta | — |

Added scope beyond the four findings — twelve closes (reversed `.length`, the
substring-named receiver, both property-read directions, the formatter-broken
chain, the bracketed right-hand side, the two-step `.length` gate, `?.length`, the
reversed parenthesised gate, the type-annotated declaration, `?.`/`?.[`/`#`
receivers, and the branch-pin proof) — is the same defect class in each case, is
justified in the design doc, and provably did not move the classification set.

## Standards

Verified against `docs/engineering-workflow.md`, `AGENTS.md` and the wisdom
lessons:

- **Evidence carries the reviewed SHA.** Every artifact this round is named
  `c143fa8-*`; the earlier rounds' `ad884d1-*`/`f30581c-*`/`f827d28-*`/`ba5a0b0-*`
  logs were the working state of those rounds and were removed before the evidence
  commit, so `.scratch/reviews/244/` carries round 1 at `390da2d-*` and round 2 at
  `c143fa8-*` only.
- **An unstated gate is an unrun gate.** Both guard phases are logged with the
  exact commands and exit codes (`-guard-phase1.log`, `-guard-phase2.log`). No e2e
  run is claimed: the delta changes no UI.
- **Wisdom applied, not written.** The git-stash lesson
  (`2026-10-14-git-stash-pathspec-pops-unrelated-stash.md`) is applied in every
  proof script (dirty refusal, `mktemp` backup, no `git stash`). The
  docstring-over-claim lesson (`2026-10-15-extraction-ordering-guard.md`) is
  applied to the ratchet docstring and test names, which now say DETECTED and name
  their own limits. The inherited-mutation lesson
  (`2026-10-15-test-helper-vacuous-guard-and-inherited-mutation-claims.md`) is why
  every mutation was re-run at this HEAD rather than inherited.
- **Docstring honesty.** `blankness-gates.ts` scopes its claim and names the
  boundary, in the same shape as `amount-parse.ts`'s `draftBlank`.
- **Shell hygiene.** No unguarded destructive command: every proof script refuses
  a dirty target, backs it up to `mktemp`, restores on `EXIT`, and uses `mktemp`
  rather than a shared `/tmp` path.
- **Standards notes not acted on (taste).** `sed -i` without a backup suffix and
  `sha256sum` are GNU-only (this runs on Windows/Git-Bash and both scripts verify
  a byte-exact restore, so a mismatch would be loud); the `!` captures and `?? ""`
  idioms are mixed across the scanner; `USE_` as a prefix for the two-step
  matchers is less readable than `TWO_STEP_` would be. None of these is a named
  standard.

## Residual risk for the parent

- The regex-literal lexing hole is a stated deferred follow-up; it fails in the
  unsafe direction (can hide a later gate). It deserves its own ticket rather than
  a half-lexer here.
- A deliberately pruned `raw` verdict is undetectable by design (documented).
