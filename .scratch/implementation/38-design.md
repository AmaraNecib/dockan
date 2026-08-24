# Ticket 38 — item-picker arrow navigation

- **issue:** GitHub #38 — Item picker: arrow-key row navigation
- **base:** `af394f4` (`origin/develop`)
- **scope:** `apps/web/src/components/catalog/item-picker-dialog.tsx` and its unit tests only

## Behavior

The picker keeps the existing debounced `catalogSearch` query, exact-match action,
backdrop close, shared Escape handling, focus trap, and click selection. The ranked
`matches` rows are the keyboard navigation set; the separately rendered exact barcode
hit remains a distinct action as it is today.

- `ArrowDown` advances to the next ranked match and `ArrowUp` moves to the previous.
- Navigation wraps at both ends, matching the existing modal's circular Tab trap and
  avoiding a dead key at either end. With no ranked rows, arrows do nothing.
- The first arrow key establishes the active row; typing a new query or changing the
  result set clears the active row. Enter preserves the current behavior when there is
  no active row (selects the first ranked match), and selects the active row otherwise.
- Selection is exposed through a combobox input's `aria-activedescendant` pointing at a
  stable row id, with a listbox/list-option structure and `aria-selected` on the active
  option. Visual selected state uses the existing stone palette and a stronger focus
  ring; the active option is scrolled into view when navigation changes it.
- Escape remains owned by `useModalDialog`'s capture listener (and the input's existing
  close path), while Tab remains owned by the shared focus trap. No global scanner or
  invoice seams are changed.

## Test seams

The component's public DOM and callbacks are the seams: render an open picker with a
fixture, type a query, dispatch keyboard events to the input, and assert selected item,
ARIA attributes/visual marker, focus-trap behavior, Escape close, backdrop close, and
that a scanner hook regression remains untouched. Tests use the existing deterministic
mocked RPC fixture and act-wrapped polling; no implementation state is inspected.

## Validation

Focused picker tests during implementation, then from the repository root:
`bun run typecheck`, `bun run lint`, `bun run test`, and
`DOKAN_PORT=4322 DOKAN_WEB_PORT=5178 bun run test:e2e -- --workers=1`.
Restore `.dokan-port` and avoid generated database changes. Commit only the component,
test, and this design note if it is tracked by the worktree.
