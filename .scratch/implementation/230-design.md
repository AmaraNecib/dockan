# #230 design — close the Greptile path/tier contradiction

## Tier

**Standard.** Documentation-only change to `docs/engineering-workflow.md`; it cannot
violate any of the five High-assurance failure modes (no stock, money, debt, auth or
backup/restore behaviour is touched). No `debate` run is required.

## Scope

One finding on PR #230, `docs/engineering-workflow.md:80-82`: the opening example
states that a 12-line PR under `apps/api/src/auth/**` **is** High-assurance, while the
paragraph below the table says a matching path "does not by itself make a change
High-assurance". The example therefore implies a path determines the tier — the exact
drift #228 exists to remove.

## Change

Make both opening examples conditional on a named failure, per the Greptile suggestion:

- 600-line PR that adds a screen **without risking a named failure** → Standard
- 12-line PR under `apps/api/src/auth/**` **that can bypass a session check** → High-assurance

No new rule; this is the table's failure-mode rule stated as an example. The five named
failure modes and the recorded-tier requirement are untouched, as the brief requires.

## Sweep

Re-read the whole Review tiers section for the same contradiction. The only path/tier
example is the one at line 82; lines 92-97 already label paths as hints, never tests.
`feature-implement/SKILL.md` and `test-audit/SKILL.md` carry no path→tier example.

## Follow-ups (unchanged, already on the PR)

1. `scripts/skill-tier-consistency.test.ts` — automated wording drift guard.
2. Point `guard/SKILL.md` and `debate/SKILL.md` at the canonical failure-mode list.

## Risks

- Minimal. Wording-only; not cited as a test elsewhere. `skills:sync`/`skills:check`
  prove the generated mirror is unaffected.
