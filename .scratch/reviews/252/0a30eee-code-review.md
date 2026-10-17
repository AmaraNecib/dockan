# #252 — code review (Standards + Spec axes)

Reviewed lane HEAD: **0a30eee** (`test(web): close the round-3 notes on the guard and
the WE_OWE submit path (#252)`). Lane commits: `fd19ddd`, `605f8c3`, `4458560`,
`0a30eee`, all against base `d843566`.

Rounds ran as separate read-only sub-agents (5 lenses per round, round 4 with 3).
Lane HEAD `0a30eee` was reviewed by the final round; the round-1/2/3 reports are kept
because their findings are what the later commits answer.

## Round 1 — `fd19ddd` (Standards + Spec)

**Standards.** Correct: sign path untouched, tests pin label-to-VALUE, the guard
carries its own mutation. Hard findings:
1. `CONTEXT.md`'s Adjustment glossary still documented the SWAPPED mapping while
   the diff shipped the confirmed one — the repo's canonical domain doc contradicted
   the labels.
2. `.scratch/reviews/252/playwright.evidence.config.ts` said "not committed" while
   being committed.

Judgement calls: the api comment-only edits widen a web bug into `apps/api` (kept —
they re-teach the mapping otherwise); `supplierDirectionKey` left a second
hand-written reading at the option labels and the credit columns; `walkTsx`
duplicated `cell-ltr.test.ts`.

**Spec.** All three acceptance criteria verified. Notes: the "one map" claim was
weaker than the code; the e2e spec was not run under a mutation; the brief's
sibling-calque premise is stale on this base.

Disposition: **all applied in `605f8c3`**.

## Round 2 — `605f8c3` (Standards + Spec + 3 test-audit lenses)

**Standards.** Round-1 findings closed, plus a BLOCKER: the evidence logs carried no
SHA and predated the reviewed HEAD (`docs/engineering-workflow.md`: "Evidence
filenames must contain the exact reviewed HEAD SHA"). Also: the guard let
`items={[]}`/`items={undefined}` through; a nested `<Select>` root would be blamed
for a nested root's trigger; the tree scan could pass vacuously.

**Test audit.** Edge cases: `items={[] as const}` / `items={EMPTY}` /
`items={(undefined)}` escaped; the «يسالنا» panel button's `onClick` was unpinned;
the positive-control counted roots without a `SelectValue`; the debts test was an
index-zip of two independently-queried lists. Coverage: every criterion had a
revert-failing test at 4 layers; the guard only proved an `items` prop exists.
Quality: grade B+, mutation script was evidence rather than a gate (no
try/finally, did not fail on a non-reddening mutation).

**Spec.** Criteria met; the calque audit was answered in the commit body but had no
recorded finding; CONTEXT.md/api comment edits flagged as disclosed scope creep.

Disposition: **all applied in `4458560`**, except the calque audit, which is now a
recorded section in `.scratch/implementation/252-design.md`.

## Round 3 — `4458560` (Standards + Spec + 3 test-audit lenses)

**Standards.** (b)(c)(d) closed. (a) still open at review time: no evidence file
carried the reviewed SHA and the mutation log predated its commit. No new
violations. Notes: `emptyArrayBindings` is scope-blind (false positives only);
`labelsAreRawValues` missed quoted property names and template literals; the floor
is brittle if roots are removed; the log's mutation IDs printed out of order.

**Spec.** No blocker. One open note: acceptance 2's "and that selecting it submits
`WE_OWE`" was pinned only on the adjust panel's buttons, not the bulk screen; the
calque audit is now recorded and re-verified.

Disposition: **applied in `0a30eee`** (guard quoted keys + `items={{}}` cases and the
documented limits; the WE_OWE submit test on the bulk screen; the design doc's audit
section; mutation IDs reordered; the SHA-named evidence set).

## Round 4 — `0a30eee` (final: Standards + Spec + test audit)

**Standards — `0a30eee`.** Finding (a) resolved: "Final-SHA set exists, one per
gate, all named `0a30eee-<gate>.log` … all mtimes post-date commit `0a30eee`".
Contents are HEAD-specific, not recycled (`0a30eee-web-affected-green.log` carries
the new WE_OWE submit test; tail 106 pass / 0 fail). No hard breach in the round-4
delta. Notes: the `0a30eee-*` logs were untracked at review time (committed in the
evidence commit); three `evidence/4458560-*.log` files had mtimes before `4458560`
— "mislabeled prior-SHA evidence" (deleted rather than left mislabeled, see the
design doc's evidence-naming note); `252-design.md` attributed the SHA-naming fix to
`4458560` while it was closed later (wording corrected).

**Spec — `0a30eee`.** "Verdict: lane is complete; one unrecorded out-of-scope note
(owner decision), no blockers." Acceptance 1 pinned at `i18n.ts:929-930`; acceptance
2 pinned at the bulk screen for both directions (`:471` WE_OWE label, `:486-498`
THEY_OWE submit, `:522` WE_OWE submit); acceptance 3 by the AST guard plus
`directionItems` on every trigger-bearing `Select`. Also in scope: the value/label
binding is fixed and `asDirection` is intentionally unchanged; the calque audit is
recorded; the stored 100,000 row is untouched. Note: the new test's submit assertion
alone would not catch a no-op handler (the value equals the default) — the
intermediate label assertions at `:513`/`:515` are what pin it; the docblock's
"moved off the default first" is accurate about the mechanism.

**Test audit — `0a30eee`.** "Verdict: don't block. All 16 mutations redden on HEAD."
Round-3 notes closed: the scope-blind binding is documented in the docblock; quoted
property names are read and M15 reddens; the floor comment states the current count
(27); the WE_OWE submit test is discriminating (moves the row off the default
first). Acceptance coverage is multi-layer (AC1: M1/M2/M5; AC2: M10/M16; AC3:
M3/M4/M6/M7/M11/M12/M14/M15) with the mutation table as independent confirmation.
Still worth knowing (all low, all recorded): the `items={{}}` branch has no
dedicated mutation (covered by analogy); the guard boundary is unchanged; the
`directionItems` array is rebuilt per render; the evidence-file mtimes noted above.

## Verdict

Standards: 0 hard violations at `0a30eee`; 3 low judgement-call notes, all recorded.
Spec: all three acceptance criteria and both "also in scope" audit items satisfied;
the stored-row decision is correctly left to the owner.

Worst issue within each axis: Standards — the mislabeled intermediate evidence logs
(the reviewed set is now correct and the mislabeled ones are gone); Spec — none.
