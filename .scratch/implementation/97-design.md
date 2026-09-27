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

Mirrors `sidebar-state.ts` (the named precedent) for the dismissed flag:
`dokan.onboarding.dismissed`, an explicit write of `"true"`, and a
`try/catch` read that returns `false` on any storage failure so a broken
`localStorage` can never hide the panel or crash the dashboard.

A second, data-derived milestone `dokan.onboarding.completed` is written only
when the panel observes all four records present. It is not a step-completion
flag (those stay live projections of the server read); it is what makes
"finished means gone" hold if a later settlement removes the debt record, and
it can only be set by actually completing the checklist.

```ts
export function readOnboardingDismissed(): boolean;
export function writeOnboardingDismissed(): void;
export function readOnboardingCompleted(): boolean;
export function writeOnboardingCompleted(): void;
```

### `apps/web/src/components/app/getting-started-panel.tsx` (new)

```tsx
interface GettingStartedPanelProps {
  /** undefined while the progress read is pending or failed. */
  progress: OnboardingProgress | undefined;
  /** true while the read has not settled; renders the loading skeleton. */
  isPending: boolean;
}
export function GettingStartedPanel(props: GettingStartedPanelProps): ReactElement | null;
```

- Returns `null` when dismissed/completed, when the read failed, or when
  `isOnboardingComplete(progress)`; renders a same-footprint `Skeleton` state
  while `isPending`. Also records the completion milestone once observed.
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

- Add `useQuery({ ...orpc.onboardingProgress.queryOptions(), refetchInterval: refreshMs })`
  (same cadence as the summary, so a step completed in another window
  self-heals).
- Always render `<GettingStartedPanel progress={progress.data} isPending={progress.isPending} />`
  immediately after the page `<h1>`, above the quick-action links, independent
  of the summary query (a failing summary must not hide the checklist, and a
  failing progress read simply hides the panel rather than nagging with wrong
  state).
- `EmptyState` stays the single-action teaching component; the checklist is a
  four-row ordered list and reuses the same tokens, `Button`, and one-border
  card vocabulary instead of inventing a second one.
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
  stays); throwing write → no throw; completion write → read true; throwing
  completion write → no throw.
- `dashboard.test.tsx` (extend the existing rpc mock with
  `onboardingProgress`): fresh summary → panel renders four steps in order with
  the right hrefs, under the `h1` and above the quick actions; a done boolean
  marks that li `data-state="done"` and announces `مكتملة`; dismiss hides the
  panel and writes storage; all-done progress never renders the panel and
  writes the completion milestone (a later settlement does not bring it back);
  a stored dismissal survives a remount; a pending read shows the skeleton; a
  failed progress read hides the panel without touching the figures; the rest
  of the dashboard still renders alongside the panel.

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

---

# PR #104 follow-up (still issue #97)

Four review findings, all fixed on the same branch.

## 1 — Preferences survive a packaged restart (server-side)

`localStorage` was a wipe in production: the packaged shell serves the webview
from `http://127.0.0.1:<port>` where the kernel assigns a new random port each
launch, so the origin (and its storage) changes. This also broke the pre-existing
sidebar preference from #94.

- `apps/api/src/db/schema.ts`: new `preferences (key TEXT PRIMARY KEY, value
  TEXT NOT NULL)` table + DDL. Deliberately separate from the store-identity
  `settings` row; no index beyond the primary key.
- `StorePort`: `getPreferences(): Promise<Record<string, string>>` and
  `setPreference(key, value)`. Drizzle: one plain scan, one upsert.
- Contracts: `preferencesGet` (all values in one cheap read) and
  `preferencesSet`, both session-guarded; key ≤64 chars, value ≤512.
- `apps/web/src/lib/preferences.ts`: `readPreferences` (a failed read resolves
  to `{}` — the throwing-storage guard, server-side), `writePreference` (a
  failed write is swallowed so the in-memory choice stands), and
  `usePreference(key, default, parse, serialize)` backed by one shared React
  Query cache entry; writes update the cache optimistically, cancel any
  in-flight initial fetch, then persist in the background.
- Migrated `sidebar-state.ts` and `onboarding-state.ts` onto it, keeping their
  existing read/write function names as the tested imperative seams, plus
  `useSidebarCollapsed` / `useOnboardingDismissed` / `useOnboardingCompleted`
  for the shell and dashboard.
- The dashboard waits for the preferences read before enabling progress and
  renders no skeleton meanwhile, so an owner who already dismissed/completed
  never sees even a placeholder flash.

## 2 — Stop polling once the panel cannot render

`dashboard.tsx`: `enabled: !hidden && !preferencesPending` and
`refetchInterval: hidden ? false : refreshMs`; once dismissed or completed the
`onboardingProgress` read never fires (asserted with `progressFetchCount === 0`
in the dashboard test).

## 3 — Loading placeholder matches the loaded footprint

`getting-started-panel.tsx`: header skeleton is `h-6` + `mt-1 h-5` (loaded:
`h2` line-height 24 + `mt-1` 4 + `text-sm` line 20), rows are `p-4`, a 20px
round icon, and two `h-5` bars with `mt-0.5` — the same 74px per row and 80px
header as the loaded panel, so the dashboard does not jump.

## 4 — The fresh-install E2E owns its state

- `scripts/reset-e2e-records.mjs`: deletes shop records (children before
  parents) and preferences; auth/settings/sequences survive. Run from the
  onboarding spec's `beforeAll`, which Playwright runs once per
  `--repeat-each` group.
- `scripts/reset-e2e-preferences.mjs`: clears preferences per test, because
  server-side dismissal/completion now leaks across tests.
- Verified with `playwright test tests/e2e/00-onboarding.spec.ts
  --repeat-each=2` (8/8) and the full suite (29/29).

## New tests

- API: `store/preferences.test.ts` (empty, upsert, settings independence,
  re-open persistence) and router wire/session/validation cases.
- Web: `lib/preferences.test.tsx` (read/write guards, optimistic write), the
  migrated `onboarding-state.test.ts` and `app-sidebar.test.tsx` seams, and the
  dashboard's no-progress-when-hidden / preference-failure / loading cases.
