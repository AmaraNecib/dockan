# 167 — Test audit

**HEAD reviewed:** `15c39ea484e98e9667bd7a956808142ae90958d7`
**Base:** `0b4ec68f6d744cf9397530b3e58978943bffd740` (`origin/develop`)
**Tier:** Standard
**Method:** three read-only sub-agents (edge-case hunter, coverage analyst, quality reviewer) over the changed tests and implementation.

## Coverage map (acceptance criterion → test)

| Criterion | Test |
|---|---|
| Shared `PasswordInput`, applied everywhere | unit component tests + adoption tests in `vault-gate.test.tsx`, `vault-settings.test.tsx`, `App.test.tsx`; e2e `vault.spec.ts` |
| `type="button"`, never submits, always mounted | `password-input.test.tsx` "never submits the surrounding form", "keeps the toggle mounted…" |
| `aria-label` / `aria-pressed` | `password-input.test.tsx` "exposes the toggle state…" |
| `password`⇄`text`, survives repeated toggles + typing | `password-input.test.tsx` "keeps the same input node and its text…"; `vault-gate.test.tsx`; e2e |
| RTL: text right, eye left, both fields identical | `vault-gate.test.tsx` class parity + `pe-10`; e2e real box geometry (`firstOffset === confirmOffset`, `< width/2`, `direction: rtl`) |
| Light + dark theming | e2e: eye repaints after `.dark` is applied |
| Native `::-ms-reveal` suppressed | rule at `apps/web/src/index.css:661`; adoption tests guard the other half (a field left without the component would now have no eye) |

## Findings and dispositions

**Fixed**

1. *High — focus loss.* Clicking the toggle moved focus to the button; the native control kept the caret in the field. Component now hands focus back to the input; test `"returns focus to the input after a toggle"` added.
2. *High — disabled field kept a live eye.* `disabled` now propagates to the toggle; test `"disables the toggle together with the field"` added.
3. *High — two-field independence untested.* `vault-gate.test.tsx` now reveals the first setup field and asserts the confirm field stays `password` with `aria-pressed="false"`.
4. *Weak assertion — node identity.* The old "typed text" test re-applied a static value and would pass across a remount. Now captures the input node and asserts `inputOf(host) === before` across the round trip, plus a stateful harness.
5. *Vacuous assertions.* `expect(toggleOf(host)).not.toBeNull()` could not fail (the helper throws). Presence checks now query directly via `queryToggle`.
6. *Tautological class parity.* Added `expect(first.className).toContain("pe-10")`, so dropping the reserved gutter cannot read as "identical".
7. *7 of 9 adoption sites untested.* Added: one `vault-settings` test covering all four password fields (current/new/confirm/reset-new) flipping `type`, and two `App.test.tsx` tests (login + first-run) asserting the toggle exists, is `type="button"`, and flips `type`.

**Dismissed (with reason)**

- *No assertion for the `::-ms-reveal` CSS text.* Asserting a stylesheet string is a tautology; the behaviour it buys — "a password field must not be left without an eye" — is covered instead by the adoption tests on all four files.
- *"dark/light untested"* (unit). happy-dom has no cascade; the real assertion lives in Playwright (computed `color` changes under `.dark`).
- *Darker mode was applied by class rather than the app's theme toggle.* The app's `ThemeProvider` is not reachable from the pre-boot vault gate; the class is the toggle's own mechanism and is removed after the assertion.

## Result

`bun run test`: 640 pass / 0 fail (49 files).
`bunx playwright test tests/e2e/vault.spec.ts tests/e2e/login.spec.ts`: 6 pass / 0 fail.
