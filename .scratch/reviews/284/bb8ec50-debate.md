Reviewer model: zen-proxy/glm-5.3-flash-free
Author model:   zen-proxy/deepseek-v4.1-flash-free

# Debate lens — PR #284, head bb8ec50 (docs-wisdom-categories)

**Verdict: MERGE.** The restructure is complete and lossless; the load-bearing claims mostly verify
against the tree. Four numbers or pointers are stale and one recommended command is refused by this
machine's own guard — none blocks a docs-only merge on its own merits, but the HIGH one should land
in the next docs commit that touches search scope.

Reviewed in `/d/projects/mani-project` (the named worktree `t3-fe8ea669` does not exist; head
verified `bb8ec50`, branch `docs-wisdom-categories`, clean except untracked `.scratch/`).

## Spec: 7/10 — Standards: 7/10

Spec is docked for: a search-scope section whose headline `find` example still gets refused by the
guard it documents, and a "Measured reason:" line whose numbers are off by 2 — on the same standard
the new `a-lens-is-evidence-not-a-verdict` entry sets. Standards is docked for: six dangling
cross-references inside lesson bodies after the move, and one new wisdom entry quoting line numbers
from a head other than the one it names.

## Blocking: no

Docs-only diff; every claim failure below is a pointer or a count, not a mechanism. Fix-list worth
~20 minutes in the next docs commit.

## What verified

- **Every lesson survived the move.** 56 old lessons on `origin/develop` (57 `.md` files minus
  README) → 61 on HEAD (56 renames + 5 new entries). 55 of 56 are **byte-identical** by blob sha;
  the 56th (`web/rtl-dates-bidi-and-align.md`) differs only by the one-line cross-reference fix
  shown in the diff (old dated filename → `../testing/real-clock-fixtures.md`).
- **No lesson silently duplicated.** No blob appears in two lesson files; no filename basename
  appears in two category folders; the 5 new entries (`a-lens-is-evidence`, `name-the-lens-model`,
  `resume-a-dead-lane`, `stack-a-pr-...`, `gate-every-write-site`) each cover a topic no old entry
  covers (checked pairwise with `readonly-reviewer-can-fabricate-shell-output`,
  `abandoned-branch-is-a-source-not-a-review`, `lane-gate-capability-checks`,
  `vault/concurrent-runs-are-kdf-bound`).
- **"Six files carry edits from more than one commit, one carries three" — true** on
  `origin/develop`: exactly 6 lesson files at 2 commits each plus `e2e-stale-server-and-checksum-flake`
  at 3 (README, separately, also has 2 — the count is precise for lesson files).
- **"develop tracks 794 / 105 / 0 scratch files" — exact.** Measured 794, 105, 0 by `git ls-tree -r`.
- **Hono registration-order claim — substance verified.** `app.get("/api/vault/status")` is
  registered immediately before `app.all("*")` at commit **375788b** (534/537/538) and at the
  `fix-275-vault-lock-liveness` tip (`552/555/556`), so the status route always answers before the
  catch-all. The quoted lines match `375788b` exactly.
- **`App.tsx:55` claim in the self-corollary — verified.** At `1a5be76` the phrase "names a cause"
  wraps across `App.tsx:54→55` inside a `//` block, which is why `grep -rn "names a cause"` misses
  it. Reproduced the grep's empty result; reading the file finds the phrase.
- **`capture.mjs:157` claim — verified.** Commit `b4a8e80` tracks the evidence packet including
  `.scratch/evidence/285/capture.mjs`; line 157 is the `git status --porcelain` tracked-changes
  assertion applied to a diff it itself created.
- **Four code-file edits are comment-only pointer updates** (`amount.tsx`, `money-format.ts`,
  `use-barcode-scanner.test.tsx`, `tests/e2e/money-display-helpers.ts`) and all three new paths
  they cite exist.
- **Trust claims — verified.** `~/.pi/agent/trust.json` holds exactly `D:\worktrees\mani-project`
  and `D:\projects\mani-worktrees` (plus the project root itself).
- **`grep -rin <area> .agents/wisdom/ | head -40` works**; skills mirror in sync
  (`bun run skills:check`: 32 skills); no surviving `crew_report`/herdr instruction outside
  explanatory history; the `<!-- crew-evidence -->` marker at `engineering-workflow.md:165` is a
  live, load-bearing marker (scripts/verification-rule.test.ts pins it), not a rename leftover.

## Findings

