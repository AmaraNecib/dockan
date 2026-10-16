# #217 mutation proof — is the cross-action test discriminating?

The bug is latent: every write in the pre-change component is paired, so the
two-state and single-value shapes are behaviourally identical on all reachable
paths. Therefore the new test **cannot fail against the unmodified component** by
construction, and the brief's literal criterion ("the new test must fail against
the unfixed component") is unsatisfiable for a black-box DOM test. This is
stated plainly in the design doc rather than worked around.

To prove the test is discriminating anyway, the #109 drift is reintroduced as a
temporary mutation of the base (two-state) component and the new tests are run
against it. All runs use the same test file as the change under review.

Regenerate: `git checkout e71b2b1 -- apps/web/src/components/vault/vault-gate.tsx`,
`git apply --recount .scratch/verification/217/mutation-core.patch`,
`cd apps/web && bun test src/components/vault/vault-gate.test.tsx`, then restore.

## Ablations (each unpaired write removed on its own)

| Ablation | Unpaired writes | Result | Why |
|----------|-----------------|--------|-----|
| `[A]` `mutation-minimal.patch` | `run` reset + both screen handlers | **20 pass / 0 fail** | the paired `fail`'s field-less write still nulls the blame |
| `[B]` `mutation-fail-only.patch` | `fail` field-less write | **20 pass / 0 fail** | `run`'s paired reset clears the blame first |
| `[C]` `mutation-core.patch` | `fail` + `run` reset + both screen handlers | **20 pass / 1 fail** | the blame survives the screen change and the field-less server failure, and resurrects on return |

`[C]` failure detail (`mutation-core-final.txt`):

```
Expected: "false"
Received: "true"
      at <anonymous> (vault-gate.test.tsx:235:52)
(fail) vault gate keeps one failure value (issue #217) > a failing recovery action never keeps the empty-passphrase blame, and editing cannot hide the server error
 20 pass
 1 fail
```

## Honest scope of the proof

The guard is **chain-level, not unit-level**: no isolated unpaired write fails
the test. The minimal failing set is the whole chain
`{fail, run-reset, use-recovery, back}`. So the test catches the drift only when
the entire chain diverges — which is exactly what modelling the pair as one
value makes structurally impossible. `[A]`/`[B]` prove the test is not a
single-write detector; `[C]` proves it does detect the drift shape.

The full-drift `mutation.patch` (adding the lock timer's clear as a fifth
unpaired write) also fails the test; the timer is irrelevant to it, which is
why `[C]` drops it.
