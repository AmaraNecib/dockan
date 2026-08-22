# Ticket 01 — Greptile CLI review (waived locally)

- mode: local-only (no GitHub remote)
- outcome: `greptile review --exit-code` fails with "this repository does not have a Git remote configured"
- proof: the repo has no `origin`; the feature-implement skill's local-only rules forbid guessing a remote
- waiver recorded 2026-08-22: Greptile review is unavailable until a remote exists. It was not run against the base or an invented remote.
- compensation: oxlint with the anti-slop plugin (15 rules at error) is clean; the store seam has 14 tests; a manual code review pass was run (see code-review evidence) and its findings were fixed before this commit.
- re-run when: a remote gets configured, then redo greptile and compare against the current bases.