1. **HIGH — the new Search-scope `find` example is refused by this machine's guard.**
   `find . -type d -name node_modules -prune -o -type f -name "*.ts" -print` was blocked
   on this very worktree ("Blocked: this walks the working directory..."), because the guard rejects
   any bare `find .` whatever the `-prune`. The other three forms in the same list (`rg`, `grep -rn
   --exclude-dir=node_modules`, subtree `find apps/api/src`) all ran clean here. Fix: drop the
   pruned `find` from the recommended list or add "the guard still blocks bare `find .` — use the
   subtree form" so a lane following the doc does not escalate a command the doc calls safe.
2. **MEDIUM — six dangling dated cross-references inside lesson bodies.** Following them lands on
   files that no longer exist at those paths; only `rtl-dates` got its link rewritten. Missing:
   `data/phone-identity-boundary-validation.md:28` → `2026-10-01-identity-keys-and-backfill`;
   `e2e/ack-vs-test-budget.md:3` → `2026-10-14-e2e-await-server-ack.md`;
   `process/abandoned-branch-is-a-source-not-a-review.md:15` → `...test-helper-vacuous-guard...`;
   `process/ci-failure-evidence.md:3` → `2026-10-14-e2e-ack-vs-test-budget.md`;
   `process/concurrent-lane-e2e-ports.md:19` → `2026-10-13-e2e-stale-server-and-checksum-flake.md`;
   `process/lane-gate-capability-checks.md:26` → `2026-08-24-greptile-cli-large-diff.md`. All
   targets exist under new paths; the references just don't resolve.
3. **MEDIUM — the `a-lens-is-evidence-not-a-verdict` entry pins its rebuttal quote to the wrong
   head.** It says the lenses ran at "#285's head (1a5be76)" and quotes `lock.ts:534/537/538` as the
   rebuttal — but at `1a5be76` `lock.ts` is 464 lines with **no** `/api/vault/status` route; those
   exact lines exist only at `375788b` (a later fix head on the same branch). Substance right, head
   attribution wrong — in an entry whose subject is verifying load-bearing claims. One sentence
   fixes it.
4. **LOW — "45 non-merge commits... (46 with merges)" on develop; measured 47 and 48.**
   `git log origin/develop --no-merges -- .agents/wisdom` = 47 (48 total; one merge, `aeeabc2`).
   45/46 is an October-16 snapshot (before #242 and #226 landed). The conclusion it supports
   (lane-written lessons collided) is unaffected; a "Measured reason:" line should not be stale.
5. **LOW — feature-implement says "not all 58 files"; the counts are 57 on develop, 62 after this
   PR.** Neither reference point is 58. Cosmetic.
6. **LOW — three renames shortened names below the README's own rule ("the filename says what it
   teaches").** `real-clock-fixtures-and-time-format-traps` → `real-clock-fixtures`;
   `test-helper-vacuous-guard-and-inherited-mutation-claims` → `test-helper-vacuous-guard`;
   `ci-affected-e2e-and-path-gates` → `ci-affected-path-gates`. Bodies still carry the dropped noun
  phrases so grep still finds them; the names teach less. Optional.
7. **LOW — `docs/verification-and-merge-gate.md:192` still lists `herdr` as a valid Harness
   trailer while the PR retires the herdr mechanism everywhere else.** Out of this PR's declared
   scope; note it.

## What I could not verify

- CI timings quoted in the new entries (the `8m13s` and `6.7m` runs, and the "byte-identical after
  rebase, same 6 files, +243/-22" claim) — no CI log in the tree; plausible but unverified.
- The quoted code-review lens report ("nothing on the status route ever delivers the code...",
  "Spec 4/10, Standards 5/10") — `#285` evidence was not committed (`#284` review folder holds only
  this head's test-audit and code-review reports) and the R2/Greptile comments are not reachable
  locally. The rebuttal itself I verified from source.
- The Greptile P2 stories in `name-the-lens-model-in-its-own-report` (model-confusion P2,
  capture-harness P2) — same origin; unverifiable from the repository.
- The R2 media layout attributed to `#263` (`<PR>/before|after|after/hd`) — no local copy of `#263`'s
  record to check the paths against.
- "The closest ancestor entry covers every worktree under it" (trust.json semantics) — the two lane
  root paths exist exactly as stated; the coverage behavior is a pi-internal claim I could not
  exercise from here.
- "Pi asks before loading a folder's skills... surfaces as an approval card in T3" — environment
  behavior, not repository state.

## My own edits

None. This report file is the only file I wrote; the guard block in finding 1 is quoted output I
reproduced, not a change I made.
