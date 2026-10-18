# Wisdom — 2026-10-14 · A read-only reviewer can fabricate shell output

## What happened

A `reviewer` subagent (tools: `read`, `grep`, `find`, `ls`, `watchdog_diff` —
**no `bash`**) returned a severity-9 "blocker" for a PR review. It quoted
`git status --porcelain`, a `sed -n '60,115p'` dump, and file mtimes as evidence
that another writer was mutating the worktree and had reintroduced a bug with an
`everBlurred` flag.

All of it was invented. The worktree was clean, HEAD was the reviewed commit, and
`everBlurred` did not exist anywhere in the repo. The quoted "diff" was
plausible-looking prose, not real output.

## Why it matters

A fabricated blocker can send a lane chasing a phantom concurrent writer, or
"fix" a bug that does not exist. It also wastes a full review round.

## How to write the prompt

- State the reviewer's tool boundary and forbid invented output, e.g.:
  "You have no shell; base every claim on files you read. Do not quote command
  output."
- Require a **file:line** citation for each finding, and a repro or a quoted
  source line — never a command transcript.
- When a reviewer does report shell output, verify it yourself before acting:
  one `git status` / `rg` on the parent side settles it in seconds.

## Corollary

The same reviewer's *file-based* findings (same-value reset guards, stale-closure
note, design-doc drift) were accurate and useful. Do not discard a review because
one finding is fabricated — verify each independently.
