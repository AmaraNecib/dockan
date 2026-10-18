Reviewer model: zen-proxy/glm-5.3-flash-free
Author model:   zen-proxy/deepseek-v4.1-flash-free

PR #284 code-review lens — head `bb8ec50`

## Verdict: merge (findings, none blocking)

The documentation change agrees with the tree it describes, and the places I could
measure, I measured. The two findings below are drift, not disagreement.

## Spec 9/10 · Standards 9/10

Deductions for the drifted hard-coded numbers (45/46 commits, 58 files) that went
stale against their own repo between authorship and review — the exact failure the
same PR's new lesson warns about.

## What was verified against the tree

- README rule vs folder reality: `.agents/wisdom/README.md` states "category folder
  says where it lives, filename never carries a date, append on recurrence." All
  61 lesson files sit in exactly the ten category folders the README lists
  (`api/`, `architecture/`, `data/`, `e2e/`, `money/`, `packaging/`, `process/`,
  `testing/`, `vault/`, `web/`); zero dated filenames remain at the root; only
  `README.md` sits at the top level. The tree obeys the rule it now states.
- No duplicated lesson among the port pair: `process/concurrent-lane-e2e-ports.md`
  (#146, sibling lanes share 4317/5173) and `e2e/port-collisions-vault-spec.md`
  (#123, hardcoded vault pair) teach different failure modes, and the second
  already carries its own "Superseded by #202" note instead of a second file. The
  other 61 titles scanned for overlaps; none found.
- AGENTS.md worktree mechanism matches the T3 contract: `delegate_task` with
  `isolation: "worktree"` (checkout from the parent's local commit, project setup
  runs, completion wakes the parent, uncommitted edits are not copied — hence the
  new "commit before delegating" line is correct, not redundant);
  `t3_thread_launch` with `existing_worktree` as the dead-lane fallback matches
  `process/resume-a-dead-lane.md` point for point.
- Project setup scripts (`package.json`) confirm "worktree setup does not install":
  no script in the project runs `bun install`, so the node_modules warning is real.
- Trust-decision paragraph: both quoted lane roots exist in `~/.pi/agent/trust.json`.
- Search policy: the pruned `find . -type d -name node_modules -prune -o … -print`
  is the correct form, and the `-not -path hides-but-walks` explanation is accurate.
  The "guard refuses one before it runs / escalates with the parent" wording
  matches the `no-root-scans.ts` extension behaviour in force on this machine.
- Media claim measured, not assumed: `origin/develop` tracks 794 files under
  `.scratch/reviews/`, 105 under `.scratch/implementation/`, and 0 under
  `.scratch/evidence/` — the numbers in `name-the-lens-model-in-its-own-report.md`
  are correct as written.
- The two-line reviewer/author header the new lesson prescribes matches this very
  prompt's required header verbatim, including the three-space alignment.
- Vendored-skill sync: `bun run skills:check` passes (32 skills match); the skill
  edits in this PR did not break the mirror.

## Findings (one line each)

1. LOW, non-blocking — AGENTS.md: "45 non-merge commits on `develop` touch
   `.agents/wisdom/` (46 with merges)" measured today is 47/48; a hard-coded count
   drifts by the time anyone can check it. Say "45+" or re-measure at merge.
2. LOW, non-blocking — `feature-implement/SKILL.md`: "not all 58 files" — the
   folder now holds 61 lesson files (+README), i.e. the count went stale inside the
   same PR. Reword to something that cannot drift ("grep first; never read the
   folder").
3. LOW, non-blocking — `architecture/principles.md`: empty title line and a generic
   bundled name; the one file that breaks the README's "filename says what it
   teaches" convention. Rename (e.g. `review-pending-stays-provisional.md`) or
   give it a real H1.

## Could not verify

- The R2 layout attributed to #263 (`<PR>/before/`, `<PR>/after/`,
  `<PR>/after/hd/`) — no local grep isolated it; plausible from the PR body
  pattern but unconfirmed from source.
- The Windows directory-junction dependency-sharing hazard ("deleting
  `node_modules/` through the junction would delete that worktree's packages
  too") — I did not execute a junction; the mechanism is sound on paper.
- The 45/46 figure at the time it was measured (history rewritten before this
  branch; only the current 47/48 is checkable).
- Whether the four new entries (#282, #285, #275/#276 details) correctly name PRs
  and CI outcomes — verified the claims that were grep-able in the tree, not the
  GitHub events.

## Edits outside this report

None.
