# Issue #97 — Getting-started panel (design)

Tier: **Standard**. Base: `origin/develop` @ `5f8b94e372402b2d13acdc540b1c6aa312d55901`.
Branch: `feat/97-onboarding`.

## Problem

On a brand-new install the owner logs in to a dashboard of three zeros with no
direction. Build a getting-started checklist that walks him through his first
day, then gets out of the way. It teaches activation (items → purchase → sale →
debt), not features.

## Product decisions

- The panel is a **checklist**, not a card grid, not a tour, not an overlay.
  Four steps in the order a shop actually needs them:
  1. `أضف منتجاتك` → `/items`
  2. `سجّل مشترياتك` → `/purchase`
  3. `اعمل أول عملية بيع` → `/sale`
  4. `تابع ديونك` → `/debts`
- Each step is a real `<Link>` inside an `<ol>`; the whole row is the target.
- Completion is derived from **real records** on the server, in one read.
- The panel disappears when all four are done, and an explicit dismiss is
  persisted (never nagging again).

## Interfaces

### `packages/contracts/src/core.ts`

```ts
export const onboardingProgressOutputSchema = z.object({
  hasItems: z.boolean(),
  hasPurchase: z.boolean(),
  hasSale: z.boolean(),
  hasDebt: z.boolean(),
});
export type OnboardingProgress = z.infer<typeof onboardingProgressOutputSchema>;
```

`hasDebt` mirrors the dashboard/debts predicate: a party-attributed unpaid
`SALE` invoice (`counterparty_id`/`counterparty_name` present). A walk-in
remainder with no party is not "someone who owes you", so it does not complete
the step — the `/debts` screen cannot show it either.

### `packages/contracts/src/app-contract.ts`

```ts
/** one EXISTS read for the dashboard getting-started checklist (issue 97) */
onboardingProgress: oc.output(onboardingProgressOutputSchema),
```

### `apps/api/src/store/port.ts`

```ts
export interface OnboardingProgress {
  hasItems: boolean;
  hasPurchase: boolean;
  hasSale: boolean;
  hasDebt: boolean;
}
onboardingProgress(): Promise<OnboardingProgress>;
```

### `apps/api/src/store/drizzle-store.ts`

One SQL read of four `EXISTS` subqueries (`onboardingProgress`). No new tables,
no writes, no change to any existing query.

### `apps/api/src/rpc/router.ts`

```ts
onboardingProgress: os.onboardingProgress.handler(
  guarded(async () => deps.store.onboardingProgress()),
),
```

read-only, session-guarded, no input.

### `apps/web/src/components/app/onboarding-steps.ts` (new, pure)

```ts
export type OnboardingStepId = "items" | "purchase" | "sale" | "debts";
export interface OnboardingStep {
  id: OnboardingStepId;
  labelKey: string;
  hintKey: string;
  to: "/items" | "/purchase" | "/sale" | "/debts";
  done: boolean;
}
export function onboardingSteps(progress: OnboardingProgress): OnboardingStep[];
export function isOnboardingComplete(progress: OnboardingProgress): boolean;
```

Single ordered source of truth; completion is a pure projection of the
server booleans.

### `apps/web/src/components/app/onboarding-state.ts` (new)

Mirrors `sidebar-state.ts` exactly (the named precedent): `dokan.onboarding.dismissed`,
an explicit write of `"true"`, and a `try/catch` read that returns `false` on
any storage failure so a broken `localStorage` can never hide the panel or
crash the dashboard.

```ts
export function readOnboardingDismissed(): boolean;
export function writeOnboardingDismissed(): void;
```

### `apps/web/src/components/app/getting-started-panel.tsx` (new)

```tsx
interface GettingStartedPanelProps { progress: OnboardingProgress }
export function GettingStartedPanel(props: GettingStartedPanelProps): ReactElement | null;
```

- Returns `null` when `isOnboardingComplete(progress)` or the stored dismissal
  is set.
