# Engineering Workflow

Canonical lifecycle for changes in this repository (Dokan). The `feature-implement` skill is the
mandatory orchestrator; this document is its reference.

## Repository

- Remote: GitHub (`origin`). Base branch: `develop`.
- Package manager: Bun workspaces (`bun.lock`). Never introduce pnpm/npm lockfiles.
- Checks (root scripts):

```bash
bun run lint        # oxlint (with anti-slop plugin config)
bun run typecheck   # turbo typecheck across workspaces, plus the scripts/ and tests/ projects
bun run skills:check           # generated .claude/skills mirror matches .agents/skills
bun run test        # turbo test across workspaces, plus scripts/ and tools/
bun run --filter @dokan/web build   # the production bundle the checks job builds
bun audit --audit-level=high        # fail on high/critical advisories only
bun run test:e2e    # Playwright (scoped by the selector on a PR)
```

Rust changes (`apps/desktop/src-tauri/`) additionally require:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -- -D warnings
```

## Environment paths a fresh machine must set

Agents and collaborators lose about an hour to each of these, because the defaults put
heavy artifacts on the wrong drive. Set them once (user environment variables are enough)
and every worktree, lane and CI lane puts its artifacts on the drive you chose:

| Variable | What it moves | Effect |
| --- | --- | --- |
| `PLAYWRIGHT_BROWSERS_PATH` | the Playwright browser download (~1.8 GB) | The browsers already live in one **per-user** directory, so checkouts share them — no re-download per checkout. The variable decides **where** that directory is, which is what moves the 1.8 GB off the system drive. |
| `RED_ON_PARENT_CACHE` | the cached worktrees `scripts/red-on-parent.ts` makes | Without it, those throwaway worktrees land in the OS temp folder and quietly fill the system drive. |
| `BUN_INSTALL_CACHE_DIR` | bun's install cache | Keeping the cache on the same drive as the checkout means installs stay warm instead of re-copying every package into a fresh worktree. |

Turbo's cache needs no variable: a worktree shares the **main** checkout's `.turbo/cache`
(measured — a `--force` run started inside a worktree wrote its entry into the main checkout's
cache directory and created no `.turbo` of its own), so a lane warms the cache the parent filled.

## Feature lifecycle

```
Read .agents/wisdom/ — read-only for lanes; report the lessons you applied
    ↓
Ticket/spec (.scratch/issues/ or GitHub issue)
    ↓
Pin review tier + base SHA (merge-base with develop)
    ↓
Design (.scratch/implementation/<issue-id>-design.md)
    ↓
Implementation (TDD; Playwright E2E for user-facing flows)
    ↓
Guard Phase 1 — pre-commit checks
    ↓
Quality check — relevant skills
    ↓
Debate — Standard + High-assurance (never Lightweight)
    ↓
Test audit — Standard + High-assurance
    ↓
Code-review — Standards + Spec axes against pinned base SHA
    ↓
Guard Phase 2 — pre-push gate
    ↓
commit — the lane stops here
    ↓
── parent-owned from here ──
    ↓
Push + open PR
    ↓
Review round (reviewloop) — to a 5/5; Greptile runs beside it while the two are compared
    ↓
Architecture review — improve-codebase-architecture (only once the code is accepted)
    ↓
Guard Phase 3 — pre-report gate
    ↓
Capture wisdom (repeated pattern only) + report to the owner
    ↓
