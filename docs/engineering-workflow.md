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
| `RED_ON_PARENT_CACHE` | the cached worktrees `scripts/red-on-parent.ts` makes | CI runner configuration only, not local machine setup. It moves the gate's throwaway worktrees out of the runner's OS temp folder. |
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
Commit complete reviewable scope
    ↓
Risk-sized local review — one code-review for routine changes; three lenses only for named elevated risk
    ↓
Local reviewloop payload and 5/5 — selected executions, no unresolved actionable findings
    ↓
Guard Phase 2 — verify committed HEAD; commit fixes and refresh checks if needed
    ↓
Handoff verified SHA and local evidence — the lane stops here
    ↓
── parent-owned from here ──
    ↓
Push + open PR
    ↓
CI acceptance — required on the current head before merge
    ↓
Architecture review — parent-only when a module, seam, adapter or interface changed
    ↓
Guard Phase 3 — pre-report gate
    ↓
Capture wisdom (repeated pattern only) + report to the owner
    ↓
Merge — cheap-to-reverse merges itself; expensive or decision diffs wait for the owner
```

A **worker lane commits before local review and rendering**, verifies that same HEAD through Guard Phase 2, and stops with a handoff. Commit review fixes before refreshing affected checks and current-head reviews. Post-commit results go in `.scratch/reviews/<issue-id>/<head-sha>-verification.md`; do not create an evidence-only commit. A fix requires a new commit and refreshed checks and stale reviews. Its completion wakes the
parent session, which pushes, opens the PR, drives the review rounds and merges.
A lane that pushes is breaking its authority boundary, not helping.

The red-on-parent replay runs only in the PR `checks` job and must pass before
merge. Parents, workers (including nested subagents), reviewers and hooks must
not run or delegate it locally. Local replay output is not an acceptance
requirement for review, push or report. Ordinary TDD and focused regression
tests still apply. For browser verification, follow `guard`'s **Browser
verification: selector first** procedure: inspect
`bun scripts/e2e-changed.ts --dry-run` before taking a heavy slot. The selector's
map remains fail-closed; CI keeps its own event-range and override behavior.

Do not run a later phase without recording the earlier gate, its commands, and its result.

## Local verification and CI acceptance

Local proof targets the changed behavior and direct callers. Run focused regression and affected integration tests first. Add relevant typecheck, lint and generated-file checks; build locally only when bundling, imports, configuration or packaging changed. Run browser cases for affected rendering, focus, navigation or interaction, and integration plus negative tests for money, security and recovery contracts. Full suites, full browser runs, production builds and dependency audits are CI-final, not per-commit or per-fix chores. Name a concrete uncertainty or CI coverage gap before running one locally. Tests must detect a named reachable failure with an independent expected result; test counts, deletion quotas and blanket mock bans are not quality measures.

The stable aggregate `CI acceptance` check is mandatory for merge. It must fail closed when required jobs fail, cancel or skip without a successful selector proof; critical selectors and full-run overrides remain part of CI. The owner has approved moving routine acceptance to CI, but the parent must verify required-check enforcement on the current PR head, including administrator enforcement, and obtain recorded owner acceptance of the bypass policy before activating the reduced local baseline. The parent verifies effective rules; only the owner decides whether bypass is acceptable.

Bootstrap exception: this policy PR may be published after focused local proof and review while `CI acceptance` is pending, because publication creates the check run. It is not merge-ready and does not activate the new routine policy until the parent records remote enforcement evidence and recorded owner acceptance of the bypass policy. Do not run the retired full local baseline on this policy PR merely to publish the gate. Other PRs retain the existing local baseline until the parent verifies activation. Local readiness, a pending check and CI acceptance are distinct states.

## Review invariants

- **Evidence is always required; only its form changes.** A visual change needs
  before/after images and a clip at real user pace; everything else needs the
  measurements (the failing-first run with the failing assertion named, the
  ablation proof the guard bites, the before/after numbers). The rule, and the
  four-part merge gate it feeds, is written down in
  [`docs/verification-and-merge-gate.md`](verification-and-merge-gate.md).
- **Verify every finding against the reviewed tree.** If stale or factually wrong, show code evidence and obtain reviewer resolution. Never mark a valid finding resolved by calling it a refinement; the complete disposition rule is below.
- **Review follows reachable risk, not size or path.** Every reviewable change gets local review and a reviewloop 5/5 with no unresolved actionable finding. A routine, reversible, localized change uses one fresh `code-review` context for Standards, Spec and affected-test adequacy. Record the risk rationale and explicit `debate`/`test-audit` skips in the existing payload. A new interface, cross-package behavior, integration uncertainty, or a concrete CI, security, schema, dependency, money, recovery, auth, crypto, release or merge-policy failure mode escalates the review. Name the failure mode; matching a path alone is not enough. High-assurance runs three distinct sessions initially: `debate`, `test-audit` and `code-review`. Specialist fanout is for a specific unanswered question, not the default. Review mechanics and evidence format live in `reviewloop`.
- **Verify each finding against source.** The parent checks base/head, actual reviewer session and model IDs, provenance and report. A worker claim is not evidence; reuse an exact-tree execution rather than duplicating it. Use an enabled non-author family when available. OpenCode is opt-in and never a quota fallback. When no independent family is enabled, the owner's standing exception permits separate same-family sessions; record actual model IDs, the availability reason and the `independence` object. The exception does not waive review, 5/5 or finding resolution.
- **The lenses run on a different model family than the author (owner decision, 2026-10-19; family
  rule 2026-10-26).** The author is the lane's model, read from its commit trailer, never the
  parent's. Independence is a family, not an exact ID: free and paid DeepSeek are one opinion.
  Select reviewers from the session's enabled routes using `.agents/skills/reviewloop/SKILL.md`.
  OpenCode review is optional, not a prerequisite for review or a quota-triggered fallback. Do not
  probe or request it unless the owner opts in for the current scope. With more than one lens,
  at least two families must appear unless an approved exception applies.
  The owner gives standing approval for same-family review when OpenCode is unavailable; no new per-PR approval is needed. Prefer an enabled working non-author family; otherwise use separate reviewer sessions and disclose the shared family. Record the standing approval in `independence: { approvedBy, reason }` under `reviewloop`. All required lenses, current-head 5/5 and finding-resolution gates still apply.
- **A bounded fix gets one bounded review.** Commit the fix, rerun checks it affects, then ask one fresh reviewer to inspect the combined delta and direct affected callers. The reviewer reads prior findings and explicitly carries forward unchanged conclusions. Rerun another lens only if the fix creates a concrete risk that lens covers. After three fix rounds, reassess the design. Never clear or defer an actionable finding to reach 5/5; a score cannot override one. A new head needs current-head evidence for the fix review, not a full restart of every initial lens.
- **Small related refinements may stay in the PR.** They must serve the same acceptance goal, stay localized, add no behavior, risk, decision, dependency or architecture scope, and fit bounded tests and review. Copy clarification or local duplication cleanup may qualify; a new goal, cross-cutting change, auth redesign or schema migration belongs in a separate PR. One focus line that can reach saved prices is not compact. Correctness and safety dependencies are blockers. Reassess review depth, batch refinements before final review and stop opportunistic chains. A nonblocking improvement is optional only when the reviewer accepts its disposition and applicable gates allow it.
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

The review and finding-resolution rules above govern architecture findings too. Split substantial work only when the current change does not depend on it; otherwise hold this PR until the blocker is fixed and the new head meets the review gate.

**It is a loop with a fixed point, not a one-shot step.** reviewloop's 5/5 and this review have to agree
on the same head, and a finding has exactly three ways out:

```
reviewloop 5/5?  ── no ──→ fix ──→ ask once more at the new head
      ↓ yes
