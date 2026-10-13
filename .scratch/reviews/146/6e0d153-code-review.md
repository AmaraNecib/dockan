# #146 code review evidence (Standards axis, Spec axis)

- **Issue:** #146, one invoice-draft module behind the sale and purchase screens
- **Tier:** Standard
- **Base SHA:** `fc951133134a9b0b18b5ae38f9658665c29e73ec` (`origin/develop`, merge-base)
- **Evidence HEAD:** `6e0d153059a8d0197e62a67cdec2ac9a651509d2`
- **Diff:** `git diff fc95113...6e0d153` (12 files)
- **Provenance:** round 1 reviewed `6c6e9f4`; round 2 reviewed `e231b47`. Both
  rounds ran a Standards child and a Spec child in parallel with no write access.
  The accepted findings were applied in `6e0d153`, which is the HEAD this file is
  named for. No reviewable file changed after `6e0d153`.

## Standards axis

Standards sources read: `docs/engineering-workflow.md`,
`.agents/skills/guard/SKILL.md`, `.agents/skills/codebase-design/SKILL.md`,
`.agents/skills/unslop/SKILL.md`, `.agents/skills/code-review/SKILL.md`,
`CONTEXT.md`, `apps/web/src/lib/numeric-input.ts`,
`apps/web/src/lib/amount-parse.ts`, `AGENTS.md`. The Fowler smell baseline was
supplied in the child prompt.

### Round 1 findings

| # | Finding | Class |
|---|---|---|
| S1 | Em-dash overuse in the new design doc and module docstrings (unslop rule 13). | hard, documented standard |
| S2 | The repo's typed-money-reader standard is applied inconsistently: the new module documents the strict reader for `nextUnitCost` while `nonNegativeOr`, `saleUnitPrice` and the quick-add payloads keep `Number()`. | hard, self-inconsistent |

Baseline smells reported: Speculative Generality (`DraftKind` unused, the two
`to*` aliases, `purchaseUnitPrice` as a one-line config value), Duplicated Code
(the promise-wrapped mutation adapter, the rebuilt `{amount, percentage, source}`
literal), Middle Man (`paymentPairUnchanged` over a private `samePair`),
Mysterious Name (`nonNegativeOr`).

### Round 2 findings

- S1 substantially resolved: the two new module files and the test file now
  contain no em dash, and the design doc was rewritten with far fewer.
- S2 resolved by policy: `nextUnitCost` was restored to the pre-existing reader
  (`Number` with an integer >= 0 guard), so the module no longer introduces a
  second reader standard. The remaining `Number()` calls are pre-existing and
  unchanged.
- One new prose nit: a hyphen-as-dash in a `purchase.tsx` comment.
- No new baseline smell from the round-2 changes: `firstLineError` removes the
  duplicated submit guard, `samePair` is gone, the aliases are gone.

### Disposition at `6e0d153`

| Finding | Disposition |
|---|---|
| S1 em dashes | Fixed for the files this lane authored (module docstrings, test file, design doc). Em dashes remain in pre-existing lines of `sale.tsx` and `purchase.tsx` that this diff did not touch; the `—` placeholder inside the purchase category select is user-visible copy and must stay. |
| S2 reader inconsistency | Fixed by restoring the old reader and labelling the strict reader as a follow-up. |
| Hyphen-as-dash | Fixed to a colon. |
| Speculative Generality | Fixed: `DraftKind` removed, the `to*` and type aliases collapsed to `AmountKind`/`toAmountKind`, the page type aliases removed. `purchaseUnitPrice` is kept: it is the per-kind config value the hook takes, so it is not speculative. |
| Duplicated Code (promise adapter) | Accepted: the three call sites wrap different mutations with different payloads and different copy, and a generic wrapper would hide which mutation is used. |
| Duplicated Code (pair literal) | Fixed: `resolveInitialPaid` now takes the two drafts directly. |
| Middle Man | Fixed: `paymentPairUnchanged` is the single comparator. |
| Mysterious Name | Accepted for `nonNegativeOr`: it sits next to `parseQuantityDraft` and its docstring states the fallback contract. Renaming it would touch pre-existing call sites for no behaviour gain. |

## Spec axis

Spec sources: GitHub issue #146 (reproduced in the lane brief), the lane brief's
hard rules, and `.scratch/implementation/146-design.md`.

### Requirements checked

