# Test-audit evidence — issue #109, review-fix round 1

- Issue base: `fc396253edbae19015ee4519272338babee17d34` (`origin/develop`)
- Round base: `2e06e66` (previous evidence HEAD)
- Reviewed source HEAD: `8c09a40a69f2d07a9866859b8350581f8131637b`
- Method: edge-case hunter + coverage analyst + test-quality reviewer, run in
  parallel against the first fix commit `10871b0`; every "would break" and
  "subtle" gap was fixed in `8c09a40`. The old `7eb079c-test-audit.md` is
  superseded by this file.

## The finding and the fix

Greptile r1: `error` and `errorField` were two `useState`s, so a field-less
server error (`createKey`/`deleteKey` `onError`) replaced the message but left
`errorField = "current"`. This audit graded the first fix **A−** and named the
gap that matters: *the test proved the previously-blamed field lost its blame,
but not that no field is blamed* — a wrong reassignment to a different input
would still pass. That is exactly the test-audit question.

Fixed in `8c09a40`:

| Finding | Class | Fix |
|---|---|---|
| The create test only inspected `current`; a wrong non-null association passed | missing edge / false-negative | `expectNoFieldBlamed(host)` asserts every mounted field is unassociated and that the alert's `id` is `vault-settings-error` |
| `deleteKey.onError` is a separate literal, untested | would-break (undetected) | added "a failed recovery-key deletion never keeps the empty-passphrase field blamed either" |
| `vault-reset-*` association never checked | subtle | covered by `expectNoFieldBlamed`'s field list |
| Error element `id` never asserted (dangling `aria-describedby` invisible) | subtle | `expectNoFieldBlamed` pins `id="vault-settings-error"` |
| Other field error tests asserted only the blamed field | subtle (over-broad association) | mismatch test now asserts `current`/`new` are unassociated |

Revert discrimination (parent-run, not just inspected): both field-less tests
fail against pre-fix source (`10871b0^`) via
`expect(received).not.toBe(expected)` on the new negative association
assertion; both pass on `8c09a40`.

```
# pre-fix source swapped with `git show 10871b0^:...`, hardened tests kept:
# 10 pass, 2 fail  (the two field-less tests)
# restored fixed source:
# 12 pass, 0 fail, 72 expect() calls
```

## Acceptance → test

| Criterion | Test |
|---|---|
| Field-less server error clears the stale field blame | both field-less tests |
| A wrong reassignment to another field is impossible | `expectNoFieldBlamed` |
| Editing an unrelated field does not hide the error | both field-less tests (assert message survives `setValue`) |
| Both `onError` literals (`createKey`, `deleteKey`) covered | one test each |
| `error` + `errorField` are one piece of state | structural (`failure` + derived `error`/`errorField`); exercised indirectly |

## Cross-file drift check (brief requirement)

- **`App.tsx`** — no drift. `useAuthError` already holds a single
  `{ message, field, nonce }` (`App.tsx:28-29`); the only writers are `show`
  (`:45`) and `clear`/`clearField` (`:49-55`). `show` replaces the whole value,
  so a field-less server error inherently clears a stale blame.
- **`vault-gate.tsx`** — same *shape* as pre-fix vault-settings (separate
  `error`/`errorField`, `:115`/`:120`), but no active drift: every write is
  paired through `fail` (`:147-148`), `clearFieldError` (`:157-159`), `run`
  (`:166-167`), the lock-expiry effect (`:131-132`), the back button (`:298`),
  and `:446-447`. Latent maintenance risk (the shape that broke settings), not
  a bug at this HEAD.
- No setting was changed in `App.tsx`/`vault-gate.tsx` this round.

## Commands

```
cd apps/web && bun test src/components/vault/vault-settings.test.tsx
# 12 pass, 0 fail, 72 expect() calls
bun run test        # workspace: 976 pass, 0 fail
```

Residual (non-blocking): the re-submit branch
(`setFailure(current => … field: null)`) is still only exercised indirectly;
its behaviour is unchanged from the pre-fix code.
