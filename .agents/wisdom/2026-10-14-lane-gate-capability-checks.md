# Check lane capability before promising a mandatory gate (🟡 Major)

Two `feature-implement` gates could not be satisfied from a worker lane on 2026-10-14, and both
had to be disclosed in the evidence rather than silently skipped:

1. **Review fanout** (debate / test-audit / code-review are specified as parallel sub-agents): the
   lane's toolset had no sub-agent tool. The lenses were run in-lane instead, and the evidence
   files say so explicitly, including which round was reviewed at which SHA.
2. **Greptile** (guard Phase 2/3 "never skip"): `greptile whoami` → `error: refresh failed:
   access_denied`, so an interactive `greptile login` (browser URL) is required; and
   `greptile review --json --branch develop` → `error: this review is too large to send` even for a
   6-file diff, the trap already recorded in `2026-08-24-greptile-cli-large-diff.md`.

**Always**: check `command -v greptile && greptile whoami` at the START of a lane, before the
evidence filenames are pinned. If auth is broken or the fanout tool is missing, say so in the
evidence and hand the gate to the parent (the hosted PR path needs a push the lane must not make)
— do not let a "no findings" report imply an independent review happened.