architecture review (this diff only)
      ↓
finding about this diff?
      ├─ nothing ────→ merge
      ├─ fixable here ──→ fix → review all applicable checks at the new head
      └─ substantial, independent work ──→ separate issue and PR; dependent work stays held
```

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
| Default | No seam moved means no architecture report. Record `architecture: no seam moved` in the existing PR handoff. |

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
can break, not how many lines it touches. Local review is required for every
reviewable change; compact selects its depth, not whether review happens. A 600-line PR that adds a screen without
risking a named failure is Standard; a 12-line PR under `apps/api/src/auth/**`
that can bypass a session check is High-assurance.

| Tier | Decision: what the change can break | Required review |
| --- | --- | --- |
| Lightweight | Truly non-reviewable files only (.gitignore, LICENSE, .scratch/): nothing a runtime executes reads them | Guard and quality checks only |
| Standard | Everything else without a named elevated failure mode | One focused code-review context for Standards, Spec and affected-test adequacy; local reviewloop 5/5 |
| High-assurance | A named reachable failure could affect money, inventory, debt direction, auth/session/RBAC/secrets, security/crypto, recovery/backup, schema or dependencies; CI/release/merge policy; a new interface, cross-package behavior, or unresolved integration uncertainty | Three distinct initial sessions: debate, test-audit and code-review; local reviewloop 5/5. A bounded fix uses the one-review process above, not a repeated three-lens cycle. |

Examples include stock going negative, incorrect average cost or invoice totals, wrong debt direction, a bypassed session check, lost backup data, or a dependency/configuration change that can break a release. Name the affected contract and reachable failure. A path match is only a prompt to inspect callers, never a tier assignment; a path outside these areas does not exempt a real risk.

Record the tier and a short risk rationale in the existing design or PR handoff. Do not create an extra mandatory artifact just to justify review depth. Compare prototypes early when visual behavior is uncertain; a prototype comparison is not required for every document or change.

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
The local reviewloop verdict must be 5/5 with no unresolved actionable findings. Until the owner ends the [paired trial](review-comparison.md), both current-head verdicts must be 5/5 with no unresolved actionable findings. Request Greptile once per pushed head; a missing hosted verdict blocks merge, including when credit is unavailable. Lean local review does not retire that requirement.

The gate itself is [`docs/verification-and-merge-gate.md`](verification-and-merge-gate.md):
the four reasons (5/5, `Last reviewed commit` == head, no comments after the
verdict except `<!-- crew-evidence -->`, an evidence comment at head), the
AUTO/OWNER/REFUSED decision, and the queue path when it cannot merge now.

A **CI change** (anything under `.github/`) goes to the owner for the diff before
it merges, whatever the review says. Merge order matters when two PRs share a
store/router: land the one that owns the write path first and rebase the other
onto the new `develop`.

Parent-only merge command: `gh pr merge <num> --squash --subject "<title> (closes #<issue>)"`.
