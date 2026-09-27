# Issue #94 — Learnability refinement (design)

Tier: **Standard**. Base: `origin/develop` @ `3242cfc`. Branch: `feat/94-learnability`.

## Problem

Six verified findings make Dokan hard to learn for a shop owner who is not a
daily computer user:

1. Sidebar defaults to collapsed (icon-only) on a fresh install.
2. The sale screen's finish action falls below the fold at 1280×720 / 1024×768.
3. Three equal-weight "add product" buttons on the sale screen.
4. Discount controls occupy prime space on an empty invoice.
5. Empty states are muted sentences that name nothing pressable.
6. Panels and background are the same value, so nothing reads as important.

Scope is refinement: the deep-blue OKLCH palette, Tajawal, RTL, page
structure, and dashboard information architecture all stay. No money/stock/
debt/calculation behaviour changes.

## Component interfaces

### `apps/web/src/components/app/app-shell.tsx`

```ts
/** Collapsed only when the owner explicitly collapsed it. */
export function readSidebarCollapsed(): boolean; // unset | "false" | stale -> false; "true" -> true
```

Header gains the toolbar neutral layer (`bg-sidebar`), which is already a
contrast-tested surface.

### `apps/web/src/components/app/app-sidebar.tsx`

No prop changes. `NavLink` adds `aria-label={collapsed ? t(item.labelKey) : undefined}`
so a collapsed link keeps an accessible name; `title` stays as the tooltip.

### `apps/web/src/components/ui/empty-state.tsx` (new)

```tsx
interface EmptyStateProps {
  title: string;
  hint?: string;
  icon?: ReactNode;      // aria-hidden by the caller
  action?: ReactNode;    // the single pressable next step
}
export function EmptyState(props: EmptyStateProps): ReactElement;
```

Teaching empty state: title names the next step, hint explains how, action is
the pressable control. No nested card, no dashed decoration.

### `apps/web/src/pages/sale.tsx`

- Toolbar row inside the lines panel: `h2` (`invoiceLinesTitle`) + primary
  `sale-open-picker` (only when lines exist) + demoted outline
  `sale-quick-add` / `sale-quick-stock-add` (always present, testids kept).
- Empty lines: `EmptyState` whose action is the primary picker button with the
  `sale-open-picker` testid (exactly one picker button on screen at any time).
- Lines exist: the discount block, totals, debt notice, error, and
  `sale-save` move into a `sticky bottom-0` checkout bar (`sale-checkout-bar`)
  inside the scrolling `main`, so the finish action is always in the viewport.
  Discount controls are therefore present only once a line exists.
- Calculation/handlers unchanged; only the render tree moves.

### `apps/web/src/pages/purchase.tsx`

Same pattern: `EmptyState` with the `purchase-open-picker` action when empty;
`purchase-toggle-quick` stays in the header; total + error + `purchase-save`
move to a sticky bar (`purchase-checkout-bar`) when lines exist.

### `apps/web/src/pages/debts.tsx`

Each empty group renders `EmptyState` with a group-specific hint and a link
action (`/sale` for "owed to us", `/purchase` for "we owe"). Unicode ▲/▼
chevrons become lucide `ChevronUp`/`ChevronDown` (`aria-hidden`).

### `apps/web/src/pages/dashboard.tsx`

Recent-invoices empty state teaches with a `بيع جديد` link. Low-stock empty
stays a plain success message (there is no next action for "nothing low").

### Tokens (`apps/web/src/index.css`)

- Light: page background one step below the raised white card; sidebar/toolbar
  a second, slightly cooler neutral. Border slightly stronger. This is the
  "second neutral layer" lever for the flatness.
- Browser surfaces themed from the palette: `::selection`, `caret-color`,
  `scrollbar-color`; headings get `text-wrap: balance`.
- `prefers-reduced-motion` kills transitions/animations globally.
- `--muted-foreground` and `--ring` values are unchanged; the existing
  `a11y-contrast.test.ts` guards every surface.

### Phone inputs

`apps/web/src/App.tsx` (setup, login, forgot-password) and
`apps/web/src/pages/settings.tsx`: `type="tel"`, `inputMode="tel"`, a
meaningful `name`, and `autoComplete`.

## i18n keys (all new copy)

- `saleEmptyTitle`, `purchasesEmptyTitle`, `purchasesEmptyHint`
- `debtsEmptyOwedHint`, `debtsEmptyWeOweHint`
- Reworded `saleScanHint`, `saleQuickAdd`, `saleQuickStockBtn` to state the
  difference between the quick-add paths.
- Reused where the meaning already exists: `invoiceLinesTitle`, `saleNew`,
  `purchasesTitle`, `dashboardNewSale`.

## Dependencies

None new. Lucide icons already a dependency; Button/EmptyState are local.

## Planned tests

Unit / component (`bun test` in apps/web):

- `readSidebarCollapsed`: unset → false, `"true"` → true, `"false"` → false,
  stale value → false, throwing storage → false.
- `AppSidebar` (minimal router harness): expanded renders visible Arabic
  labels; collapsed renders no visible label but each link keeps its
  `aria-label`.
- `SalePage`: empty invoice has no discount controls and no checkout bar,
  shows the teaching empty state with a picker action; after a scan the
  discount controls and `sale-save` exist.
- Existing sale commit-state tests must stay green (they all add a line first).

Playwright (`tests/e2e/learnability.spec.ts`):

- Fresh profile shows Arabic nav labels without hovering; toggling collapse
  keeps accessible names.
- A sale completes with `sale-save` in the viewport at 1280×720 and at
  1024×768, with the discount block appearing only after the line exists.
- `bun run test:e2e` (full suite) stays green.

## Risks

- Moving the sale totals into a sticky bar changes DOM order; the existing
  unit tests query by testid/aria-label, and the E2E uses roles/testids, so
  the risk is limited to layout. Mitigation: run the full suite.
- Token changes can break the contrast guard. Mitigation: keep
  `--muted-foreground`/`--ring` and run `a11y-contrast.test.ts`.
- `position: sticky` inside `main`'s scroll container: verify in the browser at
  both target viewports; the bar falls back to normal flow when unsupported.
- Demoting the quick-add buttons without hiding them keeps the E2E testids
  reachable.

## Out of scope (deliberate)

- No API/contracts changes; no new features; no dashboard IA change.
- Secondary-page empty states whose next action already sits adjacent on the
  same screen (categories input, items form, expenses form, invoices filters)
  keep their current treatment; reported as deferred, not silently changed.

## Pre-existing E2E breakage repaired

The E2E suite at the pinned base is red: every spec drives the pre-#74
"first time" reset form (`setup-phone` / `setup-password` / `setup-submit` /
`setup-message`), which commit `aae5f9c` removed when the auth gate moved to
first-run setup. Because the acceptance gate requires `bun run test:e2e`,
this lane repairs the stale preamble through `tests/e2e/auth-helpers.ts`
(`signIn`, `openSystemNav`) and updates the four specs that navigated through
the System nav cluster by link name. App auth behaviour is unchanged; the
suite goes from red at base to 21/21 green.
