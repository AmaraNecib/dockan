# button

2026-08-25, golden pair via CLI (radix-nova/base-nova registry URLs), migrated.

## Changed

- `apps/web/src/components/ui/button.tsx`: swapped `Slot` from `radix-ui` for the
  real `@base-ui/react/button` primitive (`ButtonPrimitive`). The radix-era
  Slot/asChild manual idiom was replaced by the Base UI `render` prop on the
  primitive; the wrapper is now `<ButtonPrimitive data-slot="button" ...>`.
- Kept the exported API identical to before: `Button`, `buttonVariants`,
  `variant`, `size`, and the `asChild` compat prop. No consumer in the repo
  uses `asChild` today (verified by grep), but the prop is preserved so call
  sites never change; internally `asChild` forwards the single child element to
  the primitive's `render` prop (Radix `Slot.Root` equivalent). The Base UI
  `render` prop is also available for future consumers.
- Class strings: byte-identical to the previous file, including the repo's
  logical-direction variants (`pe-2`/`ps-2`) and `data-variant`/`data-size`/
  `data-slot` attributes.
- `apps/web/src/components/ui/button.test.tsx` (new): render tests for default
  render, variant/size classes, native prop forwarding, `disabled`, and the
  `asChild` compat path (child element gets the button classes).
- `apps/web/package.json` / `bun.lock`: `@base-ui/react@^1.7.0` added,
  `radix-ui` removed (final removal, see project.md).
- `apps/web/components.json`: style `radix-nova` -> `base-nova` (flip only valid
  once the last radix wrapper is gone; see project.md).

Leftover sweep: `grep -n "radix-ui\|@radix-ui\|IconPlaceholder"` on this
component's files is clean.

## Left alone

- `card.tsx`, `input.tsx`, `skeleton.tsx`, `table.tsx`: no radix usage at all
  (plain styled elements), untouched. `table.tsx` still carries a
  radix-era-looking `data-[state=selected]` class that is a plain CSS selector,
  not a radix dependency; left as-is to avoid styling drift.

## Behavior changes

- None for the wrapper's consumers. Base UI Button renders a native `<button>`
  by default; the compat `asChild` path renders the child element with the
  button props merged in (same net DOM as Radix Slot).

## Verify by hand

- Open any screen with buttons (backups page, unknown-scan dialog): default,
  outline, ghost variants render and click.
- A button inside a form submits; a disabled button does not fire onClick.
- If any future code uses `<Button asChild><Link/></Button>`, confirm the link
  renders with button classes and still navigates.