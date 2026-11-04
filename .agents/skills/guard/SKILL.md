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

Run the local checks below for Phase 2. The red-on-parent replay runs only in the PR `checks` job and must pass before merge. Parents, workers (including nested subagents), reviewers and hooks must not run or delegate it locally. Missing local replay output does not block review, push or report acceptance. Ordinary failing-first TDD, focused regression tests and applicable current-head mutation checks remain required; follow [What counts as failing-first](../../../docs/verification-and-merge-gate.md#what-counts-as-failing-first). Only the actual-PR parent replay is CI-only.

Distinguish the **PR red-on-parent gate** from **replay-tool self-tests**. The CI-only rule applies to replaying the actual branch against its parent for acceptance. The regular unit suite includes tests such as `scripts/red-on-parent.test.ts` that exercise the replay engine in small temporary fixture repositories with separate caches and cleanup. Those self-tests may run locally through the normal test queue; their output is not PR parent-replay acceptance evidence.

#### Browser verification: selector first

For a browser-relevant change, commit the complete PR scope, then inspect the selector before starting a browser run:

```bash
bun scripts/e2e-changed.ts --dry-run [--base <PR-base-ref>]
```

Use the actual PR base ref. A normal PR uses `origin/develop`; a stacked PR uses the branch named as that PR's base, not `origin/develop`. The local selector compares `merge-base(base, HEAD)..HEAD`. CI also diffs from a merge base, using the event's base and head SHAs, and falls back to the event's base SHA if merge-base fails. Local refs can resolve to different commits from those event SHAs. CI additionally forces full runs for push, dispatch and the `e2e:full` label. The checked-in selection map is shared; base inputs, failure handling and overrides can differ. CI remains the merge gate.

Save post-commit evidence in `.scratch/reviews/<issue-id>/<head-sha>-verification.md`. Record the exact `mode=`, `specs=`, `reason=`, and `source=` lines, plus the full `HEAD` SHA and base ref/SHA, run command, exit code and artifact paths, or the selector's skip decision. Record any reason for repeating a completed run there too. Do not make an evidence-only commit; hand the path and verified SHA to the parent for PR publication. Accept `affected` or `skip` only when the committed HEAD contains the complete PR scope and no reviewable tracked or untracked changes remain. The selector warns about dirty tracked files but does not include their edits; untracked files are not included. Resolve those changes into commits, then inspect the dry run again. `--files` bypasses Git and cannot prove complete PR scope, so it is never acceptance evidence.

Follow the map without changing it: `affected` means run exactly the listed specs, `full` means run the full suite and retain the selector's reason, and `skip` means no browser run. An unmapped or critical path must stay `full`. Focused TDD or a reproducer remains useful, but does not replace verification of the selected scope. Route actual browser runs through `heavy_run` with the isolated `DOKAN_PORT`, `DOKAN_WEB_PORT`, `DOKAN_VAULT_PORT` and `DOKAN_VAULT_WEB_PORT`; the dry run needs no slot. Do not repeat a completed run for the same unchanged scope unless a specific need is recorded. The full suite and web build also take a heavy slot.

```
[ ] bun run typecheck — passes?
[ ] bun run lint — 0 errors?
[ ] bun run skills:check — the .claude/skills mirror matches .agents/skills?
[ ] bun run test — the full suite passes (turbo + scripts/ + tools/)
[ ] bun run --filter @dokan/web build — the production bundle builds?
[ ] bun audit --audit-level=high — no high/critical advisory?
[ ] Browser verification follows "Browser verification: selector first" above; preserve the selector contract and evidence for the selected scope
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
During the trial, use the [comparison protocol](../../../docs/review-comparison.md)
until the owner chooses which review path to keep. A local-only report is not
merge-readiness while the hosted verdict is missing.

```
[ ] Local checks green (typecheck, lint, tests, e2e when relevant, Rust when relevant)
[ ] Review evidence current for the selected tier
[ ] Both current-head reviews are 5/5 with no actionable findings while the trial is active; a missing verdict blocks merge-readiness
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
