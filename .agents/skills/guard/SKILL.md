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

Use the absolute worktree path and pin base, head and tree. Check free space before installs or heavy work. Use unique output paths and preserve shell quoting. Stream logs to durable files while commands run; classify each result as passed, failed, error, timeout or running. A live process is not proof of progress: inspect output, descendants and progress before waiting again. Use actual command output for discovery and counts, never embedded expected values. Queue suites, builds and browser runs through `heavy_run`; an unknown holder is not proof all slots are full, so check `heavy_status`. Keep no-blind-kill and no-duplicate-run rules: confirm cancellation before another writer starts, and inspect the live job's durable results before a rerun. `gh` commands are allowed here; if `gh repo view` fails because there is no remote, use Git checks and report that limit.

## Phase 1 — Pre-commit

Before a commit, run the focused test for changed behavior and direct callers, plus relevant typecheck, lint and generated-file checks. Do not run full suites, full browser tests, builds or audits per commit. The Husky hook separately runs `scripts/contracts-source-guard.ts`, `bun run lint`, `bun run skills:check` and `cd apps/api && bunx tsc --noEmit`; keep those checks intact.

If the change touches Rust Core (`apps/desktop/src-tauri/src/`), keep the following checks before activation. After activation, run focused Rust tests for the changed behavior and direct callers, plus applicable clippy checks. Full crate tests are CI-final unless a concrete uncertainty or coverage gap requires them locally.
```
[ ] cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml — passes?
[ ] cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -- -D warnings — clean?
```

## Phase 2 — Pre-review / pre-push

This is the local gate after local review and before any push or hosted review.
Hosted review is not a pre-push or worker-handoff prerequisite; it starts after
publication. Phase 2 never pushes by itself. The parent's push runs the Husky
pre-push hook when the hook is available.

Run focused local verification for changed behavior and direct callers, plus relevant typecheck, lint and generated-file checks. Add a build when the change affects bundling, imports, configuration or packaging. Run browser tests only when UI behavior, focus, navigation, rendering or a browser-specific failure needs proof; inspect the selector first. Keep targeted integration and negative tests for money, security and recovery contracts. The full repository unit suite, full browser suite, production build and audit are CI-final checks unless a concrete uncertainty or CI coverage gap requires a local run. Do not use a test count as evidence of quality. Tests must detect a named reachable failure with an independent expected result; before weakening one, name the surviving test and prove it detects the same failure.

The risk-sized local policy activates only after the parent verifies that GitHub requires the stable `CI acceptance` check on the current PR head, including administrator enforcement, with recorded owner acceptance of the bypass policy. The parent documents effective rules but cannot accept bypass on the owner's behalf. Until then, other PRs retain the existing Phase 2 baseline. The policy PR itself may publish after focused proof and review while its new check is pending; it cannot merge or activate the policy until the parent records remote enforcement evidence and the owner's bypass acceptance. Report local readiness, pending CI and CI acceptance as separate states.

