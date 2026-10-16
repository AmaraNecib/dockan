# #228 test-audit

Reviewed: `git diff a52084d...HEAD` at HEAD `477440f27533d465b7e55a96d11db43723f172cb`.
Base: `a52084d1de0bda7fd3cb25ec5da5c778f04200ae`.
Tier: Standard. Independent auditor sub-agent, run after the contradiction fix.

**Adequacy: the fix itself is correct and verified by reading, but the verification design is not
adequate as a durable guard — the naive grep cannot see the changed files.**

**Correct**
- The contradiction is genuinely gone in the three in-scope files:
  `.agents/skills/test-audit/SKILL.md:3,18` (description and "When to run" now Standard and
  High-assurance, points at the canonical doc), `docs/engineering-workflow.md:43,88`, and
  `.agents/skills/feature-implement/SKILL.md:25,108`. `rg --hidden -i "high-assurance tier only"`
  returns no live file (only `.scratch/` history).
- `bun run skills:check` reports "skills mirror in sync: 32 skills"; it passes and is genuinely
  unaffected because `skills-lock.json` contains neither `test-audit` nor `feature-implement`.

**Blocker**
- **Red — a bare-root grep is vacuous.** `rg` skips dot-directories by default, so a repo-root
  grep never reads the two `.agents/` skill files. **Fixed in this evidence:** the before/after
  grep below passes every file by explicit path, so all three are read.

**Notes**
- **Orange — no automated assertion.** Zero tests pin this wording. A future edit re-introducing
  "High-assurance tier only" fails nothing; the fix regresses silently. **Disposition: deferred
  to the parent as a decision request.** Cheapest guard named by the auditor: one ~15-line test
  in `scripts/` (already run by `bun run test`) asserting with explicit paths that
  `test-audit/SKILL.md` contains "Standard and High-assurance" and not "High-assurance tier only".
  Not added here because the brief scopes the change to docs + two skill files and adding a test
  is a scope change the owner should approve.
- **Orange — fourth restatement survives.** `.agents/skills/guard/SKILL.md:80` still says
  "High-assurance (auth/RBAC, ... a schema-version bump)". That is the gate that enforces tier
  evidence, and a loose repo-wide grep counts it as agreement. **Disposition: out of scope,
  reported with a proposed follow-up.**
- **Yellow — typecheck/lint/test cannot observe prose.** They prove only that the repo is
  untouched.
- **Yellow — manual evidence.** The before/after grep below is the committed, reproducible record.

## Before / after (explicit paths, all three files read)

Before (`a52084d`):
```
.agents/skills/test-audit/SKILL.md:3   … High-assurance tier only.
.agents/skills/test-audit/SKILL.md:18  Only for High-assurance changes.
.agents/skills/feature-implement/SKILL.md:105  ### 7. Test audit — Standard and High-assurance
docs/engineering-workflow.md:43  Test audit — Standard + High-assurance
```

After (`477440f`):
```
.agents/skills/test-audit/SKILL.md:3   … Standard and High-assurance.
.agents/skills/test-audit/SKILL.md:18  Required for **Standard and High-assurance** changes.
.agents/skills/feature-implement/SKILL.md:108  ### 7. Test audit — Standard and High-assurance
docs/engineering-workflow.md:43  Test audit — Standard + High-assurance
```

The three files now agree: `test-audit` is required at Standard and High-assurance. The only
remaining "High-assurance only" occurrences are `debate` (correct: debate is High-assurance only)
and `.scratch/` history.

**Verdict:** the prose fix is correct and the contradiction is gone; the durable guard is
deferred to the owner as a decision request.
