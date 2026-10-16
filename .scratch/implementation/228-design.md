# #228: the review tier as a recorded decision, and the test-audit tier contradiction

Status: implementation design. Base: `origin/develop` @ a52084d.
Tier: **Standard**. Justification: docs and two skill files only. No code path,
store, money, auth or backup is touched, so none of the named High-assurance
failure modes can be violated.

## Goal

Make `docs/engineering-workflow.md` the single source of truth for the review
tier, and remove the contradiction that lets a Standard-tier lane skip
`test-audit`.

Two defects:

1. Three files disagree on when `test-audit` runs. `test-audit/SKILL.md` says
   "High-assurance tier only"; `docs/engineering-workflow.md` and
   `feature-implement/SKILL.md` § 7 say Standard and High-assurance. Fix in the
   direction two of three already take.
2. Nothing says how to choose a tier, so it drifts upward. Write the rule down:
   the tier follows the **failure mode**, never the diff size.

## Interfaces (what changes for a caller)

- `docs/engineering-workflow.md` "Review tiers": the middle column becomes the
  decision. High-assurance is defined by five named failure modes. Path examples
  are labelled hints, not a test. The section states that a lane records its
  tier and a one-line justification in its design doc.
- `.agents/skills/test-audit/SKILL.md`: the description and "When to run" say
  Standard and High-assurance, and point at `docs/engineering-workflow.md`
  instead of restating the tier rule.
- `.agents/skills/feature-implement/SKILL.md` § 1: the High-assurance row points
  at the canonical failure modes, and § 1 requires recording the tier and
  justification in the design doc. § 7 already says Standard and High-assurance,
  so its wording stays.

## Dependencies

None. No code, no new package, no `.github/` change, and no sub-agent count
change (7 = `debate` 2 + `test-audit` 3 + `code-review` 2 stays).

## Planned tests

A docs and skill change has no unit or Playwright test that can assert prose.
The gates are:

- `bun run typecheck`, `bun run lint`, `bun run test`: prove the repo is
  unaffected.
- `bun run skills:check`: proves `.claude/skills` is not drifting from
  `.agents/skills`. `test-audit` and `feature-implement` are not in
  `skills-lock.json`, so they are not mirrored, and the check must still pass.
- A grep of all three files for the tier wording, before and after, is the
  evidence that the contradiction is gone.

## Implementation risks

- **Dropping the `schema-version bump` and `security` triggers.** They were
  triggers in the old table but they are not one of the five failure modes. Kept
  as hints that point at a failure mode, so the bar does not silently loosen.
- **A path rule sneaking back in.** The brief forbids a blanket "`store/**` is
  High-assurance" rule; the section says so explicitly.
- **Scope creep.** `guard/SKILL.md` also restates the High-assurance list. It is
  a fourth restatement, and it is not one of the three files in scope. Left
  unchanged, reported as residual drift risk plus a proposed follow-up.
- **Mirror drift.** Editing only `.agents/skills` would fail `skills:check` if
  the skill were locked. Running `skills:sync` then `skills:check` covers it.
