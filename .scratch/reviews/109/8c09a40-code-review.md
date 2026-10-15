# Code-review evidence — issue #109, review-fix round 1

- Issue base: `fc396253edbae19015ee4519272338babee17d34` (`origin/develop`)
- Round base: `2e06e66`
- Reviewed source HEAD: `8c09a40a69f2d07a9866859b8350581f8131637b`
- Diff: `git diff 2e06e66..8c09a40` (2 files: `vault-settings.tsx`, its test)
- Method: Standards + Spec reviewers in parallel. The full `fc39625...7eb079c`
  review is in `7eb079c-code-review.md`; this file covers the round-1 delta and
  supersedes it as the current-head evidence.

## Standards

No documented-standard breach. Source-only commit policy satisfied (two
source/test files, no build artifacts); Arabic-first copy stays behind
`t()`/`tError`; `setError`/`setErrorField` are gone with no dead code.

Notes (no breach):

1. `expectNoFieldBlamed` skips an input that is not mounted, so a renamed
   testid would silently skip it. Low: the tests that mount the fields also
   `setValue` them, so a rename breaks those calls first; the helper still
   catches the bug class (blame reassigned to a live input).
2. The re-submit guards keep the previous message visible while the next
   attempt is in flight. Intentional, documented, and identical to the pre-fix
   behaviour (`setErrorField(null)` alone); not a regression.
3. `aria-invalid` in the helper could be tripped by the too-short hint on
   `vault-new-passphrase`; the fixtures use a long-enough passphrase.
4. `.dokan-port` is a workspace artifact modified by e2e; it is not in this
   round's diff and must not be committed.

## Spec

| Requirement (Greptile r1 + brief) | Status | Evidence |
|---|---|---|
| `error` + `errorField` are ONE value, set in one place | Met | `vault-settings.tsx:44-46`; every writer is a `setFailure` (`:65,70,79,90,100,112,130,161,252`); no `setErrorField(null)` sprinkle remains |
| A field-less server error clears a stale field blame | Met | all four `onError` set `{ message, field: null }` (`:70,79,90,100`); test `expectNoFieldBlamed` |
| Cross-action test (empty current → failing recovery-key action) fails without the fix | Met | parent-run revert: both field-less tests fail on `10871b0^`, pass on `8c09a40` |
| Editing an unrelated field must not swallow the error | Met | tests assert the server copy survives `setValue(current)` |
| Check `App.tsx` / `vault-gate.tsx` for the same drift | Met | `App.tsx` is already a single `{message,field,nonce}`; `vault-gate.tsx` pairs every write via `fail`/`clearFieldError`/`run` — no active drift, latent shape only |

No blocker at `8c09a40`.