Merge — cheap-to-reverse merges itself; expensive or decision diffs wait for the owner
```

A **worker lane stops at Guard Phase 2** and commits. Its completion wakes the
parent session, which pushes, opens the PR, drives the review rounds and merges.
A lane that pushes is breaking its authority boundary, not helping.

Do not run a later phase without recording the earlier gate, its commands, and its result.

## Review invariants

- **Evidence is always required; only its form changes.** A visual change needs
  before/after images and a clip at real user pace; everything else needs the
  measurements (the failing-first run with the failing assertion named, the
  ablation proof the guard bites, the before/after numbers). The rule, and the
  four-part merge gate it feeds, is written down in
  [`docs/verification-and-merge-gate.md`](verification-and-merge-gate.md).
- **Verify a finding before fixing it.** A review comment can re-list findings a
  later commit already fixed. Read the cited lines first; if the finding is stale,
  close it on the PR with the line evidence rather than re-implementing a fix that
  exists.
- **Two reviews per change: the author's, then an independent one** (owner decision,
  2026-10-20). The author review is written by the author's model in a fresh session that
  reads the diff: the intent, the load-bearing part, the known weak spots, what was
  deliberately left out, and where a reviewer should look hardest. It approves nothing. The
  independent review is the lens round, and the lenses read the author review first, so
  the known-weak list is their checklist and the author's claims are claims to test.
- **Reviewers are independent.** `debate`, `test-audit` and `code-review` run as
  separate sub-agents. A child that reports "I ran the gates in-lane" has not run
  them — re-run the lenses where the tool exists, and record the disclosure.
- **The lenses run on a different model family than the author (owner decision, 2026-10-19; family
  rule 2026-10-26).** The author is the lane's model, read from its commit trailer, never the
  parent's. Independence is a family, not an exact ID: free and paid DeepSeek are one opinion.
  Pick from the free ladder first — `opencode/deepseek-v4.1-flash-free`,
  `opencode/glm-5.3-flash-free`, `opencode/mimo-v2.6-flash-free`, `opencode/beam-free` — then the
  cheap paid fallback `opencode-go/deepseek-v4.1-flash` and `opencode-go/mimo-v2.6-flash`, only
  when the free routes are exhausted. With more than one lens, at least two families must appear.
  A route unused this session gets a one-line probe first. Free lenses carry no parallelism cap.
  When every non-author family is exhausted, the owner may approve an exception recorded as
  `independence: { approvedBy, reason }`; a lane cannot approve its own.
- **Run both reviews until the owner ends the trial.** The parent runs `reviewloop` and
  Greptile on the same pinned boundary across several PRs. Follow the
  [comparison protocol](review-comparison.md) for independent first-pass records, verified
  findings, time and cost. Neither review replaces the other automatically.
- **All three lenses run at Standard and above.** `debate` is no longer reserved
  for High-assurance (owner decision, 2026-10-18); the tier decides how much
  scrutiny a failure mode earns, not whether the debate happens.
- **A lens returns findings, not an essay.** The evidence file holds the detail; the message back to
the parent holds the finding list, each one line with file:line, severity and the smallest fix. A
lens that pastes its whole report into the conversation costs the same tokens as ten findings and
buys nothing: the parent reads the file when it needs the argument.
- **A green suite is not a review.** Every gate names the commands it ran and
  their exit codes; an unstated gate is an unrun gate.

## Merge queue

A stacked PR — one whose base is another branch, not `develop` — gets **no CI at all**:
`.github/workflows/ci.yml` runs on `pull_request` into `develop`, on `push` to `develop`, and on
manual dispatch. A child of a stack therefore shows two or three checks (the security scanners) and
nothing else: no typecheck, no lint, no tests, no e2e. Green there is not a signal.

So the order is not a preference, it is the only sequence that verifies anything:

1. The base PR merges into `develop`.
2. The child rebases onto the new `develop` **and** has its base changed to `develop`. Rebasing
   alone is not enough — the child would still target the branch it was stacked on, and still run
   no CI.
3. Now CI runs, and the child's head is new, so the review request is asked once more at that
   head.
4. The child merges.

The rebase conflict is planned *before* step 1, while the base is still moving: a plan written
against a base that has not landed is worth more than a merge started against one that has, because
the plan names the symbols a resolution must preserve from both sides.

## Architecture review

**Runs after reviewloop says 5/5, and it is parent-owned** (owner decision, 2026-10-20). The order is:
lenses → push, open the PR → reviewloop to a 5/5 → **architecture review** → fold what it found →
merge. Running it earlier spends the token budget on code whose acceptability is still in question;
run it once the diff is known to work, and its findings are about quality only.

The vocabulary is cheaper than the review and applies from the first line of code:

| When | Skill | Form |
| --- | --- | --- |
| While designing and writing | `codebase-design`, `domain-modeling` | Vocabulary and glossary only: deep modules, seams, `CONTEXT.md` terms. No report. |
| After the 5/5 | `improve-codebase-architecture` | The deep pass, and only then. |

A lane cannot run the deep pass: it ends by asking *which candidate to explore*, and that pick is
the owner's.

**Two forms, and the trigger decides which.**

| Trigger | Form |
| --- | --- |
| The diff adds a **module**, moves a **seam**, adds an **adapter**, or widens an existing **interface** | The full pass: walk the codebase, write the HTML report to the OS temp dir, hand the owner the path and the candidate list |
| Anything else | One line in the PR evidence comment: `architecture: no seam moved` |

Both forms are cheap; skipping the question is not. The report **never lands in the repo** — it is
written to the OS temp dir and its absolute path goes in the PR evidence comment so the review is
reproducible from the PR alone.

**It is a loop with a fixed point, not a one-shot step.** reviewloop's 5/5 and this review have to agree
on the same head, and a finding has exactly three ways out:

```
reviewloop 5/5?  ── no ──→ fix ──→ ask once more at the new head
      ↓ yes
