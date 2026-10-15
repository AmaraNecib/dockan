# Test-audit evidence — issue #109

- Base: `fc396253edbae19015ee4519272338babee17d34`
- Reviewed source HEAD: `7eb079cd0ec68b2a342c19728021d7dc9060fb3e`
- Method: edge-case hunter + coverage analyst + test-quality reviewer sub-agents,
  three rounds; fixes applied where a gap would hide a real regression.

## Edge-case hunter

Fixed:
- empty confirm in the change form now refused (was a real weakened rule);
- blame now clears on edit in the vault gate and settings;
- cross-field clear (passphrase↔confirm, new↔confirm) on both surfaces.

Reviewed and accepted as matching the prior native rule (no regression):
- vault unlock/recovery/settings empty checks use `=== ""`, so a whitespace-only
  value reaches the request; native `required` also accepted whitespace.
- password/passphrase boundaries: `minLength=4` mirrored in `authFieldKey`; the
  7/8 passphrase floor is pinned in `vault-client.test.ts` and delegated through
  the gate.

## Coverage analyst (acceptance → test)

| Acceptance criterion | Test |
|---|---|
| Empty field ⇒ Arabic from i18n, never a native bubble | `App.test.tsx` (phone, password, owner/store), `vault-gate.test.tsx` (setup/unlock/recovery), `vault-settings.test.tsx` (current/confirm/recovery/reset); e2e `login.spec.ts` + `vault.spec.ts` |
| All forms behave consistently | `form.noValidate` asserted on every touched form |
| Unchanged accept/reject set | valid-path tests (`firstTimeSetupCalls === 1`; existing login/vault valid paths still green) |
| Whitespace-only names do not reach the API | `App.test.tsx` owner and store whitespace cases |
| `aria-invalid` / association correct | field-level `aria-invalid`, `aria-describedby`, and focus asserted on login, setup, all three gate forms, and both settings forms |
| Native rule not weakened | e2e asserts `validity.valueMissing === true` while the Arabic alert renders |

No missing acceptance test at `7eb079c`.

## Test-quality reviewer

Grade: **A−** (round 1 → round 3). New tests are revert-discriminating:
- `App.tsx`: empty password → `signInCalls === 0`; empty/whitespace names →
  `firstTimeSetupCalls === 0`; `noValidate` and `aria-*` asserted.
- `vault-gate.tsx`: empty unlock/recovery would call the API without the guard;
  tests assert `calls === 0`, the Arabic literal, `aria-*`, and focus.
- `vault-settings.tsx`: empty confirm/current/recovery and the clear-on-edit tests
  fail on the pre-fix code.
- e2e pins full literal Arabic and proves the app, not the browser, speaks.

Known residuals (non-blocking, documented in the code review):
- the settings "empty new passphrase" test is a preservation guard (the length
  check pre-existed), not fix coverage;
- old keys (`INVALID_PHONE_NUMBER`, `AUTH_PASSWORD_TOO_SHORT`,
  `vaultPassphraseTooShort`) are asserted via `i18n.t` in unit tests; their
  literals are pinned in e2e.

## Commands

```
cd apps/web && bun test src/App.test.tsx src/components/vault/vault-gate.test.tsx src/components/vault/vault-settings.test.tsx
# 62 pass, 0 fail
bun run test        # workspace, 973 pass, 0 fail
bun run test:e2e    # 59 passed (isolated quadruple, see guard-verification)
```
