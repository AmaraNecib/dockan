# Issue #248 — extract one focus mechanism for the two clear-filters hand-offs

Tier: **Standard**. Justification: the diff moves keyboard-focus hand-off code in
two list pages; it cannot touch a money path, auth/RBAC, backup/restore or a
schema (the five High-assurance failure modes in `docs/engineering-workflow.md`).

Base: `origin/develop` @ `bb6a4a286d71b6cd1beeaae1a1c8bc8a809b12be` (#245 landed there).

## Problem

`invoices.tsx` and `expenses.tsx` each hand focus out of a clear-filters button
that unmounts when the empty state is replaced:

- `invoices.tsx`: policy = last-changed, else a non-empty filter, else kind →
  `document.querySelector(...)?.focus()`.
- `expenses.tsx`: policy = last-changed testid, else the range preset →
  `previous ?? fallback`, then `.focus()`.

The mechanism (`querySelector('[data-testid=...]')?.focus()`) is duplicated. The
policies are not: invoices falls back through a non-empty filter and then kind;
expenses falls back to the range preset. #245's review approved both policies and
deferred the duplication.

## Seam — mechanism, not policy

One helper in `apps/web/src/lib/focus.ts`:

```ts
/**
 * Focus the element rendered with this testid, and report whether focus moved.
 *
 * Returns false when the testid is not in the document, so a caller can fall
 * back deliberately instead of silently leaving focus on `document.body`. The
 * helper owns no fallback policy: which testid to try, and what to do when it
 * is gone, stay with the caller.
 */
export function focusByTestId(testId: string): boolean
```

- Location follows the project convention for shared UI helpers: `apps/web/src/lib/`
  (`numeric-input.ts`, `draft-blankness.ts`, `pagination.ts`, `use-modal-dialog.ts`).
- Contract: `document.querySelector<HTMLElement>('[data-testid="<testId>"]')`;
  `null` → `return false`; otherwise `focus()`, then return
  `document.activeElement === target`. "Moved" means the element now owns focus.
- Return type is `boolean`, not `void`, so the expenses fallback is a deliberate
  branch rather than an invisible no-op (the failure these hand-offs exist to
  prevent is focus resting on `document.body`).
- **The helper does not own any fallback policy.** Invoices' last-changed →
  non-empty → kind chain and expenses' last-changed → range-preset fallback stay
  in their page, unchanged.

## Callers (behaviour-preserving)

`invoices.tsx` — computes `filter` from its own policy, clears state, then
`focusByTestId(filter)`. Order (state reset before focus) is preserved: the kind
and status triggers survive the reset.

`expenses.tsx` — `const moved = last !== null && focusByTestId(last); if (!moved)
focusByTestId("expense-range-preset");` and the same "focus before state reset"
order `clearHistoryFilters()` already had (the pill must still be mounted when it
is focused).

## Planned tests

- **Untouched contract:** the five focus tests from #245 round 4 (invoices ×1,
  expenses ×4) plus the two other invoice focus assertions. The test files must
  not change; `git diff` on them must be empty.
- New `apps/web/src/lib/focus.test.ts` (unit) for the two outcomes the callers
  branch on: moves focus and returns `true`; returns `false` when the testid is
  not rendered, leaving the previous focus alone.

## Implementation risks

- Accidentally unifying the two fallback policies. Mitigation: each caller keeps
  its own policy expression verbatim; the helper takes a testid only.
- Changing the order of focus vs state reset. Mitigation: keep each caller's
  existing order; the tests assert `document.activeElement` after the clear.
- Silent-drop regression on a renamed testid: the boolean is ignored by invoices
  (whose target always renders) and used by expenses (whose target can unmount);
  the "recorded pill is gone" test pins the fallback.

## Deferred

No new E2E spec: the behaviour is a happy-dom-observable focus move on two unit
page suites, consistent with #96 round 4's recorded deferral.
