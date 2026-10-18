# #244 round 4 — code review at `ef32177` (Standards · Spec)

Base `1af565f` → head `ef32177`. Raw agent reports:
`.scratch/reviews/244/ef32177-code-review-standards.md`,
`ef32177-code-review-spec.md`.

## Standards

No documented-standard breach (AGENTS.md, docs/engineering-workflow.md, wisdom all
clean). Findings that mattered:

- **Stale identifier (blocker in an earlier round) — fixed.** The
  `withoutSubscripts` docstring cited the deleted `NORMALISED_VALUE` regex; it now
  points at `normalisesWholeValue`. The only remaining `NORMALISED_VALUE` mention
  is in a test comment describing the pre-fix behaviour, which is history, not a
  reference.
- **Duplicated Code, three lexers (judgement call) — accepted.** `scanSource`,
  `breaksStatement` and `normalisesWholeValue` each walk regions independently,
  and the docstring itself admits `normalisesWholeValue` still has the flat-quote
  bug round 4 fixed in `breaksStatement`. This is the same Divergent Change the
  approach answer targets; fixing it here would mean a fourth hand-rolled lexer,
  so it is deferred to the AST rewrite (`.scratch/implementation/244-round4-design.md`,
  "The approach question").
- **KNOWN CEILING — honest.** Verified line-by-line: flat quotes,
  `withoutSubscripts` quote-blindness, and regex literals in all three walks are
  stated; the two over-report boundaries are named as the safe direction.
- Minor: `normalisesWholeValue`'s parameter is named `receiver` though it holds the
  trimmed value — noted, not changed (no behaviour impact).

## Spec

- **Findings 1-5 all satisfied.** Each with a failing-first fixture or
  demonstration: `appended` (1), `joined`/`insideChain`/`privateField` (2),
  `nested` (3), `scope-shrink-guard-demo` CASE A/B (4),
  `concurrent-probe-demo` CASE A/B (5). Quote-level mapping is in each raw report;
  logs: `ef32177-ratchet-first-red.log`, `ef32177-round4-before.log`,
  `ef32177-scope-shrink-guard-demo.log`, `ef32177-concurrent-probe-demo.log`.
- **Findings 6-13 untouched.** No material scope creep.
- **Implemented but wrong:** none. Two documented over-reports (safe direction) are
  stated in the KNOWN CEILING and untested.
- **Approach answer:** present and concrete — "**the approach is the problem**",
  with a plan (one PR replacing the two regex passes with
  `ts.createSourceFile()` + an AST walk over `CallExpression` /
  `BinaryExpression` / declaration scopes), what would be lost (offset stability is
  recoverable from AST ranges; the synthetic matcher self-tests move to
  node-detection self-tests), and how the ratchet's falsifiability is preserved
  (same `CLASSIFIED` set, same failing-first fixtures ported; the regex matcher
  branches and their branch-pin proof are deleted last). The two loss-mitigations
  are a plan, not demonstrated code — appropriate, since the brief forbids starting
  the rewrite in this lane.

## Verdict

Standards: no blocker. Spec: no blocker, all five findings satisfied with
failing-first evidence, approach answer complete.
