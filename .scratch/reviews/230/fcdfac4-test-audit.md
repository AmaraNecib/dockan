# #230 test-audit

Reviewed: `git diff 9d49320...HEAD` at HEAD `fcdfac4a0b582e3b2fb233f5c22e5065846fac25`.
Fixed point: `9d49320` (head of `docs-tier-discipline`, the PR #230 head). Tier: Standard.

The delta under test-audit is documentation only: one example reworded in
`docs/engineering-workflow.md:80-83` plus a design doc and the code-review evidence. No production
code, no test files, no fixtures. There is no testable surface to audit in the delta, so this round
records that fact and the manual pin that stands in for the missing automated guard.

**Adequacy:** the reworded example is pinned by a reproducible grep, not by a test. That is the same
gap the 228 round recorded; the durable fix is follow-up #1 (`scripts/skill-tier-consistency.test.ts`),
which the brief keeps deferred.

**Correct**
- The contradiction is gone in the file the finding cites. `docs/engineering-workflow.md:81-83` now
  gates each example on a named failure, matching the failure-mode rule at line 89 and the
  "paths are never a test" paragraph at lines 92-97.
- `bun run typecheck`, `bun run lint`, `bun run test` all pass (exit 0). They cannot observe prose;
  they prove only that the repo is otherwise untouched.
- `bun run skills:sync` then `bun run skills:check` pass (exit 0, 32 skills, mirror in sync), so the
  generated `.claude/skills` mirror is unaffected by a `docs/` edit.

**Blocker:** none.

**Notes**
- **Orange — no automated assertion.** Zero tests pin the tier wording; a later edit can re-introduce
  the path→tier example and fail nothing. **Disposition: deferred to the parent as follow-up #1**, which
  the brief lists and forbids folding in here.
- **Yellow — manual evidence.** The before/after grep below is the committed, reproducible record.
- **Yellow — residual area shorthand.** `guard/SKILL.md:80` and `debate/SKILL.md:20` name categories
  (auth/RBAC, security), not paths, so they are outside this finding; converting them is follow-up #2,
  also deferred per the brief.

## Before / after — an example that ties a tier to a path alone

Pattern: `(auth/\*\*|store/\*\*).*\bis High-assurance`

Before (`9d49320`):
```
docs/engineering-workflow.md:82  is Standard; a 12-line PR under `apps/api/src/auth/**` is High-assurance.
```
(grep exit 0)

After (`fcdfac4`):
```
(no match; grep exit 1)
```

The surviving `store/**` mention at line 96 is the explicit negation ("is not blanket
High-assurance"), which the pattern excludes.

**Verdict:** no testable surface in the delta; local suite green; the wording pin is manual and the
durable guard is deferred as follow-up #1.