| Requirement | Status at `6e0d153` |
|---|---|
| Neither page re-implements line, quantity or total logic | Met. Sale calls `draftTotals`; purchase reads the hook's `subtotal`; both use `firstLineError`, `parseQuantityDraft` and the module's line ops. |
| One quantity parser; no `Number(event.target.value)` draft handling in either page | Met. The only `event.target.value` uses in the pages are plain string setters for quick-add fields and the discount. |
| Purchase's silent-keep is gone and matches sale | Met, proven at unit, rendered and browser level. |
| Visual output and Arabic copy identical | Met. No label, class, test id or copy string in the diff. The purchase quick-add keeps its own fields and buttons; sale keeps its own. |
| Money math preserved exactly | Met for every reachable input. The one intentional change is the cap clamp (below). |
| No server, contract or schema change | Met. The diff touches only `apps/web/**`, `tests/e2e/**` and `.scratch/**`. |
| Open decision 1 (hook wrapping a pure reducer) | Met. `draftReducer` is exported pure and unit-tested; `useInvoiceDraft` wraps it. |
| Open decision 2 (adopt sale's parser for both) | Met, with the adoption stated in design doc section 1. |
| Open decision 3 (share the quick-add form) | Partial by design: behaviour shared, markup per-kind. Raised as a `decisionRequest`. |
| Open decision 4 (per-kind config) | Met. `InvoiceDraftConfig` supplies `emptyLine` and `unitPrice`; `QuickAddSpec` supplies the field bag and reset policy. |
| Out of scope respected (`items.tsx`, `item-picker-dialog.tsx`, `unknown-scan-dialog.tsx`, router/API) | Met. None of those files appear in the diff. |

### Round 1 findings and dispositions

| # | Finding | Disposition |
|---|---|---|
| Spec-1 | Decision 3 is only partly satisfied; decision 3 is a narrowing, not the decision as written. | Escalated as a `decisionRequest` with the field-by-field evidence in design doc section 4.1. |
| Spec-2 | `draftTotals` was dead production code, so "the module owns line and invoice totals" was only half true. | Fixed in `e231b47`: sale calls `draftTotals`. |
| Spec-3 | `nextUnitCost` changed a reachable money reader, which contradicts "preserve the money math exactly". | Fixed in `e231b47`: the old reader is restored and pinned. |
| Spec-4 | The quick-add's stricter reading should be a `decisionRequest`, not a silent reinterpretation. | Raised as a `decisionRequest`; also recorded in design doc section 4.1. |

### Round 2 findings and dispositions

| # | Finding | Disposition |
|---|---|---|
| R2-1 | The clamp changes a reachable value at the cap. Judgment against "preserve the money math exactly": the arithmetic is untouched, and the change only unblocks a cart that used to be unsaveable. | Kept, recorded in design doc section 8 as the one intentional reachable-value change, with its own pin in the money-math table (section 7). |
| R2-2 | Purchase's quick-add now refuses `"1e3"`, `"2.0"`, `"0x10"` for a quantity. | Accepted: the quick-add quantity becomes a line quantity, so the shared parser is the right rule. Recorded in design doc section 8. |
| R2-3 | Design section 2 overstated "one totals path for both screens". | Fixed: the doc now says sale calls `draftTotals` and purchase reads the hook's `subtotal` because it has no discount. |
| R2-4 | Sale's error precedence moved from per-line to per-rule. | Fixed in `6e0d153`: `firstLineError` walks the draft once with a per-kind `errorFor`, so precedence is unchanged. |
| R2-5 | The review-evidence directory was empty. | Fixed: this file, the debate file and the test-audit file all exist at `6e0d153`. |

### Decision request (carried to the parent)

The quick-add **markup** is per-kind while its **behaviour** is shared. The
issue's open decision 3 recommended sharing the form. The design doc argues, with
the field-by-field table in section 4.1, that a config-driven form would be a
shallow module and would risk the hard rule that copy and layout stay identical.
The parent should either accept behaviour-only sharing or commission a shared
markup form as follow-up work.

## Verdict

- **Standards:** pass. Hand-documented standards are met; the one hard violation
  (em-dash density) is fixed in this lane's files. Baseline smells are either
  fixed or accepted with a reason.
- **Spec:** pass for the definition of done and for every hard rule. One
  narrowing of a recommendation (decision 3) is disclosed and escalated rather
  than taken silently.
- No blocker.
