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

`dashboard.tsx`: `enabled: !hidden && !preferencesPending`; once dismissed or
completed the `onboardingProgress` read never fires (a disabled query ignores
its `refetchInterval: refreshMs`). Asserted with `progressFetchCount === 0`
while hidden and while preferences load.

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

## Round-2 hardening (review of the follow-up)

- `readPreferences` now throws; `usePreference` runs `retry: false` so a failed
  read immediately falls back to defaults, and the errored query is refetched
  on the next mount (self-heal). The imperative guard moved to
  `readPreference` (returns undefined) and `writePreference` now reports
  success/failure instead of silently resolving.
- After a successful write the hook invalidates the shared query so the full
  map is reconciled: a write made before the first read cannot drop sibling
  preferences. `updateValue(updater)` reads the latest cached value so rapid
  sidebar toggles cannot race.
- The shared boolean codec moved to `lib/preferences.ts` (one parse/serialize
  pair for both state modules).
- `reset-e2e-*` scripts respect a harness-supplied `E2E_DATA_DIR` and fail
  loudly if the database is missing; the record reset also clears customers,
  suppliers, and expenses.
- New E2E: the loading placeholder is measured against the loaded panel at
  1280×720 and must match within 1px (finding 3's missing evidence).
- New unit tests: failed-read self-heal, sibling-key race, imperative guards,
  and the shared codec.

## Round-3 hardening (second review of the preferences layer)

- **Ordered writes.** `preferences.ts` keeps a per-key write tail: a write
  starts only after the previous write for that key settles, so an earlier
  choice can never land after a later one. Only the newest queued write
  reconciles (`isLatestPreferenceWrite`), so an intermediate refetch cannot
  undo the visible choice. Each attempt retries transient failures (3 tries,
  50/100ms); the server upsert is idempotent. Covered by a test whose first
  write is held open until after the second is queued.
- **Never a partial cache.** An unconfirmed choice now lives in a local overlay
  instead of being written into the shared query cache. The cache only ever
  holds a full server read. On a failed write the overlay is cleared and the
  query is invalidated, so the UI stops claiming a state the server rejected.
  Covered by a test with a pending initial read AND a failed write.
- **Multi-window freshness.** `staleTime` is a finite 30s and the query
  refetches on window focus/visibility and reconnect, so a dismissal made in
  another window is picked up without a reload. Covered by a focusManager test.
- **Durable milestone.** The client no longer writes `ui.onboarding.completed`
  best-effort. New session-guarded `onboardingComplete` re-checks the four real
  records and upserts the milestone idempotently; the dashboard calls it (with
  retries) when it observes completion, then refreshes the shared preferences
  query. A failed call leaves no persisted claim, and the next observation
  retries. A failed dismissal reverts the overlay instead of hiding silently.
- **Legacy sidebar migration.** `migrateLegacySidebarCollapsed()` imports the
  old `dokan.sidebar.collapsed` localStorage value once when the server has no
  sidebar preference, then clears the legacy key; a failed read or write keeps
  it for the next launch, and a throwing localStorage is caught. AppShell runs
  it on mount and refreshes the preferences query after a real import.
- `ONBOARDING_COMPLETED_PREFERENCE_KEY` is shared from contracts so the router
  that writes the milestone and the web hook that reads it cannot drift.

### Round-3 refinements (review of the round-3 fixes)

- The legacy migration guards on `hasPendingPreferenceWrite` (a write queued or
  in flight), not on any write this session: a toggle that landed earlier is
  seen through the server read, and a toggle still pending is never overtaken.
- The completion milestone moved fully into `store.recordOnboardingCompletion`
  (re-check + idempotent upsert), so the store seam can be tested directly for
  both the incomplete and complete cases; the dashboard effect now depends on
  `progress.dataUpdatedAt` and re-fires on later observations while the
  milestone is still unset, so an in-session failure recovers without a remount.
- The preference writer returns the server's echo and folds that canonical value
  into the cache (not the value it sent), so a normalizing server cannot be
  mistaken for a rejected write.

---

# Round-4 simplification: no optimistic preference state

The round-3 review found two more races, both created by the round-2/3 fixes:
an in-flight read overwriting a confirmed write, and the migration's
read-then-write clobbering a newer choice. Both existed only because the client
kept optimistic state that could disagree with the server. This is a local-first
app: the "server" is a loopback HTTP call to a sqlite file on the same machine,
so a write completes in milliseconds and the optimism bought nothing.

## Deleted

- The optimistic overlay in `usePreference` (local `optimistic` state and the
  effect that cleared it when the server confirmed).
- The per-key write queue: `writeTails`, `writeSequence`,
  `latestWriteSequence`, `queuePreferenceWrite`, `isLatestPreferenceWrite`,
  `hasPendingPreferenceWrite`, and the `PreferenceWrite` type.
- `cancelQueries` around writes and the newest-write-only reconcile.
- Write retries and the `WRITE_ATTEMPTS`/`WRITE_RETRY_MS` tuning.
- The imperative seams that only tests called: `readSidebarCollapsed`,
  `writeSidebarCollapsed`, `readOnboardingDismissed`, `readOnboardingCompleted`,
  `writeOnboardingDismissed`, `writeOnboardingCompleted`, `readPreference`, and
  `apps/web/src/components/app/onboarding-state.test.ts`.
- The AppShell migration effect (it now runs before the shell renders).
- The optimistic-race tests: write ordering with a held first write, sibling-key
  drop on a pending read, pending-read + failed-write cache integrity, rapid
  toggle settle, and revert-on-failed-write. There is nothing left to race.

## Kept / simplified

- `writePreference` awaits `preferencesSet` and returns the server's echoed
  value or null; `usePreference` installs only that value into the query cache.
  A failed write means the value did not change, so the server value simply
  stays on screen. `writePreference` is the real write path used by both the
  hook and the migration.
- The only local write state is a synchronous `inFlight` ref (double-click
  guard) plus `isWriting` for disabling the control. `isPending` remains the
  shared read's loading state.
- The legacy migration runs in the background after the shell mounts (gating
the shell on it delayed the scanner mount and broke catalog-scan). It skips
itself when the server already holds a sidebar value or the owner wrote a
sidebar preference while its read was in flight (`hasPreferenceWrite`); a
failed read/write leaves the legacy key for the next launch.
- Kept unchanged: the server-side preferences table, session-guarded bounded
  procs, the durable idempotent `onboardingComplete` milestone, focus/reconnect
  freshness, and `enabled: false` when the checklist is hidden.

## Tests that matter now

- A failed write leaves the server value showing (no optimistic claim).
- A successful write installs the server's returned value (a normalizing server
  is used to prove the echo is authoritative).
