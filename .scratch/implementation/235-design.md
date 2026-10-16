# #235 — authority boundary + wisdom ownership (design)

## Issue

GitHub #235 — "docs(workflow): codify the lane/parent authority boundary, and make
`.agents/wisdom` parent-owned." Brief:
`D:/projects/mani-project/.scratch/sessions/crew/briefs/docs-authority-and-wisdom.md`.

## Review tier

**Standard.** Justification: the diff is markdown under `AGENTS.md`, `docs/` and
`.agents/skills/**` — all reviewable files per `docs/engineering-workflow.md`
(Review tiers), and no path in the diff can violate one of the five
High-assurance failure modes (stock, money totals, debt direction, auth/RBAC,
backup/restore). No runtime code is touched.

## Base

- Target branch: `develop`
- Base SHA (`git merge-base origin/develop HEAD`): `c3f854450f8492fb534ea3dfa8859c0b5c8353d6`
- HEAD at design time: `c3f8544` (branch `docs-authority-and-wisdom`, created from `origin/develop`)

## What already exists at base (important)

`chore(skills,docs): … bring the workflow docs up to date (#199)` (4bf10be, in
`develop`) already landed the **parent-owned lifecycle split**:

- `docs/engineering-workflow.md` has `── parent-owned from here ──` and the
  "A worker lane stops at Guard Phase 2 and reports (`crew_report`)" paragraph.
- `feature-implement` §10 carries a `**Parent-owned.**` note and §11 is headed
  `**Parent-owned.**`.

So the remaining work is the parts #199 did not do: a stated **Authority** section
in `AGENTS.md`, retitling §10 and fencing its commands, removing the lane wisdom
step from §12, the wisdom rule + its measured reason, the staleness side effect,
and restricting `capture-wisdom` to the parent. The brief was written as if #199's
half did not exist; the report records that.

## Changes

1. **`AGENTS.md`** — new `## Authority` section at the top: lanes commit +
   `crew_report` only; parent owns push/PR/Greptile/merge-on-owner-word;
   `.agents/wisdom/` is **read-only for lanes** and parent-owned for generation,
   with the measured reason in one sentence; lanes report the lessons they applied
   and carry a candidate lesson in `crew_report`'s `lesson` field.
   Also reword the `## Lanes` line that says a workspace closes "the moment its
   work is pushed" → "the moment the parent has pushed its branch", so the timing
   stays after the push (the worktree is still needed for Guard Phase 3 and any
   rebase) while the push itself is attributed to the parent.
2. **`docs/engineering-workflow.md`** — lifecycle diagram: add the wisdom-read
   node before the ticket, the `crew_report` node, `Push + open PR`, `Capture
   wisdom (repeated pattern only)` and `Merge — only on the owner's explicit
   word`; replace "Durable lessons go to `.agents/wisdom/`" with the parent-owned
   generation / lane consumption rule, the repeated-pattern criterion and the
   one-line review-evidence side effect; add the parent attribution to the merge
   rules. Existing merge text otherwise untouched.
3. **`.agents/skills/feature-implement/SKILL.md`** — intro states the lane stops
   at step 9 and that wisdom is read-only for a lane (read it before step 1,
   report the lessons applied, carry a candidate in the `lesson` field); §10
   retitled "Report to the parent — the parent owns push and PR"
   with the `git push`/`gh pr create` block under a parent-only note; §11 states
   why a lane cannot trigger CI/Greptile; §12 loses the lane capture-wisdom step;
   the "Where to start" row for step 10 is marked parent-only.
4. **`.agents/skills/capture-wisdom/SKILL.md`** — parent-session-only, with the
   repeated-pattern criterion, in both the body and the frontmatter description,
   plus the lane-consumption sentence.
5. **Consistency fixes outside the brief's four files** (reported as such):
   `guard` Phase 3 and `debate` still instruct *lanes* to write wisdom, which would
   re-teach the old behaviour. Both get an attribution edit only.

## Scope addition (owner, mid-lane)

The owner added the consumption half of the wisdom rule after the first pass: a
lane does not write `.agents/wisdom/`, instead its `crew_report` may carry a
candidate lesson (the `lesson` field the owner names), and it must say which
lessons it applied. Generation stays with the parent; consumption is every
lane's job. Written into all three rulebook files as one paragraph each, no
restructure.

Note for the parent: this session's `crew_report` tool schema has no `lesson`
field (`additionalProperties: false`, fields: status, summary, files, commands,
risks, next, decisionRequest, proposedFollowup, deferredWork, dependencies,
reviewStatus, reviewConfidence, reviewComments, reviewRunId). The rulebook now
documents the field as the owner described it, with a fallback clause ("a harness
without that field carries it in the report summary") in `AGENTS.md`,
`feature-implement` and `docs/engineering-workflow.md`. The report flags the schema
gap so the parent does not think a lane silently ignored it.

## Review outcome

Three review rounds, all as independent sub-agents; full findings in
`.scratch/reviews/235/`.

- Round 1 (3 test-audit lenses + 2 code-review axes): F1-F10.
- Round 2 (3 lenses re-run over the full range): F1-F7 resolved, one 🟠 (N1) and
  six 🟡 notes.
- Round 3 (closing, 3 lenses): N1-N7 resolved, no 🔴/🟠, PASS.

Nine 🟡 residuals are listed for the parent in
`.scratch/reviews/235/62a23e0-code-review.md`; none is a defect in the codified
rules.

## Interfaces

No code interfaces. The observable contract is the wording of the rulebook: after
this change, no file under `.agents/skills/**` or `docs/engineering-workflow.md`
tells a lane to push, open a PR or write `.agents/wisdom/`.

## Dependencies

None. `bun install` completed (189 packages) before any check.

## Planned tests

There is no unit or Playwright test for prose. Verification is the brief's gate
set:

- `bun run lint`, `bun run typecheck`
- `bun run skills:sync` then `bun run skills:check` (record both exit codes)
- `rg` for `git push` / `gh pr create` across `.agents/skills/**` and
  `docs/engineering-workflow.md` — only under a parent-only heading
- read §10/§12 as a lane and confirm the conclusion is "report, do not push"

`skills:sync`/`skills:check` matters because `.claude/skills` is generated from
`.agents/skills`. Note: every skill this change edits
(`feature-implement`, `capture-wisdom`, `guard`, `debate`) is **pi-only** and is
not a key in `skills-lock.json`, so the mirror has no second copy to update;
`skills:check` still must pass, and the report says so explicitly.

## Risks

- **Over-reach.** The whole file is the rulebook; a large diff is a liability. All
  edits are wording/attribution on the existing structure — no section is moved or
  reordered, and the review-tier section from #230 is untouched.
- **A lane still reads a push instruction.** Mitigated by the grep gate above.
- **Mirror drift.** Mitigated by running sync + check and committing any mirror
  change that appears.
