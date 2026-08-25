# label

2026-08-25, golden pair via CLI (radix-nova/base-nova registry URLs), migrated.

## Changed

- `apps/web/src/components/ui/label.tsx`: removed `Label` from `radix-ui`
  entirely. Base UI has no Label primitive (per the mapping docs: native
  `<label>` / `Field.Label` inside forms), so the wrapper now renders a native
  `<label>` element with `React.ComponentProps<"label">`. `data-slot`,
  className, and the exported `Label` name are unchanged.
- `apps/web/src/components/ui/label.test.tsx` (new): render tests for the data
  slot + base classes and `htmlFor` forwarding.
- Dependency/combo changes shared with button and select: see project.md.

Leftover sweep: `grep -n "radix-ui\|@radix-ui\|IconPlaceholder"` on this
component's files is clean.

## Left alone

- No other files: label had zero consumers in app code (verified by grep of
  `@/components/ui/label` and component-name usage).

## Behavior changes

- None. Radix Label's `Root` already rendered a `<label>`; the native element
  is behaviorally equivalent (association via `htmlFor`, peer/group state
  selectors in the className unchanged).

## Verify by hand

- Settings or any future form: label text renders, clicking it focuses the
  associated input, `data-slot="label"` present.