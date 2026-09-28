# #101 — Design hygiene: last native selects, raw colours, shadcn lint rules

- **Tier:** Standard
- **Base SHA:** `0b4d5a16c793cb775288fd576cddc3dcc62b7d24` (`origin/develop`, fast-forwarded before work)
- **Branch:** `feat/101-design-hygiene`
- **Out of scope:** `apps/web/src/pages/items.tsx` and `apps/web/src/pages/stock.tsx`
  (owned by a sibling hygiene lane). See §4 for the lint override and §6 for the
  documented survivors.

## 1. Controls migrated

The four remaining native `<select>` elements become the themed `Select`
(Base UI `@base-ui/react/select`, wrapped in `apps/web/src/components/ui/select.tsx`).
The reports control had no theme classes (`className="rounded border px-3 py-2"`),
so it fell back to OS rendering — a white panel with unreadable options in dark mode.
The other 28 controls on the app already use this component.

| File | Control | `data-testid` / name | Value → state |
| --- | --- | --- | --- |
| `pages/reports.tsx` | range preset | `report-range-preset` | `toPreset(value)` → `setPreset` |
| `pages/sale.tsx` | quick-add category | `sale-quick-category`, `name="quickCategory"` | `setQuickCategoryId` |
| `pages/sale.tsx` | per-line price override type | `aria-label="${item}: نوع تعديل السعر"` | `toOverrideType(value)` + clears the value |
| `pages/sale.tsx` | invoice discount type | `sale-discount-type`, `name="discountType"` | `toDiscountType(value)` → `setDiscountType` |

Contract (matches the 28 existing usages):

```tsx
<Select
  value={state}
  onValueChange={(value) => setFromValue(value ?? "")}
  disabled={pending}
  name="..."            // preserved where the native select had one
  items={[{ value, label }]}  // so SelectValue can render the label
>
  <SelectTrigger className="w-full" data-testid="..." aria-label="...">
    <SelectValue />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="...">{label}</SelectItem>
  </SelectContent>
</Select>
```

Invariants held: same values, same handlers, same `data-testid`s, same
disabled semantics (`disabled` on the `Select` root), same visible labels.
The reports preset list stays `PRESET_KEYS` (10 options) with the same
`toPreset` fallback for an unexpected value.

## 2. Colour tokens

`apps/web/src/index.css` gains semantic success/warning tokens (danger already
exists as `--destructive`, now with a foreground companion), so light and dark
live in one place and no screen hand-rolls a palette shade.

Registered in `@theme inline`:

```css
--color-success: var(--success);
--color-success-foreground: var(--success-foreground);
--color-warning: var(--warning);
--color-destructive-foreground: var(--destructive-foreground);
```

| Token | Light | Dark |
| --- | --- | --- |
| `--success` | `oklch(0.48 0.15 152)` | `oklch(0.74 0.16 152)` |
| `--success-foreground` | `oklch(0.985 0 0)` | `oklch(0.15 0.02 264)` |
| `--warning` | `oklch(0.50 0.14 62)` | `oklch(0.78 0.15 75)` |
| `--destructive-foreground` | `oklch(0.985 0 0)` | `oklch(0.15 0.02 264)` |

`--warning` has no solid surface in the app, so it needs no foreground
companion; it is used as text and as a `/10`–`/20` tint, which the light/dark
values already make readable (light 5.4:1 on its tint, dark 5.0:1).

Measured WCAG contrast (OKLCH → sRGB → relative luminance):

- `text-success` on light background 5.5:1, on dark card 8.3:1; white on a solid
  `bg-success` 6.0:1.
- `text-warning` on light background 5.7:1, on dark card 8.8:1.
- `text-destructive` on light background unchanged at 4.4:1 (existing token);
  white on solid `bg-destructive` 4.8:1.

Mapping applied (31 raw utilities in the files this lane owns; the other 4
raw-colour survivors are the sibling-lane files in §4 and §6):

| Before | After |
| --- | --- |
| `text-green-700` | `text-success` |
| `bg-green-500/10` | `bg-success/10` |
| `bg-green-700` + `text-white` | `bg-success text-success-foreground` |
| `text-amber-600` | `text-warning` |
| `bg-amber-50`, `bg-amber-500/10` | `bg-warning/10` |
| `border-amber-300` | `border-warning/40` |
| `border-amber-500/30`, `border-amber-600/30` | `border-warning/30` |
| `bg-amber-200` + `text-amber-900` | `bg-warning/20` + `text-warning` |
| `bg-red-700` + `text-white` | `bg-destructive text-destructive-foreground` |

The five hex literals in `index.css` are print-only (`#fff`, `#000` ×2, `#bbb`,
`#555`) and intentionally force a paper-safe black-on-white scheme regardless of
the active theme; forcing them through OKLCH tokens would couple print output to
the screen palette. Documented, kept.

## 3. shadcn lint rules

`oxlint.config.ts` registers `@shadcn/lint` with zero rules today.

Enabled (verified to pass after the cleanup):

