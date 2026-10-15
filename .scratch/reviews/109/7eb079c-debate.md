# Debate evidence — issue #109

- Base: `fc396253edbae19015ee4519272338babee17d34` (origin/develop)
- Reviewed source HEAD: `7eb079cd0ec68b2a342c19728021d7dc9060fb3e`
- Method: adversarial critic + charitable defender sub-agents, three rounds (the
  brief mandates debate at Standard tier for this auth-adjacent change).
- Tier: Standard (UI).

## Round 1 (HEAD f6cfc36) → fixes

| # | Sev | Finding | Decision |
|---|---|---|---|
| 1 | 9 | **Blocker.** `VaultSettings` change-passphrase form gained `noValidate`, but the only confirm guard was `mismatch = confirm.length > 0 && confirm !== new`. With an empty confirm the mutation fired, so a browser-only `required` rule was now unenforced. | Fixed: submit compares `confirmPassphrase !== newPassphrase` directly. Test: "the change form refuses an empty confirm in Arabic without a request" (`vault-settings.test.tsx`). |
| 2 | 5 | Vault gate never cleared a blamed error on edit, so `aria-invalid` and the message went stale (App.tsx already clears via `clearField`). | Fixed: `clearFieldError(field)` on every blamed input; test "editing a blamed field clears the Arabic error and aria-invalid". |
| 3 | 3 | `tests/e2e/vault.spec.ts` KDF timeout additions are outside #109. | Kept and disclosed: measured Argon2id setup at ~9.2s on this box (Playwright expect default 5s), so the vault suite is unrunnable under sibling-lane load without a bound. `backups.spec.ts` already uses this pattern. |
| 4 | 2 | Positional optional refs / `authTarget` machinery. | Dismissed (false alarm): refs are stable, so `report` keeps identity, which the login notice effect depends on. |
| 5 | 2 | Password rule duplicated in `LoginPage` (`authFieldKey` has it). | Dismissed: login still needs `normalizedPhone` separately, so the helper would not dedupe cleanly. |

## Round 2 (HEAD 854f425) → fixes

| # | Sev | Finding | Decision |
|---|---|---|---|
| 1 | 4 | Editing the setup passphrase to match did not clear a confirm-blamed mismatch. | Fixed: passphrase `onChange` clears both `passphrase` and `confirm`; test "editing the passphrase clears a confirm-blamed mismatch". |
| 2 | 3 | `VaultSettings` had no field-level `aria-invalid`/`aria-describedby`/focus/clear, so the "password reset" surface did not meet the issue's aria acceptance. | Fixed: `errorField` + refs + `showError`/`clearFieldError`, `id="vault-settings-error"` on the alert, tests asserting association and focus. |
| 3 | 2 | `mismatch` flagged the confirm field while `newPassphrase` was empty. | Fixed: `mismatch` now requires both fields non-empty. |
| 4 | 1 | Standards suggested extracting the error mechanism into a shared hook (now hand-rolled in 3 places). | Deferred (documented): behaviour-correct, tested, Standard tier; a cross-module refactor is out of #109's scope. |
| 5 | note | Whitespace-only vault unlock/recovery/recovery-key still reach the request. | Dismissed: identical to the old native `required` behaviour, so no rule was weakened; setup already trims via `isVaultPassphraseLongEnough`. |

## Round 3 (HEAD 13e64e1) → final fix

No blockers. One actionable note:
- Editing `newPassphrase` to match a mismatched confirm did not clear the stale
  settings error (the mirror of round-2 item 1). Fixed: `newRef` `onChange` also
  clears `"confirm"`; test "editing the new passphrase clears a confirm-blamed mismatch".

All other round-3 reports were positive/notes only (scope justified by the vault
migration; e2e timeouts justified; duplication acceptable at this tier).

## Dismissed / deferred summary

- **Deferred:** extract the shared auth-error hook (`App.tsx` private today) for
  `vault-gate`/`vault-settings` — a refactor, no correctness impact.
- **Dismissed:** `authTarget`/optional refs, login password-rule duplication,
  untrimmed whitespace checks on vault unlock/reset, mixed literal/`i18n.t` test
  styles. Each is either a false alarm or matches the pre-change behaviour.

No open blocker at `7eb079c`.