architecture review (this diff only)
      ↓
finding about this diff?
      ├─ nothing ────→ merge
      ├─ fixable here ──→ fix → push → reviewloop 5/5 → review again (two rounds max)
      └─ too big for this PR ──→ its own issue + its own PR/lane → merge this one on its 5/5
```

**Small fix here, big fix elsewhere.** A finding the diff can absorb is fixed on the branch, and the
head moves, so reviewloop is asked once more there. A finding that needs its own PR — a seam move, a
deepening across several modules — does not hold this PR hostage: it gets an issue and a lane, and
this PR merges on the 5/5 it already has. What it does not do is vanish, so the guardrail is: **read
the evidence comment before merging and confirm the follow-up issue number is in it.**

**Stop rule: two rounds, then the owner.** If the second review still finds something, it is not a
detail — it is a disagreement about the design, and it goes to the owner rather than round three. An
unbounded loop spends review budget and never converges.

**Scope is always the diff under review.** A finding about older code is an issue, never a loop
iteration; otherwise the loop never terminates. A review that finds nothing about this diff costs
nothing: the 5/5 stands and the PR merges.

**The two vocabulary skills are always on, like TDD** (owner decision, 2026-10-20). `codebase-design`
supplies the words for every design conversation and `domain-modeling` keeps `CONTEXT.md` current while
the code is written — not at the gate. The deep pass is the audit that the habit happened.

**Budget: it has to earn its tokens.** The review runs on the diff's hot paths, never on the whole
repository, and it is paid for once per PR.

| Guard | Rule |
| --- | --- |
| Scope | The modules the diff touches and their direct callers. No repo-wide sweep. |
| Output | At most five candidates, each with a deletion-test verdict and one sentence of change. |
| Chat | The report path goes in the PR comment; the HTML is never pasted back into the conversation. |
| Re-runs | Two passes: one on the head reviewloop scored, one on the head that carries the fold. The second is spent only when the fold changed code — a fold that changed nothing leaves the first pass describing the tree. |
| Default | No seam moved means no report at all — the one-line form costs one sentence. |

**What a measured run returns.** On PR #291 the review produced five candidates: two that the
code-review lens had already written down in passing, and three new ones — **none of them a
defect**. Its one act of prediction was a candidate naming the *cause* of a lens finding the lens
had found as a symptom (the reason → meaning policy re-derived in three consumers, which is what
produced a comment claiming an event code the branch does not emit).

So the review's value is causes, not new bugs. A candidate that names a cause of an existing
finding is worth folding. A candidate that only consolidates is an issue, never a fix on a
bug-fix PR. And two of five candidates being re-derivations is the number that keeps the budget
honest: the review mostly re-derives what a careful lens already said, which is why it stays
scoped to the diff and never runs twice.

## Review tiers

**The tier follows the failure mode, never the diff size.** Ask what the change
can break, not how many lines it touches. A 600-line PR that adds a screen without
risking a named failure is Standard; a 12-line PR under `apps/api/src/auth/**`
that can bypass a session check is High-assurance.

| Tier | Decision: what the change can break | Required review |
| --- | --- | --- |
| Lightweight | Truly non-reviewable files only (.gitignore, LICENSE, .scratch/): nothing a runtime executes reads them | Guard Phase 1 → quality check → report |
| Standard | Everything else: code, tests, config, UI, API, skills, docs | Standard gates: guard 1 → quality check → debate → test-audit → code-review → guard 2 → reviewloop → guard 3 |
| High-assurance | The diff can violate one of these failure modes: (1) stock quantity goes below zero, or an average cost is recomputed wrongly; (2) a payment exceeds its invoice total, or a total is computed wrongly; (3) debt direction is wrong (who owes whom); (4) a login, session, RBAC or secret-handling rule is bypassed; (5) a backup/restore loses or corrupts data | Standard gates, plus a debate re-run on the final head once the fixes are in |

Auth/RBAC, backup/restore, invoice & debt money calculations, security and a
schema-version bump are **examples that hint at a failure mode, never a test**.
The same goes for paths such as `apps/api/src/auth/**` or `store/**`. A path that
matches one of these does not by itself make a change High-assurance; a path that
matches none does not exempt it. Money only travels through *some* store
functions, so `store/**` is not blanket High-assurance, and naming that pattern
would make every lane High-assurance forever. Dokan examples that exercise these
modes: stock quantity going below zero, average-cost recomputation, payment
amounts exceeding invoice totals, debt direction (who owes whom), auth login.

Every lane **records its chosen tier and a one-line justification in its design
doc** (`.scratch/implementation/<issue-id>-design.md`), so the choice is
reviewable next to the verdict instead of being invisible.

## Tickets and specs

- Draft tickets live in `.scratch/issues/` (ignored) until they graduate to GitHub issues.
- Designs live in `.scratch/implementation/<issue-id>-design.md`.
- Review evidence lives in `.scratch/reviews/<issue-id>/<head-sha>-<gate>.md` and is a
  **local, untracked artifact**. It never enters a diff: a committed review report is
  a file a reviewer must read, and reading it makes the reviewer judge our notes
  instead of our code, burns credits, and — because writing a new report changes a
  tracked file — makes the previous report stale, which asks for another review. The
  loop is closed by keeping the evidence out of the repository. The PR carries the
  summary instead: the three lens names, the SHA they read, the verdict and the
  counts, in one comment.
- Evidence filenames must contain the exact reviewed HEAD SHA; any later change to a
  **reviewable** file makes the evidence stale. `.scratch/` is not reviewable, so
  local evidence never goes stale by being written.
- **Wisdom: parent-owned generation, every lane's consumption.** A lane reads
  `.agents/wisdom/` before it starts, applies what bears on its task and says in
  its commit message body which lessons it applied (and which it deliberately did not)
  — reading is the lane's job even though writing is not. Wisdom is **read-only
  for a lane**: that same body may carry a candidate lesson under a `Lesson:`
  line, but only the parent writes the file, and only when the same failure has
  occurred more than once (one occurrence is a report line, not wisdom). This
  also keeps `.agents/wisdom/**` out of every lane diff, so a lane's review
  evidence can no longer go stale from a wisdom write it made to satisfy the
  rulebook.

## Source-only change policy

Builds and test runs may generate `dist/`, `target/`, coverage, Playwright reports, and other
ignored artifacts. Those are never part of a source change. Before committing:

```bash
git diff --name-only <base-sha>...HEAD
git status --short --ignored
```

Stage named source/config/test/evidence files only. Never use `git add -A`.

## Merge rules

**The class decides who merges.** The parent auto-merges a **cheap-to-reverse** PR itself
once the four reasons hold and every check is green — and only when the owner says so for
anything expensive to reverse, any decision, or a PR the owner asked to see. A visual PR is
cheap to reverse, so it auto-merges too, once its before/after packet is posted at the head.
A lane never merges at all; squash merges only. A 5/5 reviewloop verdict with no findings,
anchored to the current head SHA, and every CI check green is the **bar to merge at
all** — auto-merging below it is not allowed, and a REFUSED verdict never merges.
While the Greptile A/B runs, a Greptile verdict that disagrees with reviewloop is
investigated before the merge; it is not averaged away.

The gate itself is [`docs/verification-and-merge-gate.md`](verification-and-merge-gate.md):
the four reasons (5/5, `Last reviewed commit` == head, no comments after the
verdict except `<!-- crew-evidence -->`, an evidence comment at head), the
AUTO/OWNER/REFUSED decision, and the queue path when it cannot merge now.

A **CI change** (anything under `.github/`) goes to the owner for the diff before
it merges, whatever the review says. Merge order matters when two PRs share a
store/router: land the one that owns the write path first and rebase the other
onto the new `develop`.

Parent-only merge command: `gh pr merge <num> --squash --subject "<title> (closes #<issue>)"`.
