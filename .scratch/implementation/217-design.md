# Issue #217 — `vault-gate.tsx`: one failure value, not two (design)

Tier: **High-assurance** — the change touches the pre-boot vault gate, which is
the credential boundary that decides whether the encrypted store opens at all
(failure mode 4: bypassed login/session/RBAC/secret handling). The ticket calls
for a representation change, but the component owns passphrase/recovery
validation and the field-blame wiring a screen reader announces, so it takes the
High-assurance lane: debate + test-audit + code-review.

Base: `origin/develop` @ `e71b2b1` (merge-base `e71b2b1`).
Branch: `fix-217-vault-single-failure`.

## Problem

`vault-settings.tsx` used to keep `error` and `errorField` in **two** pieces of
state. A server failure that named no field replaced the message but left the
old field blame in place, so a screen reader announced the error against the
**wrong input**, and editing that input then cleared the unrelated message.
#211 (PR #211, merge `68f5107`) fixed it by modelling the pair as **one** value —
`failure: { message, field } | null` — with `error`/`errorField` derived.

`vault-gate.tsx` still carries the two-state shape:

```ts
const [error, setError] = useState<string | null>(null);
const [errorField, setErrorField] = useState<"passphrase" | "confirm" | "recovery" | null>(null);
```

`App.tsx`'s `useAuthError` already holds the single-value shape
(`{ message, field, nonce }`). This change makes all three surfaces agree.

### Latent, not active

The bug is **not reachable today**. Every current write is paired:

- `fail` sets both;
- `clearFieldError` clears both;
- `run`'s pre-attempt reset clears both;
- the lock timer's expiry (`setError(null); setErrorField(null)`) clears both;
- both screen changes (use-recovery, back-to-passphrase) clear both.

No transition sets one without the other, so there is no reachable drift. The
ticket is about removing the *shape* that produced #109 in settings — the pair
that can silently drift when a future fieldless write forgets one setter. This
design says so rather than overstating the bug.

The reachable-drift check was performed explicitly: every `setError` /
`setErrorField` site in the component was read and each is immediately paired
(see "Implementation risks" for the audit method). No unpaired write exists, so
this is not a blocker finding.

## Fix

One state value, derived accessors, and one write path per transition — the
exact shape `vault-settings.tsx` uses after #211:

```ts
/** The input a gate refusal points at; null means the form-level alert. */
type VaultGateField = "passphrase" | "confirm" | "recovery" | null;

// A failure and the field it blames are ONE value: setting one always sets
// the other, so a server error that names no field can never strand a stale
// field blame (and edit-clear can never swallow an unrelated message).
const [failure, setFailure] = useState<{ message: string; field: VaultGateField } | null>(null);
const error = failure?.message ?? null;
const errorField = failure?.field ?? null;
```

- `fail(message, field = null, retryAfterMs?)` → `setFailure({ message, field })`
  then focus the blamed field (unchanged focus semantics).
- `clearFieldError(field)` → functional update, so it drops the failure **only**
  when the stored blame is that field:
  `setFailure((current) => (current !== null && current.field === field ? null : current))`.
  The functional form is what makes an edit-clear unable to read a stale closure.
- `run`'s pre-attempt reset, the lock timer's expiry, and the two screen
  changes all become one `setFailure(null)`.

`VaultAlert`'s props, the `aria-invalid` / `aria-describedby` wiring, the lock
timer, the back button and the recovery semantics are untouched. **No behaviour
change**: every transition produces the same user-visible result.

### Why match `vault-settings.tsx` exactly

Two near-identical components that disagree about how a failure is modelled is
how this recurs. The field type, the value type, the derived accessors and the
functional `clearFieldError` are copied from `vault-settings.tsx` after #211
(as is `useAuthError`'s functional `clearField`). The only difference is the
field union: the gate's inputs are `passphrase`/`confirm`/`recovery`.

## Interfaces changed

`apps/web/src/components/vault/vault-gate.tsx` only. No public component
signature changes (`VaultGate` props, `useVaultStatus` return), no i18n keys,
no server/contract/schema change. `vault-settings.tsx` and `App.tsx` are read as
the reference and **not edited**.

## Planned tests

Unit (`apps/web/src/components/vault/vault-gate.test.tsx`, real `VaultGate`):

1. **Cross-action field-less error** (the #211 shape the ticket asks for):
   empty passphrase submit blames `passphrase`; the recovery action fails with a
   server error that names no field; assert **no** mounted field is blamed (and
   the alert keeps its `id`), then editing the recovery field does **not**
   swallow the server error.
2. **A field-less failure clears a previous field blame**: empty recovery submit
   blames `recovery`; a later fieldless server failure leaves no field blamed.
3. **A screen change clears the whole failure**, so the blame cannot resurface on
   the way back to the passphrase form.
4. The existing gate suite stays green — it is the regression net for "no
   behaviour change".

E2E (`tests/e2e/vault.spec.ts`): extend the existing restart/unlock test (no new
flow, no extra KDF call) with a positive control (the empty-submit refusal marks
the field `aria-invalid`) and a negative (the field-less wrong-passphrase server
error drops that mark). This is a same-screen behaviour pin over the real HTTP
path, not the cross-screen #217 transition -- that is proved by the unit test
and its mutation.

## Mutation proof (discriminating test)

Because the bug is latent, the new test **cannot** fail against the unfixed
component by construction — the two shapes produce identical behaviour while
every write is paired. "The test passes" is therefore not evidence that it is
discriminating, and the brief's literal criterion is unsatisfiable for a
black-box DOM test. To prove the test is discriminating anyway, the #109 drift
is reintroduced as a temporary mutation: every field-less write is made to leave
the previous `errorField` in place (unpaired `fail`, unpaired `run` reset, and
both screen-change handlers), i.e. the exact two-state drift. The cross-action
test then **fails** (`Expected "false", Received "true"`), and passes again once
the mutation is reverted.

The guard is **chain-level, not unit-level**: no isolated unpaired write fails
the test — ablations `[A]` (`run` reset + both screen handlers) and `[B]`
(`fail` alone) both pass, because a paired write elsewhere clears the blame. The
minimal failing set is the chain `{fail, run-reset, use-recovery, back}`. That
is the honest weakness: the test catches the drift shape only when the whole
chain diverges, which is exactly what the single value makes impossible. The
exact mutation, the ablation table and both results are recorded in
`.scratch/verification/217/`.

## Implementation risks

- **Silent behaviour change in the locked branch.** While locked, the alert
  shows the lock countdown even though `failure` holds the wrong-passphrase
  copy; the timer clears it. Keep the timer's clear, and keep `errorField`
  derived (null while locked), or the countdown could start announcing the old
  blame.
- **Edit-clear under batching.** Reading `errorField` from the closure in
  `clearFieldError` would be the exact drift; the functional update is required.
- **Reachability audit.** No unpaired write may be hidden by the refactor. Read
  every `setError` / `setErrorField` site first: the refactor replaces them all
  with `setFailure`, and a `grep` for the old setters after the change must be
  empty.
- **Test that only passes because the states happen to be paired.** Mitigated by
  the mutation proof above, plus the cross-action test asserting the *negative*
  (no field blamed) after a fieldless failure.

## Out of scope

No e2e flow change beyond the two added assertions, no copy change, no focus
semantics change, no API change. No edit to `vault-settings.tsx` or `App.tsx`.
