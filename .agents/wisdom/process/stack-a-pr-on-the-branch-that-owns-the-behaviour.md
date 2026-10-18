# A test that asserts another PR's behaviour puts the PR on that PR's branch

**Date:** 2026-10-18 · **Ticket:** 276 · **Area:** e2e, stacked PRs, merge order

PR #285 added an e2e case whose first assertion was:

```ts
expect(refusalBody).toContain("VAULT_LOCKED_BY_OTHER_INSTANCE");   // tests/e2e/vault.spec.ts:331
```

Its base was `develop`, which answers `/api/vault/status` through `app.all("*")` with an HTML page
(`lock.ts:462`). The string could not appear, so the job failed: `1 failed, 100 passed (6.7m)`.

The failure was read by a reviewer before CI ran, from the source alone. It is a merge-order defect,
not a code defect, and it has one cheap fix: base the PR on the branch that owns the behaviour.

```bash
git rebase origin/fix-275-vault-lock-liveness
gh pr edit 285 --base fix-275-vault-lock-liveness
```

After the rebase the diff was **byte-identical** (same 6 files, +243/-22) and the same job passed
(`8m13s`). Nothing about the change itself had been wrong.

**The rule:** if a PR's new test asserts a wire contract, response shape, or UI state that another
open PR introduces, the PR belongs on that PR's branch. `gh pr edit --base` keeps the three-dot diff
clean as the parent branch advances, so a stack costs nothing at review time.

**The trap:** CI cannot tell you *why* a fresh test fails when its base lacks the behaviour. The
temptation is to weaken the assertion or delete the case, and both of those remove the check that
makes the PR worth merging. Read the failure as a dependency and stack instead.

**Counter-check before stacking:** confirm the parent branch really does provide it. One command
settles it, and guessing the other way costs a full CI cycle:

```bash
git show origin/fix-275-vault-lock-liveness:apps/api/src/lib/vault/lock.ts | grep -n "api/vault/status"
```
