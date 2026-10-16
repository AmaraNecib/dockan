# #244 round-3 review context (HEAD `b0f2c64`)

You have **no shell**. Every claim must come from a file you read, cited as
`path:line`. Do not quote command output and do not invent it. If you cannot
verify something, say "unverified".

## What this is

Dokan, `fix-244-blankness-ratchet`, PR #246, review round 3. The PR adds
`apps/web/src/tests/blankness-gates.ts` (a source scanner) + a ratchet test that
forces every raw `.trim()` blankness gate in the numeric-reader surface to be
classified, plus the conversions of those gates to `draftBlank`. Tier:
**High-assurance** (the conversions decide blank-vs-chosen for money/stock
numeric drafts; failure modes 1-3 in `docs/engineering-workflow.md`).

- Base (merge-base with develop): `746ff933` — full PR diff:
  `.scratch/reviews/244/b0f2c64-pr-diff.txt`
- Round-2 head: `92f40d0` — round-3 diff (the only new code):
  `.scratch/reviews/244/b0f2c64-round3-diff.txt`
- Brief: `.scratch/reviews/244/b0f2c64-brief.md` (the specification).

## The four round-3 findings and what changed

1. `${...}` was text to `stripComments`/`bracePairs` but code to
   `collectDeclarations`: a comment inside `${}` split a gate, and an inner
   normalised declaration inside `${}` hid an outer raw check. Fix: one
   `scanSource` pass treats `${...}` as code in both; template TEXT stays
   verbatim.
2. `NORMALISED` skipped a declaration when a normaliser appeared anywhere in its
   receiver, so `drafts[normalizeArabicIndicDigits(id)].trim()` (raw value,
   normalised KEY) was skipped. Fix: `withoutSubscripts` strips `[...]` groups
   before the test.
3. The proof scripts accepted any non-zero test exit as a detection. Fix: both
   require a green unmutated baseline and a real failing test (the expected
   assertion for the mutation proof; ≥1 `(fail)` line for branch-pin).
4. The e2e asserted the form reset, not the stored value. Fix: reload, reopen the
   saved item, assert `edit-threshold` is `5`.

## Evidence you may read (read-only)

- `.scratch/reviews/244/b0f2c64-ratchet-first-red.log` (new fixtures red on the pre-fix scanner)
- `.scratch/reviews/244/b0f2c64-ratchet-green.log`
- `.scratch/reviews/244/b0f2c64-mutation-proof.log` (green baseline + expected assertion)
- `.scratch/reviews/244/b0f2c64-branch-pin-proof.log`
- `.scratch/reviews/244/b0f2c64-gate-set-diff.log` (`ADDED []` / `REMOVED []`, 32 gates)
- `.scratch/reviews/244/b0f2c64-guard-demo.log` (old false passes vs new refusals)
- `.scratch/reviews/244/b0f2c64-e2e-mark-only.log`,
  `.scratch/reviews/244/b0f2c64-e2e-discrimination.log`
- `.scratch/reviews/244/b0f2c64-round3-diff.txt`, `b0f2c64-pr-diff.txt`
- `.scratch/implementation/244-design.md`
- `.agents/wisdom/README.md` and the lessons in `.agents/wisdom/`

## Report format (≤ 45 lines)

```
VERDICT: pass | findings
SEVERITY: blocker | major | minor | nit (per finding)
FINDINGS:
- [severity] path:line — what is wrong, and the smallest fix
CEILING / UNVERIFIED:
- what you could not check, and why
LESSONS APPLIED:
- .agents/wisdom/<file>.md — how it bears on this diff (and which you deliberately did NOT apply)
```

Judge the code as it is on disk, not as the PR text claims it is.
