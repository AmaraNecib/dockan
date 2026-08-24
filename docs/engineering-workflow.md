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
Debate — High-assurance only
    ↓
Test audit — Standard + High-assurance
    ↓
Code-review — Standards + Spec axes against pinned base SHA
    ↓
Guard Phase 2 — pre-push gate
    ↓
Push + PR (user approves)
    ↓
Greptile review (cli-review skill or @greptile-apps on the PR)
    ↓
Guard Phase 3 — pre-report gate
    ↓
Capture wisdom + report
```

Do not run a later phase without recording the earlier gate, its commands, and its result.

## Review tiers

| Tier | Applies to | Required review |
| --- | --- | --- |
| Lightweight | Truly non-reviewable files only (.gitignore, LICENSE, .scratch/) | Guard Phase 1 → quality check → report |
| Standard | Code, tests, config, UI, API, skills, docs | Standard gates: guard 1 → quality check → test-audit → code-review → guard 2 → Greptile → guard 3 |
| High-assurance | Auth/RBAC, backup/restore, invoice & debt money calculations, security | Standard plus debate |

High-assurance examples in Dokan: stock quantity going below zero, average-cost recomputation,
payment amounts exceeding invoice totals, debt direction (who owes whom), auth login.

## Tickets and specs

- Draft tickets live in `.scratch/issues/` (ignored) until they graduate to GitHub issues.
- Designs live in `.scratch/implementation/<issue-id>-design.md`.
- Review evidence lives in `.scratch/reviews/<issue-id>/<head-sha>-<gate>.md`. Evidence filenames
  must contain the exact reviewed HEAD SHA; any later reviewable-file change makes evidence stale.
- Durable lessons go to `.agents/wisdom/`.

## Source-only change policy

Builds and test runs may generate `dist/`, `target/`, coverage, Playwright reports, and other
ignored artifacts. Those are never part of a source change. Before committing:

```bash
git diff --name-only <base-sha>...HEAD
git status --short --ignored
```

Stage named source/config/test/evidence files only. Never use `git add -A`.

## Merge rules

The agent never merges on its own initiative. Merge requires: explicit user instruction, all local
gates green, CI green when the branch has CI, and a clean Greptile result. Squash merges only.
