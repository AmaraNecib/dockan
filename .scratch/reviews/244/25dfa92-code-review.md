# #244 round 5 — code review (Standards + Spec), HEAD 25dfa92

Base: `ad8445f`. Spec: `.scratch/sessions/crew/briefs/fix-244-round5.md`.
Standards: `docs/engineering-workflow.md`. Run as an independent read-only
sub-agent.

## Spec verdict: PASS

Both live findings fixed; findings 3–13 untouched; scope matches the brief.

- **Finding 1 — fixed, minimal.** `apps/web/src/tests/blankness-gates.ts:201-205`
  changes one line in the `CLOSERS` branch: `else return true;` →
  `else if (frames.length === 1) return true;`. An unmatched `)`/`]` at bracket
  depth 0 inside a `${...}` frame is skipped as JSX text; outside a template the
  behaviour is unchanged, so the round-2..4 matchers cannot move.
- **Fixture present.** `apps/web/src/lib/blankness-ratchet.test.ts:653-680`
  asserts the `)` and `]` cases and pins the pre-existing `}` result; signatures
  match the probe output.
- **Shape went caught → escaping → caught.** `round4-before-probe.ts`:
  round-3 `caught`, round-4 `[] (ESCAPES)`, HEAD `caught` for both shapes.
- **Finding 2 — the probe cannot destroy an edit.** `round4-before-probe.ts`
  extracts pre-fix scanners with `git show <sha>:…` into `mkdtempSync` and only
  reads the target; `git checkout --` is gone. `probe-safety-demo.sh` CASE A shows
  the old overwrite+`checkout --` destroys the edit; CASE B runs the probe against
  a copy (`ROUND4_PROBE_TARGET`) and the edit stays byte-identical, with a sha256
  assertion that the real scanner is untouched.
- **Findings 3–13 not reworked.** Diff touches only the `)`/`]` branch and the
  comments around it. `gate-set-diff` still `ADDED []` / `REMOVED []` (32 = 32).
- **Scope.** Only the scanner, the fixture, the one probe script and its demo.

## Standards verdict: PASS

- Comments explain WHY, including the direction of risk (over-report is safe; a
  `/*` in JSX text is an unsafe HIDE).
- No dead code; the net scanner change is one line plus comments — no hand-rolled
  lexer growth, which is the brief's explicit constraint while #249 lands.
- Evidence naming follows `<sha>-<gate>.log`; commits are focused (fix, then
  self-review).
- Source-only policy: the diff contains no build artifacts.

## Findings

- **Medium (process, since addressed):** the round-5 evidence logs were untracked
  while every earlier round's evidence is committed. They are committed in the
  evidence commit that follows this file; the parent must not push without it.
- **Low:** reviewer scratch files were left untracked in the worktree; deleted
  before the evidence commit.
- No blockers.

## Commands

```
git diff --stat ad8445f...HEAD        # 4 files
git log --oneline ad8445f..HEAD       # 2 commits
cd apps/web && bun test src/lib/blankness-ratchet.test.ts   # 33 pass, 0 fail
bun run .scratch/reviews/244/round4-before-probe.ts
bash .scratch/reviews/244/probe-safety-demo.sh
```

## Residual risks

- The fix's safety rests on the argument that an unmatched `)`/`]` at brace-depth
  0 inside `${...}` can only be JSX text. #249's AST walk supersedes the whole
  scanner.
- A `}` or a comment opener in JSX child text is still read as code; named in the
  KNOWN CEILING, not fixed here.
