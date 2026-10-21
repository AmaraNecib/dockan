# #322 — No screen shows a raw translation key

## Tier

**Standard.** UI copy plus a typing change on the web bundle. It touches no auth/RBAC, no
backup/restore, no invoice or debt money math and no schema version, so none of the five
High-assurance failure modes applies.

Target branch `develop`, merge-base `ae9e416a`.

## The change

`apps/web/src/lib/i18n.ts` holds the only catalogue. It exports `MessageKey`, but `t` was the
library's untyped function, so nothing connected the two and a missing key rendered as its own
identifier on screen.

1. Augment `i18next`'s `CustomTypeOptions` beside `MessageKey`, so `t` — through
   `useTranslation`, `i18n.t` and `TFunction` — is checked against the catalogue.
2. Widen the resource *values* from `as const` to `satisfies`, keeping the keys literal.
   With `as const`, `t()` returned the Arabic copy as a literal string type, which broke
   `useState(t(...))` and every `string` parameter it was passed to. Widening values leaves the
   key set exact, which is the property this issue needs, and returns `string`, which is what
   every call site means.
3. Fix what the compiler reports by adding copy or by typing the intermediate table — never a
   cast, an ignore, or `@ts-expect-error` in production code.

## Seams under test

- `VaultGate` rendered with `status.state === "invalid"` — the owner-facing screen named in the
  issue. Test lives in the existing `vault-gate.test.tsx`.
- The compiler itself, for the typing. Asserted in `i18n.test.ts`: a key that is not in the
  catalogue must be a compile error, and the assertion inverts if the augmentation is removed.

## Risks

- `apps/web/src/pages/{purchase,invoice,debts}.tsx` belong to another lane. Only
  compiler-forced edits there, and they are named in the report.
- A dynamic key (`t(\`pmtMethod_${x}\`)`) cannot be checked by construction. Where the value is a
  closed union, the fix is to type the field with the contract's union so the template literal
  collapses to a literal key union. Where the value is genuinely open (log event codes), the fix
  is a typed table plus an honest fallback.
