# Spec axis — PR #104 (feat/97-onboarding) @ ef119c8

## (a) Missing or partial vs spec

1. **Dismissal is no longer local-first.** Spec:100-101: "`dokan.onboarding.dismissed`, an explicit write of `"true"`, and a `try/catch` read that returns `false` on any storage failure so a broken localStorage can never hide the panel or crash the dashboard." Delivered `apps/web/src/components/app/onboarding-state.ts:1-25` holds no storage code at all, only `usePreference` wrappers. Spec:140 "Dismissing writes storage then sets local state" is therefore not implemented as written — superseded by the PR-follow-up (server-side preferences), documented at spec:249-296. Partial, intentional.
2. **Panel props diverged.** Spec:104-113 declares only `{ progress, isPending }`; `getting-started-panel.tsx:9-17` adds `hidden`, `dismissPending`, `onDismiss`. Also the spec icon is "`Check` vs `Circle`" (spec:134); code uses `CheckCircle2` + `Circle` (`getting-started-panel.tsx:87,89`). Cosmetic.
3. **Planned test deleted.** Spec:172-174 "`onboarding-state.test.ts`: unset → not dismissed; write → dismissed; stale `"false"`/junk → not dismissed; throwing read → not dismissed (panel stays)". No such file exists; spec:384 records its deletion. The "junk → not dismissed" guard survives only as `parseBooleanPreference` (`lib/preferences.ts:31`) and the throwing-read case is covered indirectly by the dashboard preference-failure test. Coverage is thinner than planned.
4. **Spec:66 "No new tables, no writes, no change to any existing query"** is violated by `apps/api/src/db/schema.ts:116` (`CREATE TABLE IF NOT EXISTS preferences ...`) plus `preferencesGet`/`preferencesSet` (`router.ts:1406-1414`) and `onboardingComplete` (`router.ts:1302-1306`), none of which appear in the Interfaces section (spec:31-140). Documented as follow-up work, but the Interfaces section was never updated.

## (b) Scope creep

- Spec:223 "No money, stock, calculation, or existing-behaviour changes." Yet `apps/web/src/lib/use-barcode-scanner.ts:21` changes a shipped constant's wiring — `SCAN_MAX_GAP_MS = parseEnvInt(import.meta.env.VITE_SCAN_MAX_GAP_MS) ?? 50` — and `playwright.config.ts` sets `VITE_SCAN_MAX_GAP_MS: "250"` (5× looser, production path now env-tunable). Flake stabilization, not #97.
- The whole #94 sidebar migration (`sidebar-state.ts` rewrite, legacy-key import, `App.tsx:16-34`) and `scripts/reset-e2e-records.mjs` (deletes customers/suppliers/expenses) are outside issue #97's four steps.

## (c) Implemented but wrong

- None found on the core predicates. Debt predicate: spec:32-34 "a party-attributed unpaid `SALE` invoice" matches `drizzle-store.ts:1428-1431` (`kind='SALE' AND remaining_amount > 0 AND (counterparty_id IS NOT NULL OR counterparty_name IS NOT NULL)`), which mirrors the debts screen filter at `drizzle-store.ts:1310`. Spec:37-38 four booleans match `core.ts:875-880`. Spec:225 "no progress counts or percentage" holds.

## Risk (not blocker)

With the server write as the only path, `preferences.ts:111` (`if (stored === null) return;`) means a failed dismiss leaves the panel visible — the opposite of spec:24 "never nagging again" for that launch.
