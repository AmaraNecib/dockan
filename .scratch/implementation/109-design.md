# Issue #109 — Auth forms speak Arabic, never the browser's bubble (design)

Tier: **Standard** (UI/auth, money-adjacent per the brief). Base: `origin/develop` @
`fc39625`. Branch: `fix-109-arabic-validation`.

## Problem

Auth forms carry native `required` (and `minLength`). Submitting an empty field lets the
browser run its own constraint validation first, so the owner sees a bubble whose language
follows the browser (usually English/French), not the app's Arabic. The bubble is a
platform string the app cannot translate.

At `fc39625` the vault migration (ADR-0008 §4.6) has moved first-run and sign-in into the
vault gate, but the legacy plaintext gate is still shipped for legacy builds. The issue
names "login, first-run setup, password reset"; the equivalent current surfaces are:

| Issue name | Current surface |
| --- | --- |
| first-run setup (legacy) | `SetupPage` in `apps/web/src/App.tsx` |
| login (legacy) | `LoginPage` in `apps/web/src/App.tsx` |
| first-run setup (vault) | `VaultGate` `unconfigured` form |
| login (vault) | `VaultGate` `locked` unlock form + recovery unlock |
| password reset | `VaultSettings` recovery-reset form |

All of them carry `required`, so all of them need the fix for the acceptance to hold on
the screens an owner actually meets.

## Fix

1. `noValidate` on every auth/credential `<form>` so the browser never runs its own
   constraint UI.
2. An explicit client validation pass using the **same rules** that were enforced before:
   - non-empty owner name / store name (trimmed — whitespace-only is empty; this also
     folds the issue's note that whitespace names reach the API and surface generically),
   - phone via the shared `normalizeAlgerianPhone`,
   - password `>= MIN_PASSWORD_LENGTH`,
   - vault passphrase `isVaultPassphraseLongEnough`,
   - non-empty confirm (mismatch), recovery key, unlock passphrase.
3. Every message is an existing or new `i18n.ts` key (Arabic only); no literal Arabic in
   component code.
4. `aria-invalid` is set on the blamed field and `aria-describedby` points at the error
   paragraph (which gains a stable `id`).

No auth logic, server, contract, schema, or form-library change. The accept/reject set is
unchanged: everything the browser used to block, the app now blocks explicitly (and
vice-versa).

## New i18n keys

| Key | Copy |
| --- | --- |
| `AUTH_OWNER_NAME_REQUIRED` | اكتب اسم المالك. |
| `AUTH_STORE_NAME_REQUIRED` | اكتب اسم المتجر. |
| `vaultPassphraseRequired` | أدخل كلمة مرور الخزنة. |
| `vaultRecoveryRequired` | أدخل مفتاح الاسترداد. |

`AUTH_PASSWORD_TOO_SHORT`, `INVALID_PHONE_NUMBER`, `vaultPassphraseTooShort`,
`vaultPassphraseMismatch` already exist and are reused — empty is `length < 4`, hence
"too short", which is the existing per-field message.

## Interfaces changed

`App.tsx`
- `AuthErrorField` gains `"ownerName" | "storeName"`.
- `authErrorField(key)` maps the two new keys.
- `useAuthReporter` takes optional `ownerNameRef`/`storeNameRef` (positional, stable refs
  only, so `report` keeps its identity).
- `setupNameKey(ownerName, storeName): MessageKey | null` — the new/trimmed rule.
- Both forms get `noValidate`; name inputs get refs + `aria-invalid`/`aria-describedby`.

`vault-gate.tsx`
- All three forms get `noValidate`.
- `VaultAlert` gets `id="vault-error"`.
- Error state gains a blamed field so `aria-invalid`/`aria-describedby` are correct on the
  passphrase/confirm/recovery inputs.
- Empty unlock passphrase / recovery key are refused before any request.

`vault-settings.tsx`
- Both forms get `noValidate`; empty current passphrase and empty recovery key are refused
  with Arabic copy before any request.

## Planned tests

Component (`bun run test`, real `RequireSession` / `VaultGate` / `VaultSettings`):
- each form asserts `form.noValidate === true`;
- empty login phone → `INVALID_PHONE_NUMBER`, empty login password → `AUTH_PASSWORD_TOO_SHORT`,
  no `signIn` call;
- empty/whitespace owner and store names on setup → the two new keys, no
  `firstTimeSetup` call;
- empty vault setup/unlock/recovery → the Arabic keys, no fetch;
- empty vault reset fields → the Arabic keys, no fetch;
- `aria-invalid` + `aria-describedby` land on the blamed field.

E2E (Playwright):
- `tests/e2e/login.spec.ts`: empty login field shows Arabic; form is `novalidate`; the
  field is still natively invalid (`validity.valueMissing`) proving the app, not the
  browser, is what spoke.
- `tests/e2e/vault.spec.ts`: empty vault setup passphrase shows Arabic without creating
  the vault; the locked unlock form does the same after restart.

## Risks

- **Scope**: covering the vault surfaces too (not only the issue's three names) widens the
  diff. Justified: the vault gate is the first screen, and leaving `required` there leaves
  the reported defect visible. Flagged in the report.
- **No test can render a real native bubble** (happy-dom has none). Mitigation: assert
  `noValidate` structurally, and in Playwright assert the native constraint still reports
  `valueMissing` while the Arabic alert is what renders.
- **`aria-describedby` on the vault alert**: the alert is form-level; the blamed-field
  state keeps the association honest.
