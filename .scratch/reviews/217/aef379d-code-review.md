# Code review — issue #217

Tier: **High-assurance**. Base: `e71b2b1`. Reviewed HEAD: `aef379d`.
Two independent axes (Standards, Spec), fresh context. Reports kept separate, not
reranked.

## Standards

**Correct**

- `vault-gate.tsx` matches the documented #211 shape (`vault-settings.tsx:129`,
  `App.tsx` `useAuthError`): one `{ message, field }` value, derived
  `error`/`errorField`, functional `clearFieldError`; `setError`/`setErrorField`
  grep-empty.
- Design doc present with the required sections; Playwright assertions added to
  the user-facing flow.
- `.scratch/` is tracked by deliberate repo convention; not repo noise.

**Documented-standard deviations**

- `docs/engineering-workflow.md` ("Evidence filenames must contain the exact
  reviewed HEAD SHA"): `.scratch/verification/217/*` gate/proof artifacts were
  named without a SHA. **Addressed** — `aef379d-gates.md`,
  `aef379d-mutation-core.txt`, and the reviewed HEAD is now stated in
  `mutation-proof.md`; the three canonical evidence files carry `aef379d-`.
- High-assurance requires debate + test-audit + code-review evidence: at review
  time only `debate` existed. **Addressed** — all three now exist at `aef379d-`.
- Branch `fix-217-vault-single-failure`: lane/parent-owned, flagged only.

**Judgement calls (Fowler baseline)**

- *Duplicated Code*: the `{message, field}` + functional-clear is now the third
  copy (settings, `useAuthError`, gate). The design endorses matching rather than
  sharing; the brief mandates it. **Follow-up** for a shared `useFieldFailure`
  hook, not a violation.
- *Duplicated Code (tests)*: route + mount setup repeats across the two new
  #217 tests. Deferred (see test-audit).
- *Mysterious Name*: `failure` is both `useVaultStatus`'s union and `VaultGate`'s
  object state. Disjoint scopes; consistent with settings. Dismissed.

## Spec

**Correct**

- Brief "match its shape exactly": byte-identical shape to `vault-settings.tsx`
  after #211; only the field union differs.
- Brief "if the pairing is not complete … report it as a blocker": no reachable
  drift; stop-condition not triggered.
- Brief "do not change the lock timer, the back button, or the recovery
  semantics": those sites only swap two paired setters for one `setFailure(null)`.
- Brief's cross-action test: present
  (`vault-gate.test.tsx:199-238`), with the mutation proof.

**Notes**

- The literal "must fail against the unfixed component" criterion is unsatisfiable
  for a black-box test on a latent bug; the design doc and mutation proof state
  this and substitute a drift mutation. **Surfaced, not silently swapped.**
- Gate evidence (`aef379d-gates.md`) now records typecheck/lint/test/e2e commands
  and exit codes.
- Design doc's "only difference is the field union" slightly overstates: settings
  also has a message-preserving field-clear with no gate counterpart. No gate
  site needs it; harmless. Noted.
- Scope: two additional unit tests and four e2e assertions beyond the one
  required test; justified as regression nets and a11y coverage.

## Summary

- **Standards: 0 hard violations** (2 evidence-process deviations, both fixed;
  3 judgement-call smells, all defended or deferred).
- **Spec: 0 blockers, 0 missing requirements.** Worst spec item: the unsatisfiable
  literal criterion, surfaced and substituted. Worst standards item: evidence
  filenames without a SHA, fixed.
