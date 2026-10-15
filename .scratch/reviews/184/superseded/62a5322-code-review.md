# Code-review evidence — #184 review-fix round 4 (PR #190)

- PR base: `origin/develop`; round-3 final head `d9aad47`; round-4 review head
  `9705b23`; review-driven fixes `1329f69` and `732ce7c` (final code); latest
  commit `62a5322` (this evidence's header SHA).
- Tier: **High-assurance**. Two-axis review (Standards + Spec) at `9705b23`.

## Standards

Standards sources: `AGENTS.md` (search-scope rule only), `docs/development-workflow.md`
(Definition of Done), `docs/engineering-workflow.md` (gates). No
`CONTRIBUTING.md`/`CODING_STANDARDS.md`. `oxlint` + `tsc` cover the enforced
rules; the items below are baseline judgement calls.

- **Duplicated Code (fixed at `1329f69`)** — `modifiedClickOn` repeated the
  querySelector + null-throw + `act` scaffold of `clickOn`. Both now call
  `clickTarget()`.
- **Duplicated test setup (fixed at `1329f69`)** — the open-confirm + held-refusal
  scaffold was triplicated across the round-3 Escape test and both round-4 tests.
  Extracted to `openConfirmWithRefusedSaveHeld()` / `releaseHeldRecovery()`.
- **Speculative Generality, prose (fixed at `1329f69`)** — the predicate docstring
  claimed the rule was applied to "every dismissal route … so the rule cannot
  drift" while there is one call site. Reworded.
- **Over-narrow type (fixed at `1329f69`)** — `ReactMouseEvent<HTMLAnchorElement>`
  on a predicate that ignores the element; narrowed to `ReactMouseEvent`. The
  target term added at `732ce7c` reads `currentTarget.getAttribute("target")`, an
  `Element` method, so the generic-free type remains honest.
- **Fine as-is** — module-level placement (pure, no component state, matches the
  `asDirection` precedent); the `<Link>` re-wrap into the file's multi-line JSX
  style; the class fix is a single predicate rather than a second dismissal
  primitive; review-round provenance in comments matches the file's existing
  convention.
- No documented-standard violations, no blockers.

## Spec

Spec source: the round-4 brief
(`D:/projects/mani-project/.scratch/sessions/crew/briefs/feat-184-greptile-round4.md`,
outside the worktree — the review agents reviewed the requirement text instead).

| Brief requirement | Status |
|---|---|
| Only abandon for clicks that navigate the current tab (ignore `metaKey`/`ctrlKey`/`shiftKey`/`altKey` and `button !== 0`) | ✅ `navigatesCurrentTab` (`supplier-opening-balance.tsx:39-51`) requires an unmodified primary click whose anchor target is absent/empty/`_self`, guarding the back `<Link>`'s `abandonAttempt`. |
| If the same modified-click hole exists on another dismissal trigger, fix the CLASS rather than this handler | ✅ Walked all triggers (page Cancel, dialog Cancel, Escape, resolveKey-change effect, unmount cleanup, done button); none is a navigation gesture, so the back link is the only site. The rule lives in one predicate. |
| A test that fails without the fix (hold refusal lookup, Ctrl/Cmd-click back link, release, assert dialog STILL THERE) | ✅ Present; fails on `c25b66a`. |
| A plain-click control so it cannot pass by never abandoning | ✅ Present (`{ button: 0 }`), asserts the dialog is gone. |
| Walk the other dismissal triggers and report which were checked | ✅ Table in `732ce7c-test-audit.md` and the round-4 commit bodies. |
| Extra coverage found by review: all four modifier terms + non-primary button | ✅ Added at `1329f69` (parameterised, mutant-checked). |
| Debate: guard must not be a weaker copy of the router's own | ✅ `target` term added at `732ce7c`, pinned by a red-first test. |

Scope creep: none — the delta is the predicate, one guard, tests, and comments.
Implemented-but-wrong: none found; no blockers.

## Debate

See `732ce7c-debate.md`. One in-scope major (the missing `target` term) was fixed
at `732ce7c`; the remaining critic findings were accepted-by-brief or dismissed
with reasons.
