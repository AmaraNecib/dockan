# select

2026-08-25, golden pair via CLI (radix-nova/base-nova registry URLs), migrated.

## Changed

- `apps/web/src/components/ui/select.tsx`: rewired `Select` from `radix-ui` to
  `@base-ui/react/select` per the golden base-nova variant, preserving the
  repo's local class customizations (logical-direction `pe-2`/`ps-2`/`end-2`
  classes, lucide-react icons instead of registry IconPlaceholder, no
  `cn-menu-target`/`cn-menu-translucent` helper classes). No `"use client"`
  directive (project is `rsc: false`; original files had none).
- Part mapping applied: `Viewport` -> `List`; `ScrollUp/DownButton` ->
  `ScrollUp/DownArrow`; `Label` -> `GroupLabel`; `Icon`/`ItemIndicator`
  `asChild` -> `render`; `Content` -> `Portal > Positioner > Popup` with
  `side`/`sideOffset`/`align`/`alignOffset`/`alignItemWithTrigger` declared,
  destructured, and forwarded to the Positioner (the forward rule).
- `position` prop (radix `"popper"`/`"item-aligned"`) replaced by
  `alignItemWithTrigger` boolean with default `true` (`item-aligned`
  equivalent); `position="popper"` callers would pass
  `alignItemWithTrigger={false}` if any existed — none do (zero consumers).
- CSS var renames per class-mapping.md: `--radix-select-content-available-height`
  -> `--available-height`, `--radix-select-content-transform-origin` ->
  `--transform-origin`, `--radix-select-trigger-width` -> `--anchor-width`
  (popper sizing moves from the Viewport to the Popup via `w-(--anchor-width)`).
- `Select` is now an alias of `SelectPrimitive.Root` so the Root props
  (including `items`) pass through; `SelectValue` gained the registry's
  `flex flex-1 text-left` base classes.
- `apps/web/src/components/ui/select.test.tsx` (new): render tests covering
  trigger + value + chevron icon, popup open via trigger pointer interaction,
  item listing inside the list, group label/separator rendering, and item
  selection updating `onValueChange` + the trigger value.
- Dependency/combo changes shared with button and label: see project.md.

Leftover sweep: `grep -n "radix-ui\|@radix-ui\|IconPlaceholder"` on this
component's files is clean; no `--radix-*` CSS vars remain anywhere in apps/web.

## Left alone

- No other files: select had zero consumers in app code (unknown-scan-dialog
  and backups.tsx only import Button from the ui dir; no Select usage exists
  anywhere in apps/web). The wrapper API is therefore free to expose the Base
  UI posture directly.

## Behavior changes

- FLAG: Base UI `SelectValue` renders the item LABEL from the Root `items` prop
  (or a `children` render function / `placeholder`). With radix, the value
  displayed the item's text content once the popup was touched. Consumers that
  want labels in the trigger must pass `items` (or use `SelectValue` children),
  otherwise the raw value string is shown. Zero current consumers, so nothing
  to change today; new select code should pass `items`.
- FLAG: scroll buttons are absolutely positioned (`top-0`/`bottom-0`) overlay
  arrows in the popup, per the registry shape, instead of radix's
  viewport-integrated buttons. Visual only.
- The radix `position="popper"` per-side translate classes are gone (base
  golden omits them; the popup animates via `data-[side=...]:slide-in-from-*`).

## Verify by hand

- In a future select screen: open the list, keyboard-arrow through items
  (highlighted row has `data-highlighted`), Enter commits, Escape closes,
  typeahead selects by first letter.
- Select with `items` on Root: trigger shows the item label; without `items`,
  it shows the raw value (documented above).
- RTL layout: popup opens on the correct side; the check indicator sits at the
  logical end of the row.