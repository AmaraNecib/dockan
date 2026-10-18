# #244 code-review — HEAD `390da2db0d2ddf6600bf5b5c9e5f8462699b2b34`

Base `746ff933753a0b409e96365080c91e3ef6efb5b6`. Two independent lenses
(Standards, Spec), read-only sub-agents. Findings and dispositions.

## Standards

Verdict: no code blocker. The conversions did not tighten the readers (#146 sin
absent) — dropping the outer `.trim()` on parser args is safe because every
reader normalises+trims internally (`amount-parse.ts`, `numeric-input.ts`).

| # | Hard/judgement | Finding | Disposition |
|---|---|---|---|
| 1 | **Hard** | Evidence filename carried no reviewed SHA (`mutation-proof.*`), violating `docs/engineering-workflow.md` "Evidence filenames must contain the exact reviewed HEAD SHA" | **Fixed** — renamed to `390da2d-*` |
| 2 | Judgement | `draftBlank` docstring claimed "every numeric-draft reader" while `sale.tsx` keeps four numeric `draftDirty` gates raw | **Fixed** — scoped to "value reader"; names the `draftDirty` exception |
| 3 | Judgement | Scanner docstring implied totality; the detector is syntactic | **Fixed** — `KNOWN CEILING` paragraph (truthiness, call-expression receivers, reader-free files) |
| 4 | Smell — parallel enumeration | `CLASSIFIED` re-encodes each gate as a string edited in lockstep with source; a renamed `draftBlank` entry could go vacuous | **Mitigated** — a renamed receiver that reverts to raw becomes an unclassified gate → red; the `raw`-present assertion catches an accidental conversion of a kept gate. Collisions documented. |

Wisdom applied: `2026-10-15-extraction-ordering-guard.md` (a helper docstring must
name the readers it covers — the over-claim was fixed);
`2026-10-15-extraction-must-not-tighten-money-readers.md` (port the old predicate
literally; no reader tightened); `2026-10-16-latent-shape-mutation-proof.md` (the
outcome-neutral site says the ratchet, not a black-box test, is the
discriminator); `2026-10-15-test-helper-vacuous-guard-and-inherited-mutation-claims.md`
(provenance belongs in the `<sha>-test-audit.md` evidence file).

## Spec

Source of truth: the crew brief
`D:/projects/mani-project/.scratch/sessions/crew/briefs/fix-244-blankness-ratchet.md`
and `.scratch/implementation/244-design.md`.

| Brief requirement | Status |
|---|---|
| Ratchet FIRST, then conversions under it | Done — commit `7f8f5c2` (ratchet) precedes `390da2d` (conversions + review fixes); green on the current tree before any site was touched |
| Ratchet fails on a deliberately unclassified gate, then green | Done — `390da2d-ratchet-first-red.log` (exit 1) and `390da2d-ratchet-green.log` (exit 0) |
| "fails on any site that is not classified — converted, or listed with a reason" | Done — `CLASSIFIED` with `raw` (present, reasoned) vs `draftBlank` (absent) verdicts |
| Unify the test, preserve each fallback (#146) | Done — every site's blank fallback preserved, pinned by a mark-only == blank test |
| Per-site diff + mutation (command + exit code) | Done — `390da2d-test-audit.md` table; 11/11 files → exit 1 |
| Single e2e spec for a screen path | Done — `tests/e2e/blankness-mark-only.spec.ts` (passes on fix, fails on revert) |
| Screenshots if refusal text changes | Done — `390da2d-mark-only-{broken,fixed}.png` |
| A site on neither prior list is the finding | Found `sale.tsx`'s four `draftDirty` numeric gates; classified `raw` with a written reason, not silently converted |

Scope creep: the only non-required change was a `data-testid` added to shipping
markup; it was **removed** and the test now queries `input[name="itemThreshold"]`.
The e2e selection map (`tests/e2e-selection.map.json`) gained the new spec under
the existing items rule — required by `scripts/e2e-selection.test.ts`, which fails
closed on an unmapped spec.

## Commands run

`bun run lint` → 0; `bun run typecheck` → 0; `bun run test` → 0 (web 1184 pass,
scripts 73 pass); ratchet → 0; e2e spec → 1 passed.
