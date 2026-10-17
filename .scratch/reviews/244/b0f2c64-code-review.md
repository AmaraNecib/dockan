# #244 round 3 — code review (Standards + Spec)

Fixed point: the round-3 head **`9219369`** (diff
`9219369-round3-diff.txt`, regenerated for the final SHA as
`b0f2c64-round3-diff.txt`). Fixes committed in **`b0f2c64`**. Both axes ran as
separate read-only sub-agents with no shell; findings are `path:line` citations.

## Standards

**Findings: 2 (worst: minor).**

- **[minor] Duplicated Code — a third ad-hoc bracket-depth scanner.**
  `withoutSubscripts` (`apps/web/src/tests/blankness-gates.ts`) re-implements
  `[`/`]` depth tracking that already exists in `breaksStatement`
  (`OPENERS`/`CLOSERS`) and in `scanSource`'s brace pass. Three places now encode
  bracket semantics, so a bracket-rule change is Shotgun Surgery across all
  three. *Judgement call.* Disposition: **accepted, documented** — the three
  scans have different jobs (subscripts, statement breaks, interpolation
  regions); merging them would couple unrelated passes for no correctness gain,
  and the file already documents its boundaries. No repo standard requires it.
- **[nit] Formatting inconsistency** — `scanSource`'s closing brace runs into
  `const collapse` with no blank line, and deleting `bracePairs` left a double
  blank line. **Fixed** in `b0f2c64`.

No documented-standard violation. `docs/engineering-workflow.md`'s "TDD;
Playwright E2E for user-facing flows" is satisfied. The "say the ceiling, do not
imply otherwise" convention is honoured — and one stale justification was found
and corrected: the `KNOWN CEILING` note claimed blanking template TEXT was
rejected because it "would also hide a real gate inside a `${}` expression".
After this change that reason is false (the `${}` half is code either way), so
the comment now states the real position: TEXT is still scanned (a no-change from
round 2) and blanking it is a deferred improvement. oxlint/tsc-enforced rules
skipped per instruction.

## Spec

**Findings: 4 (worst: major).**

- **[major] The review artifact was incomplete.** The first
  `9219369-round3-diff.txt` was generated with a pathspec that dropped
  `.scratch/`, so finding 3's fix (both proof scripts) and the new
  `proof-baseline-guard-demo.sh` were invisible to the reviewers, and the context
  note "the only new code" was wrong. **Fixed**: `b0f2c64-round3-diff.txt` is the
  full `92f40d0...HEAD` diff (900 lines, all paths).
- **[minor] Finding 3 is implemented but was not in the shown diff** — the
  reviewer verified it directly at `390da2d-mutation-proof.sh:78-85` and
  `branch-pin-proof.sh:26-34`. Confirmed; also strengthened in `b0f2c64`.
- **[minor] No round-3 ceiling statement in the report.** The brief allows a
  stated ceiling; findings 1-4 are all closed, so the only ceilings are the
  pre-existing ones plus three additions. **Disposition: stated** — in
  `b0f2c64-debate.md` (Residual ceilings), in the script headers, and in the
  scanner doc. Nothing is omitted silently.
- **[nit] Uncommitted drift** (` M .scratch/reviews/244/mutation-proof-guard-demo.sh`)
  against the brief's "commit only". **Fixed** — committed in `b0f2c64`.
- **Scope creep: none.** The diff touches only findings 1/2 (`blankness-gates.ts`,
  `blankness-ratchet.test.ts`), finding 4 (`tests/e2e/blankness-mark-only.spec.ts`)
  and the finding-3 harnesses. **Findings 5-8 are not reworked**, as the brief
  requires.

## Summary

Standards: 2 findings, worst = duplicated bracket-depth logic (minor, accepted
with a stated reason). Spec: 4 findings, worst = the incomplete review artifact
(major, fixed). No blocker on either axis.
