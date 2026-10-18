# #238 — code-review evidence (Standards + Spec)

- Fixed point / base: `2c8d867` (origin/develop). Reviewed HEAD: `7190e73`. Final HEAD: `09abea2`.
- Diff: `git diff 2c8d867...HEAD`. Two independent review sub-agents, read-only.

## Standards

**Hard violations**

1. **Over-claimed shared-helper docstring — fixed.** `amount-parse.ts` `draftBlank`
   said *"Every blankness guard and the reader it guards ask this one predicate"*.
   False: `resolveOpeningStock`, `supplier-opening-draft.ts:26`, the settle panels'
   amount guards and `amount-percentage-input.tsx:66` remain raw-`.trim()`. This is
   the exact failure `wisdom/2026-10-15-extraction-ordering-guard.md` names
   ("a shared helper's docstring must name the readers it covers … file the
   remaining gap"). **Fixed in `09abea2`**: the docstring names the sites the
   predicate reaches and lists the deferred gates; the design doc adds the same
   deferred list.

**Baseline smells (judgement calls)**

- Speculative generality — `nextUnitCost`'s explicit blank branch. Behaviour-preserving
  today; kept, with a docstring note that it is redundant with the current reader and
  exists to hold the cleared-field contract. Accepted.
- Primitive obsession (test) — string verdicts in the `SITES` table. Deliberate (one
  loopable table); accepted.
- Regex-class fragility — `[${PASTED_BIDI_MARKS.join("")}]` not escape-safe. **Fixed**
  in `09abea2`.
- e2e setup duplication — a local `quickAdd` in the new test. Accepted; matches the
  spec's existing inline pattern, and `saveQuickAdd` is the shared helper.

**Correct**: moving `draftBlank` out of `invoice-draft.ts` into `amount-parse.ts`
beside the normaliser is de-duplication with no behaviour change.

## Spec

- Everything in the four-site table is present and faithful (`percentageDraftInvalid`,
  `resolveInitialPaid`, `nextUnitCost`, `saleUnitPrice`/`saleOverrideInvalid`), the
  placement matches the brief, the interior refusal is honoured, and no performance
  or contract change was introduced.
- **Required evidence, per-site sequencing — noted.** The brief asks for "the failing
  test first … then the passing one" and "the unification diff, one site at a time".
  A lane commits once, so the red-first run and the per-site reasoning are recorded
  in the crew report and the test-audit evidence, not in git history. Disclosed.
- **"Extended/interior" axis — closed.** The interior case is now driven over the
  whole mark set, and the edge-with-digits case pins both Arabic-Indic digit scripts
  (was ASCII-only).
- **Process claim about a mutation proof in the design — now true.** The design's
  risk section pointed at an evidence file for the `nextUnitCost` ablation; that
  proof now exists in `09abea2-test-audit.md` (exact command + exit code).

**Totals:** Standards 1 hard violation (fixed) + 4 judgement calls (1 fixed, 3 accepted);
Spec 3 partials (1 closed, 2 disclosed/process). No unresolved hard violation at `09abea2`.