- `<section aria-labelledby>` → real `<h2>` + one-line hint; no eyebrow.
- `<ol>` of four `<li data-state="done" | "pending">`; each li wraps a
  `<Link>` (the whole row) with a lucide state icon (`Check` vs `Circle`,
  `aria-hidden`) plus visually-hidden `مكتملة` / `غير مكتملة` text so
  completion is never colour-only.
- One border, no shadow (elevation declared once), reusing `bg-card` /
  `border-border` / `text-muted-foreground` tokens and the `Button` primitive.
- A real `<button data-testid="getting-started-dismiss">إخفاء</button>` in the
  header row. Dismissing writes storage then sets local state.
- `transition-colors` (property listed, never `all`); hover is `bg-muted` and
  the label underlines; the global `:focus-visible` ring applies.

### `apps/web/src/pages/dashboard.tsx`

- Add `useQuery(orpc.onboardingProgress.queryOptions())`.
- Render `{progress.data !== undefined && <GettingStartedPanel progress={progress.data} />}`
  immediately after the page `<h1>`, above the quick-action links, independent
  of the summary query (a failing summary must not hide the checklist, and a
  failing progress read simply hides the panel rather than nagging with wrong
  state).
- Existing KPIs, tables, and lists keep their position and markup; the panel
  adds height only while it is present.

## Dependencies

None new. `lucide-react` and the local `Button`/tokens already exist.

## Planned tests

Unit (`apps/web`, `bun test`):

- `onboarding-steps.test.ts`: empty → step 1 pending; items only → step 1 done,
  step 2 pending; items + purchase → step 3 pending; items + purchase + sale →
  step 4 pending; debt completes step 4; all four → `isOnboardingComplete`
  true; any missing → false. Wrong/extra data cannot set a step.
- `onboarding-state.test.ts`: unset → not dismissed; write → dismissed;
  stale `"false"`/junk → not dismissed; throwing read → not dismissed (panel
  stays); throwing write → no throw.
- `dashboard.test.tsx` (extend the existing rpc mock with
  `onboardingProgress`): fresh summary → panel renders four steps in order with
  the right hrefs; a done boolean marks that li `data-state="done"`; dismiss
  hides the panel and writes storage; all-done progress never renders the panel;
  a stored dismissal survives a remount; the rest of the dashboard still
  renders alongside the panel.

API (`apps/api`, `bun test`):

- `onboarding-progress.test.ts` (new store seam): empty store → all false;
  an item flips `hasItems`; a `PURCHASE` flips `hasPurchase`; a `SALE` flips
  `hasSale`; an unpaid party-attributed `SALE` flips `hasDebt`; a paid sale and
  a party-less remainder do not flip `hasDebt`; purchase/sale are independent.
- `router.test.ts`: `onboardingProgress()` is session-guarded and returns the
  four booleans.

Playwright (`tests/e2e/`):

- A fresh install (first spec against the wiped DB) shows the panel with the
  four steps in order, each a real link to its screen, all pending.
- Creating an item flips step 1 to done after a client-side navigation
  (proven no-reload by a `window` marker), step 2 stays pending.
- Dismissing hides the panel and survives a reload.
- Completing purchase + sale + debt makes the panel disappear.
- `bun run test:e2e` stays green (full suite).

The shared e2e database is wiped only once at webServer boot and specs run
alphabetically at `workers: 1`, so the fresh-install assertions live in the
first spec file and later specs add data on top.

## Risks

- **Shared e2e DB ordering.** The fresh assertions need the first DB state.
  Mitigation: the spec sorts first and each later test uses unique names.
- **Second query on the landing page.** A new read adds one round-trip. It is a
  single `EXISTS` aggregate; the panel waits for it and the rest of the page is
  unaffected.
- **RTL/keyboard.** Rows are links, not `div onClick`; the global focus ring and
  logical (not physical) spacing are used. Covered by the guidelines check.
- **Local storage failures.** The throwing-storage guard is copied from
  `sidebar-state.ts` and unit-tested; a read failure shows the panel.

## Out of scope (deliberate)

- No money, stock, calculation, or existing-behaviour changes.
- No visual redesign (#69); no secondary empty states (#96).
- No progress counts or percentage (no fake progress); no re-showing after
  dismissal.
