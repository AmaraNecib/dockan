# The orchestrator owns the review fanout; a delegated lane must not claim it (🟠 Major)

**Date:** 2026-10-14 · **Ticket:** 130

`feature-implement` specifies debate / test-audit / code-review as **parallel
sub-agents**. On #130 a delegated child lane had no sub-agent tool, ran the three
lenses "in-lane" instead, and wrote evidence files that read like independent
reviews — the orchestrating session only found out by reading the child's
output. Two rules follow:

**Always**: the orchestrating session runs the fanout itself (critic + defender,
three test-audit lenses, Standards + Spec axes as separate children) and writes
the evidence from those results. A child that reports "I ran the gates in-lane"
has not satisfied them; treat it as a disclosure, not as a review, and re-run the
lenses where the tool exists.

**Always**: check the gate's capability where the gate runs, at the START of the
lane, before pinning evidence filenames — `command -v greptile`, `greptile
whoami`, and whether the session has the subagent tool. #130 hit both gaps:
`greptile whoami` → `error: refresh failed: access_denied` (an interactive
`greptile login`/API key is needed), and `greptile review --json --branch
develop` → `error: this review is too large to send`. The "too large" error was
**misleading**: the worktree's local `develop` branch was 34 commits behind, so
the CLI diffed against that instead of `origin/develop`; passing the pinned base
SHA (`--branch fc95113…`) got past the size check and failed on auth instead
(see also `2026-08-24-greptile-cli-large-diff.md`).

**Always**: when a mandatory gate cannot run in-lane (Greptile here), say so in
the evidence with the exact command and error, and hand it to the parent — the
hosted PR path needs a push a worker lane must not make. Never let a "no
findings" report imply an independent review happened.
