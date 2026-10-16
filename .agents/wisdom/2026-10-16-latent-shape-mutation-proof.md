# Proving a latent representation bug: a mutation proof, and ablate it (🟡)

**Date:** 2026-10-16 · **Ticket:** #217 · **Area:** apps/web/src/components/vault

`vault-gate.tsx` held `error` + `errorField` as two pieces of state — the shape
whose drift broke `vault-settings.tsx` in #109. The ticket asked for one value
(`failure: { message, field } | null`) and a test that "must fail against the
unfixed component". It cannot: every write was already paired, so the two shapes
are behaviourally identical through the DOM. A green test proves nothing about
whether it would catch the drift.

What worked:

1. **Turn the representation defect into a mutation.** Revert the component to
   the two-state version, then delete the pairing from one write (`fail`'s
   field-less branch) so a stale `errorField` can survive. The new test fails on
   the mutant and passes on the fix — that is the discrimination evidence.
2. **Ablate the mutation, or you will overstate it.** Unpairing writes one at a
   time (`run` reset, `fail`, each screen handler) *all passed* — a paired write
   elsewhere kept clearing the blame. Only the chain
   `{fail, run-reset, use-recovery, back}` failed. So the test is a
   **chain-level** detector, not a unit detector; say that in the evidence
   instead of claiming "minimality is pinned".
3. **When the acceptance criterion is unsatisfiable, surface it.** Do not quietly
   swap in a substitute. The design doc and evidence state the literal criterion
   cannot hold for a black-box test and the mutation is the substitute.

**Always**: for a latent shape/representation fix, the regression test needs a
mutation proof plus an ablation table; record which unpaired writes fail it and
which do not.