The red-on-parent replay runs only in the PR `checks` job and must pass before merge. Parents, workers (including nested subagents), reviewers and hooks must not run or delegate it locally. Missing local replay output does not block review, push or report acceptance. Ordinary failing-first TDD, focused regression tests and applicable current-head mutation checks remain required; follow [What counts as failing-first](../../../docs/verification-and-merge-gate.md#what-counts-as-failing-first). Only the actual-PR parent replay is CI-only.

Distinguish the **PR red-on-parent gate** from **replay-tool self-tests**. The CI-only rule applies to replaying the actual branch against its parent for acceptance. The regular unit suite includes tests such as `scripts/red-on-parent.test.ts` that exercise the replay engine in small temporary fixture repositories with separate caches and cleanup. Those self-tests may run locally through the normal test queue; their output is not PR parent-replay acceptance evidence.

#### Before activation

For other PRs, retain this local baseline until required-check enforcement and bypass verification are recorded:

```bash
bun run typecheck
bun run lint
bun run skills:check
bun run test
bun run --filter @dokan/web build
bun audit --audit-level=high
```

Queue the full suite and build. Browser checks follow the selector procedure below; Rust changes retain their required checks. This policy PR is the narrow bootstrap exception: run focused policy tests, relevant typecheck/lint/generated checks and the one local review; publish with CI acceptance pending so the parent can establish the required check. Never treat that pending state as merge-ready or activation evidence. The actual-PR parent replay stays CI-only. After the parent records enforcement and owner bypass acceptance, use the risk-sized local checks above rather than duplicating CI.

#### Browser verification: selector first

For a browser-relevant change, commit the complete PR scope, then inspect the selector before starting a browser run:

```bash
bun scripts/e2e-changed.ts --dry-run [--base <PR-base-ref>]
```

Use the actual PR base ref. A normal PR uses `origin/develop`; a stacked PR uses the branch named as that PR's base, not `origin/develop`. The local selector compares `merge-base(base, HEAD)..HEAD`. CI also diffs from a merge base, using the event's base and head SHAs, and falls back to the event's base SHA if merge-base fails. Local refs can resolve to different commits from those event SHAs. CI additionally forces full runs for push, dispatch and the `e2e:full` label. The checked-in selection map is shared; base inputs, failure handling and overrides can differ. CI remains the merge gate.

Save post-commit evidence in `.scratch/reviews/<issue-id>/<head-sha>-verification.md`. Record the exact `mode=`, `specs=`, `reason=`, and `source=` lines, plus the full `HEAD` SHA and base ref/SHA, run command, exit code and artifact paths, or the selector's skip decision. Record any reason for repeating a completed run there too. Do not make an evidence-only commit; hand the path and verified SHA to the parent for PR publication. Accept `affected` or `skip` only when the committed HEAD contains the complete PR scope and no reviewable tracked or untracked changes remain. The selector warns about dirty tracked files but does not include their edits; untracked files are not included. Resolve those changes into commits, then inspect the dry run again. `--files` bypasses Git and cannot prove complete PR scope, so it is never acceptance evidence.

Follow the map without changing it. After activation, the selector defines CI scope, not a mandatory local full run. Record its decision even when local browser proof is unnecessary. Run local browser cases for the changed behavior or a concrete CI coverage gap; record why those cases suffice and which remaining scope CI must verify. Before activation, `affected` means run exactly the listed specs, `full` means run the full suite and retain the selector's reason, and `skip` means no browser run. An unmapped or critical path must stay `full` in the selector; CI's selected-scope gate is unchanged. Route actual browser runs through `heavy_run` with the isolated `DOKAN_PORT`, `DOKAN_WEB_PORT`, `DOKAN_VAULT_PORT` and `DOKAN_VAULT_WEB_PORT`; the dry run needs no slot. Do not repeat a completed run for the same unchanged scope unless a specific need is recorded. The full suite and web build also take a heavy slot.

```
[ ] bun run typecheck — passes?
[ ] bun run lint — 0 errors?
[ ] bun run skills:check — the .claude/skills mirror matches .agents/skills?
[ ] Focused regression tests cover changed behavior and direct affected integrations; full repository suites are CI-final after activation
[ ] Build and audit run locally when the change's risk or dependency scope requires them; otherwise CI-final owns these checks after activation
[ ] Browser verification follows "Browser verification: selector first" above; preserve the selector contract and evidence for the selected scope
[ ] The worktree must be clean before handoff or publication
[ ] Local status is recorded separately from CI acceptance; no local result implies CI accepted or merge-ready
[ ] Until owner activation is recorded, retain existing Phase 2 requirements and report the gate pending
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

**Reviewable changes** follow the risk and bounded-fix policy in [`docs/engineering-workflow.md`](../../../docs/engineering-workflow.md#review-tiers). Check exact base/head, actual reviewer session and model, provenance and report. Reuse valid exact-tree evidence. Require reviewloop 5/5 with no unresolved actionable findings; this is true even when the renderer's score calculation omits a P2.

Routine changes need one focused code-review execution covering Standards, Spec and affected-test adequacy. Record skipped lenses with reasons in the existing payload. High-assurance needs three separate initial sessions. After a bounded fix, one fresh reviewer checks the combined delta and affected callers, explicitly carrying forward unchanged conclusions; reopen another lens only for a new concrete risk. Never demand an automatic full restart.

## Phase 3 — Pre-report

Run before the parent reports a local handoff or remote merge-readiness. Phase 3 validates existing Phase 1/2 results and current-head review evidence; it does not rerun unchanged checks. Reuse only results whose input tree and command match the committed head. For a local worker handoff, report hosted review and CI as pending, not failed or passed. A local-only report is not merge-readiness; CI acceptance and the [paired hosted-review gate](../../../docs/review-comparison.md) remain parent-owned. Until the owner explicitly ends that trial, both current-head verdicts must be 5/5 with no unresolved actionable findings; a missing hosted verdict blocks merge. Request Greptile once per pushed head, never repeatedly for the same head.

```
[ ] Guard Phase 1/2 evidence matches the committed input tree and required commands; no automatic duplicate run
[ ] Local review evidence is current for the selected risk depth; exact-head provenance is verified
[ ] For merge-readiness after publication: CI acceptance is green on the current head, required-check enforcement and owner bypass acceptance are recorded, both trial verdicts are 5/5, and no actionable finding remains
[ ] CI — required checks green on GitHub (when the branch is pushed)
[ ] The push and the PR came from the parent, and the merge followed the gate's classes — a cheap-to-reverse, no-decision diff merges itself once green, an expensive-to-reverse or decision diff waits for the owner
[ ] PR description — accurate and complete
[ ] Only reviewer-accepted nonblocking follow-ups are deferred, with issue links; no valid blocker is deferred
[ ] (Parent) Wisdom — captured only if the pattern repeated; lanes report lessons and never write `.agents/wisdom/`
```

## When a check fails

1. Report the command, input tree and state: passed, failed, error, timed out or still running
2. Do not turn missing evidence, an error or a timeout into a pass; do not proceed past a failed check
3. If the user explicitly says "skip it" after being informed of the risk,
   note the waiver and continue.
4. If the user says "fix it", fix it and re-run the check.

**Mandatory gates (never skip):** relevant typecheck, lint, applicable tests, a clean reviewloop 5/5, no unresolved actionable finding, and enforced CI acceptance before merge. Inspect findings rather than trusting command exit status. CI counts only after the branch is pushed.