- `shadcn/no-raw-colors` — the rule that stops this regression. Requires one
  scoped override for the sibling lane's files (§4).
- `shadcn/no-unknown-classes` — caught real dead classes: `font-display` in
  `app-sidebar.tsx` generated no CSS. Renamed to `font-heading` (identical
  Tajawal face, no visual change) and the intentional `custom` fixture in
  `button.test.tsx` changed to a real utility.
- `shadcn/require-static-classes` — zero violations.

Left off, with the reason the brief asks for:

- `shadcn/no-restyle` — 65 pre-existing findings across `Skeleton` sizing,
  `SelectTrigger`/`Button` layout and `DialogPopup` width. Fixing them is an
  app-wide restyle, not hygiene, and would change layout. Separate lane.
- `shadcn/no-arbitrary-values` — 16 pre-existing findings, most inside the
  vendored `components/ui/*` primitives (`button.tsx`, `card.tsx`, `select.tsx`,
  `dialog.tsx`) where arbitrary values are the upstream authoring style.
- `shadcn/no-inline-styles` — 2 dynamic visual values (`app-sidebar.tsx` width,
  `app-shell.tsx` minHeight). Both are runtime-computed; rewriting them to CSS
  custom properties is behaviour-adjacent churn on navigation shells (#102).

## 4. Lint override for the sibling lane

`items.tsx` and `stock.tsx` still contain four raw-colour utilities. They belong
to the items/stock lane, so this lane does not touch them; `no-raw-colors` is
turned off for exactly those two files with a removal note in the config.

## 5. Raw-HTML audit (item 4)

No native `<select>` element remains anywhere in `apps/web/src` (the only
`<select` string is a doc comment in the new test driver). All four at base were
owned by this lane — `reports.tsx` (1) and `sale.tsx` (3) — so the sibling lane's
files never held a select and contribute only raw-colour survivors (§4, §6).

Other raw elements reviewed:

- `<input>` / `<label>` (sale, reports, returns, expenses): the `Input`
  primitive exists, but ~100 call sites use the raw element with page-level
  classes. A wholesale migration is a restyle, not hygiene, and would change
  sizing. Kept; recorded as follow-up.
- `<button>` (returns accept/reject, expense save): the `Button` primitive has
  no solid success variant; migrating would either add a variant or change the
  visual treatment. Kept raw, now tokenised (`bg-success` / `bg-destructive`).
- `<table>` (reports, sale lines): no shadcn `Table` primitive is vendored
  (`components/ui/table.tsx` exists but is unused here); swapping is restyle
  churn. Kept.
- `<button>`/`<div>` icon actions already carry `aria-label`; no `<div onClick>`
  found in the changed surface.

## 6. Documented survivors

- 4 raw palette utilities in `items.tsx` (2) and `stock.tsx` (2) — sibling lane.
- 5 hex literals in `index.css` print block — intentional, print-only.
- 3 `bg-black/40`–`/45` scrims (`dialog.tsx`, `item-picker-dialog.tsx`,
  `unknown-scan-dialog.tsx`) — the `no-raw-colors` rule treats black/white as
  non-palette, and a scrim is intentionally theme-independent.
- `text-white` on the dashed legacy buttons is a Tailwind named colour; the
  `no-raw-colors` rule treats white/black as non-palette and did not flag them,
  but they were replaced with `*-foreground` tokens anyway.

## 7. Tests

- **Unit (bun test, happy-dom):**
  - `reports.test.tsx`: the preset `Select` opens, lists the 10 presets, selects
    `CUSTOM`, closes, and renders the custom date inputs.
  - `sale.test.tsx`: existing native-`select` helpers are replaced with a
    Base UI driver (open trigger → click option). Covered: quick-add category,
    per-line override type (which reveals the value input and is disabled while
    pending), and discount type (disabled until a line exists).
- **E2E (Playwright):**
  - `sale-checkout.spec.ts`: `.selectOption(...)` on the migrated controls
    replaced with `chooseSelectOption` through `tests/e2e/select-helpers.ts`.
  - `expense-reports.spec.ts`: adds a reports preset interaction proving the
    migrated reports control opens, selects `CUSTOM` and closes.

## 8. Risks

- **Base UI Select in unit tests** is driven by pointer events, not
  `HTMLSelectElement.value`. The driver mirrors `select.test.tsx`; if Base UI's
  event arming changes, the helper is the single place to fix.
- **`SelectValue` label resolution** needs the `items` prop; every migrated
  control passes it. Without it the trigger shows the raw value.
- **RTL:** Base UI handles direction via the `dark`/`dir` context; triggers use
  `ps-*`/`pe-*`, so the chevron stays on the inline-end edge in RTL.
- **Token shift:** light success/warning are slightly darker than
  `green-700`/`amber-600` to clear 4.5:1 on tinted surfaces; hue and identity
  are unchanged. In dark mode the solid accept button moves from the fixed
  `green-700`+white (a raw colour that never adapted) to the system's lighter
  dark-mode accent (`bg-success`) with a dark foreground, matching how
  `--primary` and `--destructive` already lighten in dark.
