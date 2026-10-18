# 167 — Code review (Standards + Spec)

**HEAD reviewed:** `15c39ea484e98e9667bd7a956808142ae90958d7`
**Base:** `0b4ec68f6d744cf9397530b3e58978943bffd740` (`origin/develop`)
**Diff:** `git diff 0b4ec68f6d744cf9397530b3e58978943bffd740...15c39ea484e98e9667bd7a956808142ae90958d7`
**Commits:** `15c39ea fix(web): give every password field an app-controlled reveal eye (closes #167)`

Two read-only sub-agents, one per axis.

## Standards

Verdict: **PASS** — no hard standard violations.

Verified: React 19 ref-as-prop matches the `ComponentProps` convention used by
`ui/input.tsx` and `ui/label.tsx`; anti-slop rules honoured (no `typeof`,
`unknown`, or widening; every type assertion carries a `SAFETY:` comment);
tracking `.scratch/implementation/167-design.md` matches repo practice (only
`.scratch/sessions/` is ignored). No `data-*`/`typeof`/`unknown` lint debt.

Judgement-call notes and dispositions:

1. *Duplicated Code* — the click-toggle-assert shape recurs across five test
   hunks. **Dismissed:** each hunk exercises a different consumer (unit
   component, vault-gate, vault-settings, App, e2e); a shared helper would
   couple five otherwise-independent files.
2. *Shotgun Surgery* — the global `::-ms-reveal` suppression means a future
   password field must remember `PasswordInput`. **Accepted and documented** in
   the design (§Risks); the adoption tests are the tripwire.
3. *Visual drift in vault-settings.* Those four fields previously used bare
   `rounded border px-3 py-2`; they now match the vault-gate/App fields
   (`border-input bg-background`, logical padding). **Accepted:** it is the
   cross-field consistency the brief asks for, but the design's "layout-neutral"
   wording was corrected to state it.
4. *Hand-rolled ref merge* (`if ("current" in ref)`). **Kept:** one call site
   needs a forwarded ref and the component needs the same node for focus
   hand-back; no `typeof`/widening. A dedicated ref-merge dependency is not
   warranted.
5. *`data-testid` in the public props type.* **Kept:** the brief lists
   `data-testid` as a required prop.
6. *No-op narrowing alias* `const firstToggleButton = firstToggle;` in
   `vault-gate.test.tsx`. **Deferred (non-blocking cosmetic):** behaviourally
   inert; changing it would invalidate this evidence SHA for a style nit.

## Spec

Verdict: **PASS** — every brief bullet lands; no DO-NOT-TOUCH file and no
lockfile touched (12 files changed).

- One shared `PasswordInput`; all listed props pass through; label wiring kept
  by the existing wrapping `<label>`.
- `type="button"` toggle, exact Arabic `aria-label`s, `aria-pressed`, always
  rendered.
- `password`⇄`text`, survives repeated toggles and typing.
- Both vault setup fields identical: text at the right edge, `pe-10` gutter,
  eye at `absolute end-1` (left under `dir="rtl"`), asserted in the browser.
- Theme tokens only; light and dark both repaint.
- `index.css` — exactly one rule appended at the end (`input[type="password"]::-ms-reveal`).
- Applied to vault-gate (setup + confirm + unlock), vault-settings
  (current/new/confirm), App.tsx (login + first-run).
- Existing `vault-gate.test.tsx` / `vault-settings.test.tsx` remain green.

Judgement-call notes and dispositions:

1. *Scope: the recovery-reset passphrase (9th field).* **Accepted:** the global
   native-reveal suppression would otherwise leave it with no eye; same file,
   documented in the design.
2. *The issue body says "the eye at the field's inline-start…".* That conflicts
   with the issue's own report ("text goes left, eye goes right" is the bug) and
   with the brief ("eye button pinned to the left edge"). The implementation
   follows the report and the brief — eye on the **left** in RTL. The issue
   wording is inverted and needs an owner reconciliation on the PR; it is not a
   code defect.
3. *vault-settings fields gain `border-input bg-background`.* Accepted, see
   Standards note 3.

## Tests / gates at this HEAD

- `bun run typecheck` — 0
- `bun run lint` — 0
- `bun run test` — 640 pass / 0 fail
- `bunx playwright test tests/e2e/vault.spec.ts tests/e2e/login.spec.ts` — 6 pass / 0 fail