- A double-click cannot issue two writes (one delayed write, one call).
- The migration imports once; a server value wins; failed read/write keeps the
  legacy key; throwing storage is safe.
- The milestone is idempotent server-side (store seam) and retries on later
  observations while unset.

### Round-4b refinements (review of the simplification)

- The write echo is never installed into an empty cache: the `setQueryData`
  updater returns the previous (undefined) map unchanged, so a partial map can
  never be created. The preference controls are also disabled while the shared
  read is pending, so the app never issues a write against an unconfirmed map.
- `migrateLegacySidebarCollapsed` returns `Promise<void>` (side effects only);
  nothing consumed its boolean, so the return was removed.
- New tests: `RequireSession` renders the shell immediately and imports the
  legacy value in the background; the dismiss control is disabled while the
  write is in
  flight; the failed-dismissal test now asserts the write actually ran.

## Round-5 regression fix (do not gate the shell)

The round-4b gate that withheld the shell until the legacy sidebar import
settled was a regression: it added a preferences round-trip to every launch and
delayed the page mount, which could beat the barcode scanner's keydown listener
on a focused field (catalog-scan). Removed.

- `RequireSession` renders the shell immediately and runs the one-time import in
  the background (one-shot per mount via a ref).
- The import consults `hasPreferenceWrite` (a module-level set written by the
  real `setValue` path) after its read, so a choice the owner makes while the
  read is in flight is never overtaken; it still skips when the server already
  holds a sidebar value.
- Stabilized the documented editable-regime scanner flake the same way the repo
  already stabilizes the duplicate window: `SCAN_MAX_GAP_MS` is now
  `VITE_SCAN_MAX_GAP_MS ?? 50`, and the Playwright web server sets it to 250 ms
  for e2e (production stays 50 ms).
- New tests: the shell renders immediately while the import is held; the import
  does not clobber a write made while its read is in flight.
