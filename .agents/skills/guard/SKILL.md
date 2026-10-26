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

This is the gate before the review round and before any push. It never pushes by
itself. The parent's push runs the Husky pre-push hook when the hook is available.

**Run the CI `checks` job locally, not a subset of it.** A green focused test plus
typecheck is step 1, not this gate. The full suite and the web build take a heavy
slot (`bun tools/heavy-slot/heavy-slot.ts run "<label>" "<command>"`).

```
[ ] bun run typecheck — passes?
[ ] bun run lint — 0 errors?
[ ] bun run skills:check — the .claude/skills mirror matches .agents/skills?
[ ] bun run test — the full suite passes (turbo + scripts/ + tools/)
[ ] bun run --filter @dokan/web build — the production bundle builds?
[ ] bun audit --audit-level=high — no high/critical advisory?
[ ] bun scripts/red-on-parent.ts --base <base> — every test file this change
      **adds** fails on the parent, or carries a `red-on-parent-waive` line. New
      files only; edited test files are not gated. A wrong-reason red (the file
      cannot load on the parent) fails the gate, and so does a waiver on a test
      that is already red. So does a test the change registers and the parent's
      run never reports (`NOT ON PARENT`), and a run that did not finish
      (`RUN INCOMPLETE` — no waiver covers a missing result).
[ ] bun run test:e2e — passes? (only when the selector says the diff reaches a
      spec, or the change touches a UI flow)
[ ] git status — working tree clean?
[ ] No push, no PR and no merge — those are parent-only (`feature-implement` step 10, Merge rules)
```

A red check that cannot come from this change (an advisory in a dependency the
diff does not touch, a suite that is red on `develop`) is still a red push. Record
it with the evidence and take it to the owner; do not call the branch green
because the failure is "not ours".

### Review evidence checks

Evidence files are LOCAL artifacts: `.scratch/reviews/` is gitignored, the reports are
never committed, and a PR carries a summary comment instead of the files. Check them
where they are, on disk, next to the worktree.

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
[ ] Evidence exists for every lens the round ran, and none is stale
[ ] A scoped round of one or two lenses is allowed when the change touches one
      axis; the payload records exactly what ran, and three stays the default
[ ] The reviewloop payload renders, and its score is the rule's score or lower
```

**High-assurance** (auth/RBAC, backup/restore, invoice and debt money math, a schema-version bump):
```
[ ] All three lenses ran: debate, test-audit and code-review
[ ] Every evidence file exists and is not stale
[ ] The reviewloop payload renders, and its score is the rule's score or lower
```

## Phase 3 — Pre-report

Run before the parent reports a local handoff or remote merge-readiness.

```
[ ] Local checks green (typecheck, lint, tests, e2e when relevant, Rust when relevant)
[ ] Review evidence current for the selected tier
[ ] reviewloop result is for the final HEAD and has no actionable findings (while the Greptile A/B runs, Greptile agrees)
[ ] CI — required checks green on GitHub (when the branch is pushed)
[ ] The push and the PR came from the parent, and the merge followed the gate's classes — a cheap-to-reverse, no-decision diff merges itself once green, an expensive-to-reverse or decision diff waits for the owner
[ ] PR description — accurate and complete
[ ] Any deferred items — documented with follow-up issues
[ ] (Parent) Wisdom — captured only if the pattern repeated; lanes report lessons and never write `.agents/wisdom/`
```

## When a check fails

1. Report to the user what failed and why
2. Do not proceed past the failing check
3. If the user explicitly says "skip it" after being informed of the risk,
   note the waiver and continue.
4. If the user says "fix it", fix it and re-run the check.

**Mandatory gates (never skip):** typecheck, lint, applicable tests, and a
clean reviewloop result. Inspect the actual findings rather than trusting
command exit status; CI only counts once the branch is pushed.
