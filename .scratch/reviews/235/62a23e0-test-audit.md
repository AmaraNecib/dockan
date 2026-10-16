# #235 test-audit — edge cases + coverage + quality

Reviewed: `git diff c3f8544...62a23e0` at HEAD `62a23e0256b88f9321a70050fd57cdd7978aebce`.
Base: `c3f8544` (merge-base with `origin/develop`). Tier: **Standard**.
Scope: 6 markdown files, no code and no tests changed (`git diff --stat` = 6 files, +123/−48).
Issue: GitHub #235.

This change has no runtime and no test files, so the audit is over the enforcement surface
instead: the changed wording, the unchanged rest of each file, and the tools a lane actually has.

Reviewers: **round 1** ran all three lenses as separate independent sub-agents (edge case hunter,
coverage analyst, quality reviewer); **rounds 2 and 3** re-ran the three lenses as one independent
sub-agent each, plus two code-review axes (see
`.scratch/reviews/235/62a23e0-code-review.md`). No reviewer wrote a file.

---

## Round 1 findings (disposition)

| # | Lens | Finding | Rating | Disposition |
|---|------|---------|--------|-------------|
| F1 | edge | The candidate-lesson channel named a `crew_report.lesson` field that the running harness may not expose (`additionalProperties: false`), so the rule was unactionable | 🔴 | **Fixed** — the fallback "(a harness without that field carries it in the report summary)" now sits in `AGENTS.md:18`, `feature-implement:19-21`, `docs/engineering-workflow.md:121`; §12 no longer names the field |
| F2 | edge | `feature-implement` `## Merge rules` left a lane a reachable merge path: actor "the agent", `gh pr merge` unfenced | 🟠 | **Fixed** — `feature-implement:206-218`: "Parent-only — a lane never merges at all" + `**Parent-only command:**` |
| F3 | quality | `feature-implement` frontmatter still listed capture-wisdom as a lane delegate | 🟠 | **Fixed** — `:3` "the parent session runs capture-wisdom" |
| F4 | quality | "Where to start" routed a lane into parent steps 12-13 | 🟠 | **Fixed** — `feature-implement:239` "Parent only — Steps 12-13" |
| F5 | edge | The boundary had no mechanical enforcement in the gates | 🟠 | **Fixed** — `guard:52` (Phase 2) and `guard:97` (Phase 3) |
| F6 | edge | "Close the workspace the moment it reports" stranded the worktree the parent still needs | 🟠 | **Fixed** — `AGENTS.md:44` "the moment the parent has pushed its branch" |
| F7 | quality | capture-wisdom's "parent-session only" contradicted its own "every lane reads" line | 🟠 | **Fixed** — description and header scoped to writing; read branch in the description |
| F8 | edge | `guard` wisdom checkbox had no actor | 🟡 | **Fixed** — `guard:98` "(Parent)" |
| F9 | quality | The measured reason was duplicated and the numbers unverified | 🟡 | **Fixed** — numbers re-derived (below); detail kept in `AGENTS.md`, referenced from `capture-wisdom` |
| F10 | edge | The forbidden-command list was not exhaustive (`gh pr edit`/`review`, force push) | 🟡 | **Reported as residual**, not fixed: the brief names exactly push / `gh pr create` / merge, and "the parent owns the review request" already covers a lane nudging review. Recorded for the parent |

## Round 2 findings (disposition)

N1 (🟠, one routing row still unlabelled) and N2-N7 (🟡 actorless Greptile bullets, weak
`AGENTS.md` Merging wording, incomplete step cross-reference, unlabelled workflow merge command,
lesson-field phrasing, `debate` "before push") were **all fixed** in `62a23e0`.

## Round 3 (closing) result

**N1-N7 all resolved. No 🔴 or 🟠 carried forward.** Six 🟡 residuals for the parent are listed at
the end of the code-review evidence.

## Verification of the audit's own claims

```
$ git log --oneline --no-merges origin/develop -- .agents/wisdom | wc -l   # 45
$ git log --oneline origin/develop -- .agents/wisdom | wc -l               # 46 (45 + 1 merge)
$ (per-file count > 1)                                                     # six files, one with 3
$ bun run skills:check   -> 0  (32 skills in .claude/skills == .agents/skills)
```

The four edited skills (`capture-wisdom`, `debate`, `feature-implement`, `guard`) are **not keys in
`skills-lock.json`** and have no `.claude/skills` directory, so the brief's "both copies must be
committed" is satisfied vacuously: `skills:sync` is a no-op for this diff. Verified statically by two
reviewers and by `bun run skills:check` exit 0.

## Residual risk (not defects)

- F10 above (the forbidden list is the brief's exact set).
- The `crew_report` `lesson` field is named in the docs per the owner's instruction; this session's
  tool schema does not list it, so the fallback clause is load-bearing. See the report's
  `decisionRequest`.
- The trust-measurement for the wisdom rule is asserted, not enforced by a gate (honour system by
  design).
