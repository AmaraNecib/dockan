# Engineering Workflow

Canonical lifecycle for changes in this repository (Dokan). The `feature-implement` skill is the
mandatory orchestrator; this document is its reference.

## Repository

- Remote: GitHub (`origin`). Base branch: `develop`.
- Package manager: Bun workspaces (`bun.lock`). Never introduce pnpm/npm lockfiles.
- Checks (root scripts):

```bash
bun run lint        # oxlint (with anti-slop plugin config)
bun run typecheck   # turbo typecheck across workspaces
bun run test        # turbo test across workspaces
bun run test:e2e    # Playwright
```

Rust changes (`apps/desktop/src-tauri/`) additionally require:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -- -D warnings
```

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
Greptile review (cli-review skill or @greptile-apps on the PR)
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
- **Verify a finding before fixing it.** Greptile edits its comment in place and
  re-lists findings a later commit already fixed. Read the cited lines first; if
  the finding is stale, close it on the PR with the line evidence rather than
  re-implementing a fix that exists.
- **Reviewers are independent.** `debate`, `test-audit` and `code-review` run as
  separate sub-agents. A child that reports "I ran the gates in-lane" has not run
  them — re-run the lenses where the tool exists, and record the disclosure.
- **The lenses run on a different model than the author (owner decision, 2026-10-19).** Author
  lanes run `opencode-go/deepseek-v4.1-flash`; `debate`, `test-audit` and `code-review` run
  `zen-proxy/minimax-m3.1-flash-free`. A model that reviews its own diff shares the blind spots the lens exists to
  catch, so the reviewer is never the author. For one stretch on 2026-10-19 the owner required a
  single model for both roles; that is no longer the rule, and these two are the pair.
- **All three lenses run at Standard and above.** `debate` is no longer reserved
  for High-assurance (owner decision, 2026-10-18); the tier decides how much
  scrutiny a failure mode earns, not whether the debate happens.
- **A green suite is not a review.** Every gate names the commands it ran and
  their exit codes; an unstated gate is an unrun gate.

## Review tiers

**The tier follows the failure mode, never the diff size.** Ask what the change
can break, not how many lines it touches. A 600-line PR that adds a screen without
risking a named failure is Standard; a 12-line PR under `apps/api/src/auth/**`
that can bypass a session check is High-assurance.

| Tier | Decision: what the change can break | Required review |
| --- | --- | --- |
| Lightweight | Truly non-reviewable files only (.gitignore, LICENSE, .scratch/): nothing a runtime executes reads them | Guard Phase 1 → quality check → report |
| Standard | Everything else: code, tests, config, UI, API, skills, docs | Standard gates: guard 1 → quality check → debate → test-audit → code-review → guard 2 → Greptile → guard 3 |
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
- Review evidence lives in `.scratch/reviews/<issue-id>/<head-sha>-<gate>.md`. Evidence filenames
  must contain the exact reviewed HEAD SHA; any later reviewable-file change makes evidence stale.
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
A lane never merges at all; squash merges only. A 5/5 Greptile verdict with no findings,
anchored to the current head SHA, and every CI check green is the **bar to merge at
all** — auto-merging below it is not allowed, and a REFUSED verdict never merges.

The gate itself is [`docs/verification-and-merge-gate.md`](verification-and-merge-gate.md):
the four reasons (5/5, `Last reviewed commit` == head, no comments after the
verdict except `<!-- crew-evidence -->`, an evidence comment at head), the
AUTO/OWNER/REFUSED decision, and the queue path when it cannot merge now.

A **CI change** (anything under `.github/`) goes to the owner for the diff before
it merges, whatever Greptile says. Merge order matters when two PRs share a
store/router: land the one that owns the write path first and rebase the other
onto the new `develop`.

Parent-only merge command: `gh pr merge <num> --squash --subject "<title> (closes #<issue>)"`.
