# Test-audit lens — PR #284 (docs-wisdom-categories @ bb8ec50)

Reviewer model: zen-proxy/glm-5.3-flash-free
Author model:   zen-proxy/deepseek-v4.1-flash-free

## Verdict

**Merge.** One minor, non-blocking finding. Every mechanical check passed except three
stale dated filename references inside newly-added process lessons.

## Spec & Standards: 9/10

The restructure is internally consistent (README rule matches the folders exactly, all
ten category folders are populated, zero dated filenames anywhere, `rg` finds no
surviving `wisdom/20xx` path references outside the three prose cases below). The point
is docked for the stale cross-references: the PR re-writes the naming rule and adds a
lesson *about* evidence quality, while leaving three of its own new files citing lessons
by names that no longer exist.

## Checks run (mechanical)

1. **No dated filenames.** `find .agents/wisdom -name '*.md' | grep '/[0-9]{4}-...'` →
   zero hits. This includes code-comment references in source files: `rg
   'wisdom/20xx-'` over the repo → zero hits.
2. **Every category folder has at least one lesson.** Ten folders (`api` 4,
   `architecture` 1, `data` 6, `e2e` 8, `money` 10, `packaging` 1, `process` 12,
   `testing` 5, `vault` 2, `web` 12). No stray non-markdown files in the tree.
3. **README rule matches what the folders do.** README states "category folder says
   where it lives, filename says what it teaches, no dates" — the folders comply
   exactly, including the `Seen in:` recurrence rule (checked the one file with
   multi-occurrence provenance survives as one file).
4. **`bun run skills:check`** (the PR's only executable claim about the repo) →
   passed: `skills mirror in sync: 32 skills in .claude/skills == .agents/skills`.
5. **The corrected `find` example is proven by execution**, not just by reading. The
   worktree guard blocks a comparable bare `find .` here, so I built a 4-file probe
   tree under `/tmp` (three `.ts` files, one inside a `node_modules/`) and ran the
   exact command from the diff against it: it printed only the two `.ts` files outside
   `node_modules` and did not descend. The claim that `-not -path` hides output while
   `-prune` stops the descent is correct.
6. **The media-state claims are exact.** `git ls-files` counts: 794 files tracked under
   `.scratch/reviews/`, 105 under `.scratch/implementation/`, 0 under
   `.scratch/evidence/` — matching the new lesson's numbers verbatim. The PR itself
   adds no tracked media (diff touches no `.png/.gif/.mp4/.webp/.jpg` file).
7. **Markdown/path links.** Every `.md` path cited in `AGENTS.md`, the three linked
   docs, and the wisdom README resolves (`docs/verification-and-merge-gate.md` and
   `docs/skills-vendoring.md` both exist). Apparent misses were grep artifacts:
   `<issue-id>-design.md` template placeholders and two relative links that resolve
   from their own directory — not findings.
8. **Behaviour risk.** The four non-docs files in the diff
   (`amount.tsx`, `money-format.ts`, `use-barcode-scanner.test.tsx`,
   `money-display-helpers.ts`) are comment-only: each diff hunk is a wisdom-path inside
   a doc comment. No code, no test change; nothing to run against them.

## Findings

- **[minor, non-blocking] Three newly-added process lessons cite lessons by their
  pre-rename dated filenames, which no longer exist.**
  1. `ci-failure-evidence.md:3` → `2026-10-14-e2e-ack-vs-test-budget.md`
     (now `.agents/wisdom/e2e/ack-vs-test-budget.md`)
  2. `concurrent-lane-e2e-ports.md:19` →
     `2026-10-13-e2e-stale-server-and-checksum-flake.md`
     (now `.agents/wisdom/e2e/stale-server-and-checksum-flake.md`)
  3. `lane-gate-capability-checks.md:26` → `2026-08-24-greptile-cli-large-diff.md`
     (now `.agents/wisdom/process/greptile-cli-large-diff.md`)

  These are prose cross-references, not markdown links, so the change is findable by
  content. But the README's own rationale for this PR is "two names for one lesson make
  a lane read one and miss the other"; a stale non-existent name does the same. Fix is
  a three-line path update, can ride any later docs commit.

## Could not verify

- **No test suite was run.** Nothing in the diff changes executable behaviour
  (comment-only edits), so `test:*`, `test:e2e`, and the build were not exercised; the
  only runnable consistency claim (`skills:check`) was run and passed.
- **I could not re-run the repo's own guard-blocked `find` example in place** (the
  protection extension refuses any `find .` segment here, and this session has no
  supervisor to escalate through). Verified in a `/tmp` probe tree instead — semantics
  confirmed; the exact repo-root execution shown in the doc is untested. This is the
  state the doc's example intends, so I read the risk as nil.
- Sourced the checks against the fallback checkout `/d/projects/mani-project` (branch
  `docs-wisdom-categories`, head `bb8ec50` verified): the named worktree
  `/d/worktrees/mani-project/t3-fe8ea669` does not exist here.

## My own edits

**None**, except this report file. The untracked directories `git status` shows
(`.pi/`, `.scratch/evidence/`, `.scratch/issues/`, `.scratch/reviews/275/`,
`.scratch/scripts/`, `.scratch/t3-recon/`, `.scratch/wip/`) existed before this
session; I only created `.scratch/reviews/284/` for this report and touched no
tracked file.
