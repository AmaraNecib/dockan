# A new-tab click still fires the anchor's onClick — mirror the router's guard

**Date:** 2026-10-15 · **Ticket:** 184 · **Area:** apps/web/src/pages/supplier-opening-balance.tsx

The back `<Link>` on the opening-balance screen abandoned the confirmation in its
`onClick`. A Ctrl/Cmd/middle-click opens the supplier list in a **new tab**, but
the current tab's handler still ran: it closed the dialog and bumped the
dismissal generation, so the refusal recovery would not restore it — in a tab the
owner never left. This is a class of bug, not a one-off: any `onClick` that
performs a *teardown* (abandon an attempt, clear state, mark left) must not fire
for a gesture that does not navigate the current tab.

0. **Guard teardown-on-click with the browser's own activation rule, not a
   subset.** An in-tab activation is a primary button (`button === 0`) with no
   `metaKey`/`ctrlKey`/`shiftKey`/`altKey` **and** an anchor target of `_self`
   (or none). Omit the `target` term and someone later adding `target="_blank"`
   reintroduces the bug on a plain click. TanStack's own link handler
   (`@tanstack/react-router` `link.js`) is the reference: it also checks
   `defaultPrevented` and `disabled` (the latter is a button concept).
   `defaultPrevented` was unreachable for our handler because it runs first in
   `composeHandlers`; the `target` term was the one that mattered.

1. **Test one case per conjunct.** A five-term predicate with only a Ctrl-click
   test stays green when any other term is deleted. `NEW_TAB_ACTIVATIONS` pairs
   Ctrl/Cmd/Shift/Alt and a non-primary button; deleting `!event.metaKey` fails
   exactly the Cmd case. Pair the new-tab assertion with a **plain-click
   control** that asserts the teardown *did* happen, or the suite can pass by
   never abandoning at all.

2. **`click` never carries a middle button.** Real middle-click emits `auxclick`,
   which React's `onClick` never sees; a synthetic `click` with `button: 1` only
   pins the predicate branch (worth saying so in the test comment).

3. **Do not let a button-based dismissal look like the same hole.** The page
   Cancel and dialog Cancel are `<Button type="button">`: they have no `href`, so
   modifier-clicks carry no new-tab semantics, and they navigate the current tab
   themselves. The back `<Link>` was the only navigate-gesture dismissal, so one
   guarded call site was the whole class fix.
