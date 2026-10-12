# 167 — Password fields: app-controlled show/hide eye (RTL alignment + native reveal vanishes)

**Tier:** Standard (UI)
**Base:** `0b4ec68f6d744cf9397530b3e58978943bffd740` (`origin/develop`)
**Branch:** `fix/167-password-eye`

## Problem

There is no app-controlled reveal control anywhere. Every password field is a
plain `<input type="password">`, so the eye the owner sees is the
Chromium/WebView2 **native password-reveal button**. Two consequences:

1. **RTL misalignment.** In the vault setup screen only the *confirm* field
   renders text-left / eye-right; the first field is correct. The native button
   is positioned by the browser, not by us, and the two fields disagree.
2. **The eye vanishes.** After one reveal the native control does not come back
   while the field stays on the page, so it cannot be toggled again.

The native button cannot be styled, positioned, annotated or trusted. It is
replaced by one shared component. This is a low-priority owner report, but the
same defect exists in all eight password fields in the app, so the component is
applied everywhere a password is typed.

## Interfaces

**New component** `apps/web/src/components/ui/password-input.tsx`.

```ts
type PasswordInputProps = Omit<React.ComponentProps<"input">, "type">;

export function PasswordInput(props: PasswordInputProps): ReactNode;
```

- Renders a `relative` wrapper, the `<input>` and one toggle `<button>`.
- `type` is owned by the component: `password` ⇄ `text` (React 19 ref-as-prop
  means `ref`, `name`, `value`, `onChange`, `autoComplete`, `required`,
  `minLength`, `aria-invalid`, `aria-describedby`, `data-testid` and the rest
  pass straight through to the input).
- The toggle is always in the tree while the field is mounted; it is
  `type="button"` (never submits), carries `aria-pressed={revealed}` and an
  `aria-label` of `hidePassword` / `showPassword`.
- After a toggle, focus returns to the input (the native control kept the
  caret in the field), and the toggle is `disabled` whenever the field is.
- The toggle test id is derived: `<data-testid>-toggle`.
- **Placement:** the wrapper and the input use logical properties — input text
  starts at `inline-start` (`ps-3`, the right edge under `dir="rtl"`), the eye
  is pinned to `inline-end` (`end-1`, the left edge) and the input reserves the
  room with `pe-10`. Both fields use the same component and no per-instance
  class, so they cannot mirror.

**i18n keys** (added to `apps/web/src/lib/i18n.ts`): `showPassword`
(«إظهار كلمة المرور») and `hidePassword` («إخفاء كلمة المرور»).

**CSS** — one appended rule in `apps/web/src/index.css`:
`input[type="password"]::-ms-reveal { display: none; }`. This suppresses the
native Chromium/WebView2 control app-wide, so a field can never show two eyes.
Because the suppression is global, **every** password field must use
`PasswordInput`, or it would lose its reveal control.

**Consumers** (9 fields, all in scope):
- `components/vault/vault-gate.tsx` — setup passphrase + confirm, unlock
  passphrase.
- `components/vault/vault-settings.tsx` — current / new / confirm, and the
  recovery-reset new passphrase (a password field in the same file).
- `App.tsx` — first-run password (`setup-password`) and login password
  (`login-password`).

## Dependencies

None added. `lucide-react` (already a web dependency) supplies `Eye`/`EyeOff`;
the existing i18n catalogue and Tailwind theme tokens are reused.

## Planned tests

*Unit (`apps/web/src/components/ui/password-input.test.tsx`, bun + happy-dom):*
the toggle survives repeated clicks and flips `type` `password`↔`text`; the
button is `type="button"` and a click inside a form does not submit it;
`aria-pressed`/`aria-label` track the state; the ref still points at the input
(App relies on it); the same input node survives a reveal/hide round trip;
focus returns to the input; a disabled field disables its toggle.

*Component (`vault-gate.test.tsx`, `vault-settings.test.tsx`, `App.test.tsx`):*
the two setup passphrase fields render with identical input classes and
identical toggle classes (pinned with `pe-10`), each with a `type="button"`
toggle; revealing one field leaves the other hidden; the setup flow still
submits after a double toggle; all four vault-settings password fields and both
App password fields have a toggle that flips their `type`.

*E2E (`tests/e2e/vault.spec.ts`, first serial test on the unconfigured state):*
both setup fields start hidden and carry a visible toggle; the toggle sits on
the same side of both fields (measured from the field box) and on the left edge;
the eye repaints under dark mode; toggling twice flips `type` and the button is
still visible after further typing. happy-dom has no layout, so class parity is
the unit proxy and the Playwright box measurement is the real geometry check.

## Risks

- **Label nesting.** Each field stays inside its existing `<label>`, so the
  toggle button is a label descendant. The input is the first labelable
  element, so the label still names the input; the button is interactive
  content, so clicking it does not forward label activation. Playwright
  `getByLabel("كلمة السر")` is asserted green by the existing auth e2e specs.
- **Two eyes.** If `PasswordInput` misses a field, the global `::-ms-reveal`
  suppression leaves that field with no reveal at all. All 9 `type="password"`
  sites are converted; a grep of `apps/web/src` shows none left.
- **Toggle steals field focus — resolved.** Clicking the native control kept the
  caret in the field, so the toggle hands focus back to the input. A disabled
  field also disables its toggle.
- **Visual drift.** The component uses the vault-gate/App field classes
  (`border-input bg-background`, logical padding) rather than adopting
  `ui/Input`, so the setup/login fields are unchanged apart from the reserved
  `pe-10` gutter on the inline end. The four `vault-settings` fields previously
  used a bare `rounded border px-3 py-2`; they now match the other fields, which
  is the cross-field consistency the brief asks for (not merely layout-neutral).
- **Shared CSS file.** `index.css` is shared with lanes #159/#160; the rule is
  appended once at the end, touching nothing else.
