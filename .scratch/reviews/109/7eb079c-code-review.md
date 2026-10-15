# Code-review evidence — issue #109

- Fixed point: `fc396253edbae19015ee4519272338babee17d34` (origin/develop merge-base)
- Reviewed source HEAD: `7eb079cd0ec68b2a342c19728021d7dc9060fb3e`
- Diff: `git diff fc39625...7eb079c` (10 files; source + tests + design doc)
- Method: Standards + Spec sub-agents, three rounds.

## Standards

No hard documented-standard breach. `docs/engineering-workflow.md` (Arabic-first
copy via i18n), the source-only commit policy, and `AGENTS.md` port isolation are
all honoured. `bun run lint` (oxlint + anti-slop) is clean.

Baseline smells (judgement calls, accepted or deferred):

1. **Duplicated Code — password rule.** `App.tsx` repeats
   `password.length < MIN_PASSWORD_LENGTH` in `authFieldKey` and in `LoginPage`.
   Judgement call: login still derives `normalizedPhone` separately, so reusing
   the helper would not remove the duplication cleanly. Not fixed.
2. **Duplicated Code / Divergent Change — error-state mechanism** now exists in
   three variants (`useAuthError` in `App.tsx`, `error`+`errorField` in
   `vault-gate.tsx`, `error`+`errorField`+`showError` in `vault-settings.tsx`).
   Behaviour-correct and tested; extracting a shared hook is a cross-module
   refactor, **deferred** (no correctness impact).
3. **Field→ref ternary ladder** in `vault-settings.tsx` mirrors `authTarget`.
   Accepted at this tier; same deferred refactor covers it.
4. **Mixed test style** — new keys pinned as literal Arabic, older keys via
   `i18n.t`. Judgement call: the literals are the deliberate anti-self-reference
   pin; older keys are pinned in e2e.
5. **`required`/`minLength` retained** alongside the app checks. Intentional:
   `noValidate` suppresses only the browser UI, and the e2e `valueMissing`
   assertion depends on the attributes remaining. Not a smell.
6. **e2e timeout additions** (`VAULT_KDF_TIMEOUT_MS = 20s`, serial describe
   `120s`). Justified: Argon2id measures ~9.2s on this loaded box vs Playwright's
   5s expect default; `backups.spec.ts` already uses bounded timeouts. Disclosed
   as incidental to #109.

## Spec

| Requirement | Status |
|---|---|
| `noValidate` + app-side validation, all messages from `i18n.ts` | Met (all seven auth/credential forms) |
| Empty-field coverage: owner, store, phone, password, vault passphrase, recovery key | Met |
| Keep #100 per-field messages and focus behaviour | Met (extended to the vault surfaces) |
| Whitespace-only owner/store names no longer surface generically | Met (`setupNameKey` trims, matching `firstTimeSetupInputSchema`) |
| `aria-invalid` / association correct, Arabic via i18n | Met on every named surface (field-level aria + focus + clear-on-edit) |
| No auth-logic change; same credentials succeed/fail | Met (rules re-expressed, native attributes kept) |
| No server/contract/schema change; no new form library | Met |
| Do not weaken validation | Met after round-1 fix (the empty-confirm hole was the one regression) |

Scope notes:
- **Vault surfaces and vault settings** go beyond the issue's literal "login /
  first-run setup / password reset" names, but ADR-0008 §4.6 makes the vault gate
  the real first screen and the reset form the real password reset. Justified in
  `109-design.md` Risks.
- **`tests/e2e/vault.spec.ts` timeouts** are unrelated flake work, kept and
  disclosed.

Accept/reject set: provably unchanged. `firstTimeSetupInputSchema` is
`z.string().trim().min(1)` for `ownerName`/`storeName`
(`packages/contracts/src/core.ts:809-817`), so whitespace-only names already
failed server-side; the client now refuses them earlier with Arabic copy.
`required`/`minLength`/`maxLength` attributes are untouched, and no path was found
that newly accepts a previously-rejected input.

Residual (non-blocking): the settings "empty new passphrase" test is a
preservation guard rather than fix coverage; a future refactor could silently
regress the vault error-state duplication (see Standards item 2).
