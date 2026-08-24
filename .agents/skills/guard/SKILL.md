---
name: guard
description: "Single source of truth for pre-flight checks: pre-commit, pre-push, pre-report. Tier-aware. Evidence-SHA-aware. Called by feature-implement. Do not bypass."
---

# Guard — Pre-flight Checks

Three phases. Each has explicit, checkable completion criteria.
If any check fails, stop and report. Do not proceed.

## Derive repository

Derive the repository and branch from Git first:

```bash
git rev-parse --show-toplevel
git status --short --branch
git rev-parse --verify HEAD
```

`gh` commands are allowed in this repository; if `gh repo view` fails because
there is no remote, fall back to Git-only checks and say so in the report.

## Phase 1 — Pre-commit

Run before every commit. Uses the Husky pre-commit hook.

```
[ ] bun run typecheck — passes? (turbo typecheck)
[ ] bun run lint — 0 errors? (oxlint)
[ ] bun run test — all tests pass? (turbo test)
```

If the change touches Rust Core (`apps/desktop/src-tauri/src/`):
```
[ ] cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml — passes?
[ ] cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -- -D warnings — clean?
```

## Phase 2 — Pre-review / pre-push

This is the gate before Greptile review and before any push. It never pushes by
itself. Uses the Husky pre-push hook when the hook is available.

```
[ ] bun run typecheck — passes?
[ ] bun run lint — 0 errors?
[ ] bun run test — all tests pass?
[ ] bun run test:e2e — passes? (when UI flows changed)
[ ] git status — working tree clean?
```

### Review evidence checks

For each evidence file `.scratch/reviews/<issue-id>/<sha>-*.md`:
- Extract the SHA from the filename
- Compare to current HEAD (`git rev-parse HEAD`)
- If they match → evidence is valid for the current code
- If they differ → inspect `git diff --name-only <evidence-sha> HEAD`:
  - If any reviewable file changed (apps/, packages/, .github/workflows/,
    .agents/skills/, docs/) → evidence is **STALE**, must regenerate
  - If only non-reviewable files changed (.gitignore, .gitattributes,
    .scratch/, LICENSE) → evidence remains valid

**All Markdown files under `docs/`, `.agents/`, and `.github/` are reviewable.**
Only truly non-reviewable files (.gitignore, .gitattributes, LICENSE, scratch)
get the docs-only exemption.

### Tier-specific requirements

**Lightweight** (genuinely non-reviewable files only):
→ Skip test-audit, debate, and code-review checks.

**Standard** (code, CI, workflow, config):
```
[ ] Test-audit evidence exists and is not stale
[ ] Code-review evidence exists and is not stale
```

**High-assurance** (auth/RBAC, backup/restore, invoice and debt money math):
```
[ ] Debate evidence exists and is not stale
[ ] Test-audit evidence exists and is not stale
[ ] Code-review evidence exists and is not stale
```

## Phase 3 — Pre-report

Run before reporting a local handoff or remote merge-readiness.

```
[ ] Local checks green (typecheck, lint, tests, e2e when relevant, Rust when relevant)
[ ] Review evidence current for the selected tier
[ ] Greptile CLI result is for the final HEAD and has no actionable findings
[ ] CI — required checks green on GitHub (when the branch is pushed)
[ ] PR description — accurate and complete
[ ] Any deferred items — documented with follow-up issues
[ ] Wisdom captured when a durable lesson was learned
```

## When a check fails

1. Report to the user what failed and why
2. Do not proceed past the failing check
3. If the user explicitly says "skip it" after being informed of the risk,
   note the waiver and continue.
4. If the user says "fix it", fix it and re-run the check.

**Mandatory gates (never skip):** typecheck, lint, applicable tests, and a
clean Greptile result. Inspect actual Greptile findings rather than trusting
command exit status; CI only counts once the branch is pushed.
