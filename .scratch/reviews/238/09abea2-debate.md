# #238 — debate evidence (High-assurance)

- Base: `origin/develop` @ `2c8d867` (contains `draftBlank`; #239 merged).
- Reviewed HEAD: `7190e73`. Fixes applied in `09abea2` (this file is anchored to the final SHA).
- Lenses: adversarial critic + charitable defender, run as two independent review sub-agents.
  Commands: `git diff 2c8d867...HEAD` (clean) plus the full changed files and
  `.scratch/implementation/238-design.md`. Read-only; no files modified by either agent.

## Critic findings and dispositions

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | 2 | `resolveInitialPaid` mark-only now books the whole invoice as debt instead of refusing. Verified *correct*: `draftBlank` is true only when the draft renders visually empty, which was always the legitimate «unpaid» choice. Residual: silently changes who owes money on an accidental lone-mark paste. | Intended by the brief; documented in the design and pinned in `invoice-draft.test.ts` + the e2e `sale-saved-debt = 1000`. No change. |
| 2 | 2 | `percentageDraftInvalid` mark-only now `false`. Verified it cannot reach a state that was not already legal: a mark-only percentage already clears the paired amount (`percentageEdited`), and the `{amount:"", percentage:""}` state was already `false` before the change. | No change. |
| 3 | 5 | Missed site: `resolveOpeningStock` (`numeric-input.ts:58`) still raw-`.trim()`s; mark-only → `{reason:"invalid"}` where blank → `{value:0}`. | **Deferred, documented.** Safe refusal (no wrong number), different flow (item create), outside the brief's four-site scope. Named in the `draftBlank` docstring and the design's deferred list; filed as a follow-up. Per wisdom `2026-10-15-extraction-ordering-guard.md`, the docstring claim was scoped rather than the diff widened. |
| 4 | 2 | `PASTED_BIDI_MARKS` regex→array and derived classes: verified **set-identical** (`\u202A-\u202C`/`\u2066-\u2069` fully enumerated), no `g`-statefulness bug (`replace` only), `DRAFT_CONTENT` non-global, LRO/RLO still excluded. Latent fragility: a future metacharacter member would silently corrupt the class / throw at module load. | **Fixed** in `09abea2`: each member escaped before interpolation. |
| 5 | 1 | `nextUnitCost` explicit blank branch is behaviour-preserving by construction; no input flips. | Kept for the stated reason; docstring now says it is redundant with today's reader and exists to pin the cleared-field contract. Ablation recorded in the test-audit evidence. |
| 6 | 3 | The `draftBlank` docstring / commit subject claimed «every blankness guard», false (`resolveOpeningStock`, `supplier-opening-draft.ts:26`, the settle panels, `amount-percentage-input.tsx:66`). | **Fixed**: docstring scoped to the named sites + explicit deferred list. |

Critic's own addition: `saleDebt` (`sale.tsx:69`) — the sale screen's pre-commit debt preview — was not in the brief's table but is the same decision as `resolveInitialPaid`; after that change the preview refused a mark-only draft the commit accepts. **Fixed** (`saleDebt` now asks `draftBlank`), mutation-proved in the test-audit evidence.

## Defender output

Four defences: predicate placement beside the normaliser (9/10); per-site fallbacks
preserved, evidenced by the `SITES.blankVerdict` column differing per site (9/10);
one-source mark list driven by the test (9/10); explicit `nextUnitCost` branch
(6/10 — defendable on intent, not test observable). No blockers. Honest residual:
the `resolveInitialPaid` debt change is intended, not risk-free; the `nextUnitCost`
branch cannot be black-box tested.

**Verdict: no blockers. Every severity ≥5 finding was either fixed or explicitly deferred and documented.**
