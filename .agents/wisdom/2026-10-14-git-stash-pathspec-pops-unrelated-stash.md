# Wisdom — 2026-10-14 · `git stash push -- <path>` with nothing to stash pops an unrelated stash

## What happened

A mutation check wanted to temporarily revert one committed file:

```bash
git stash push -- apps/web/src/pages/expenses.tsx && bun test ... ; git stash pop
```

The file had **no uncommitted changes**, so `git stash push` saved nothing (and
exited 0 in this git version). The `git stash pop` then popped the *only* stash
in the list — a months-old "local checkout state before syncing to develop" —
dumping ~100 staged files and four merge conflicts into a clean worktree.

## How to avoid it

- Before stashing a path for a mutation check, confirm the file is dirty:
  `git status --porcelain -- <path>` must be non-empty.
- Prefer a reversible in-place edit for mutation checks on committed files:
  `cp file file.bak`, edit, test, `cp file.bak file` (or `git checkout -- file`).
  No stash involved.
- If you must stash, record the stash ref:
  `git stash push -m tmp -- <path>` then `git stash pop stash@{0}` only after
  `git stash list` shows the expected message at `stash@{0}`.

## Recovery

`git reset --hard HEAD` discards the popped-but-conflicted application; the
original stash stays in the list (a conflicted `pop` does not drop it). Save the
patch first (`git stash show -p stash@{0} > /tmp/old.patch`) before resetting, in
case it is needed.
