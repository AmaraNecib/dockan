# #244 debate — High-assurance, HEAD `390da2db0d2ddf6600bf5b5c9e5f8462699b2b34`

Base `746ff933753a0b409e96365080c91e3ef6efb5b6` (`origin/develop`, the #243 squash
for #238). Two independent lenses (critic + defender), read-only, run as
sub-agents. The full findings were synthesized here; dispositions below.

## Critic (harsh)

No blocker. Verdict: the ratchet is real, the 11-file mutation log shows every
revert reddens it, conversions preserve their blank fallback. Findings:

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | 🟠 6 | No e2e spec though the brief requires one | **Fixed** — `tests/e2e/blankness-mark-only.spec.ts` passes on the fix, fails (exit 1) on the reverted items gate |
| 2 | 🟠 6 | No screenshots for the changed refusal text | **Fixed** — `390da2d-mark-only-broken.png` (threshold error shown) vs `390da2d-mark-only-fixed.png` (form resets, threshold `5`) |
| 3 | 🟡 5 | Scanner false-negative shapes undocumented | **Fixed** — `KNOWN CEILING` paragraph in the scanner docstring; `?.trim()` now detected |
| 4 | 🟡 4 | `INLINE_REV` / `INLINE_LEN` untested | **Fixed** — synthetic self-tests for reversed, `.length`, parenthesised and `?.` forms |
| 5 | 🟡 4 | `stripComments` not regex-literal safe | **Deferred** — latent in this repo (no regex containing `//` or an unbalanced quote in scope); documented in the scanner docstring's ceiling |
| 6 | 🟡 4 | Signature collisions undercount sites | **Documented** — scanner docstring says identical gate texts collapse; reversion still reddens either site |
| 7 | 🟡 3 | `draftBlank` docstring over-scopes | **Fixed** — scoped to "value reader"; names the `sale.tsx` `draftDirty` exception |
| 8 | 🟡 3 | `saleDebt` vs `draftDirty` divergence has no note | **Fixed** — one-line comment at the `draftDirty` block |
| 9 | 🟡 2 | Loose non-vacuous floors (`>10`/`>20`) | **Dismissed** — an exact set pin would churn on every new reader; the three classification directions are the real guard |
| 10 | 🟡 2 | `data-testid="item-threshold"` added to production | **Fixed** — testid removed; the test queries `input[name="itemThreshold"]` |

Checked clean by the critic: double-normalisation in `resolveOpeningStock` is safe
(no edge-mark reparenting), the reader substitutions are behaviour-preserving,
`percentageEdited` is genuinely outcome-neutral, and no truthiness/`.length`/
call-expression gates exist in the scope today.

## Defender (charitable)

Ten defences, confidence 7–9: it fixes the stated defect not a symptom (9); the
scope is self-extending (8); three assertions close both directions (9);
the #238 over-claim is corrected (9); each conversion preserves its fallback (8);
the reader substitutions are provably behaviour-preserving (9); the deliberate
`raw` verdicts are reasoned (8); the outcome-neutral conversion is handled
honestly (8); comment stripping is tested (7); no new silent state (8).

Weakest parts, stated honestly: scanner false negatives are the real gap (a
truthiness or call-expression gate is invisible); signature collapsing; the
scope hole for a module that parses numerics without importing a reader; the
comment/string state machine is heuristic; and `CLASSIFIED` is still a hand
table — its saving grace is that it is self-checking, not trusted.

## Synthesis

One blocker-class item (the brief's e2e + screenshots) and the docstring/scanner
over-claims were fixed. The scanner's syntactic ceiling is documented rather than
papered over: it is the honest boundary of "the class is closed", and every gate
of the matched forms is caught. No blanket-clean claim is made.

Commands: ratchet green `bun test src/lib/blankness-ratchet.test.ts` → exit 0
(`390da2d-ratchet-green.log`); 11/11 file mutations → exit 1
(`390da2d-mutation-proof.log`); e2e fix → 1 passed, reverted → 1 failed.
