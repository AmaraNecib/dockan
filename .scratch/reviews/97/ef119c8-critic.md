Write blocked by the tool budget; returning the complete artifact inline for the runtime to persist to `D:\projects\mani-project\.scratch\reviews\97\ef119c8-critic.md`.

---

# Harsh critique — PR #104 / issue #97 (HEAD `ef119c8`, merge-base `5f8b94e`)

`score | file:line | what breaks and when | how to fix`

**6 | apps/web/src/lib/preferences.ts:107-121 | the dismissal can be lost with no signal.** `void writePreference(...).then((stored) => { if (stored === null) return; ... })` — when `preferencesSet` rejects, `writePreference` swallows it (`catch { return null }`, :29-36), the cache keeps `"false"`, `hidden` stays false, and the panel snaps back with no alert, no retry, no log. The owner clicks `getting-started-dismiss` (`getting-started-panel.tsx:81-90`) and the row simply refuses to disappear; on the sidebar path the same swallow silently reverts a toggle. | Surface the failure: set an error state and render `role="alert"`, or retry once and keep the control disabled until it settles.

**5 | apps/api/src/rpc/router.ts:1406-1414 | the completion milestone is client-settable, contradicting the design.** `preferencesSet` accepts *any* 1..64-char key (`core.ts:285-292`); the web already exports `ONBOARDING_COMPLETED_PREFERENCE_KEY` and `useOnboardingCompleted().setValue`. One `preferencesSet({key:"ui.onboarding.completed", value:"true"})` hides the panel forever with zero records behind it — the exact failure `onboardingProgress` was built to prevent. | Reject/ignore server-owned keys in `preferencesSet` (allowlist `ui.sidebar.*`, `ui.onboarding.dismissed`), or give the milestone its own read-only key space.

**5 | tests/e2e/00-onboarding.spec.ts:170-176 | an e2e test that passes against a fully broken milestone.** After `page.goto("/")` it asserts `getByTestId("getting-started")).toHaveCount(0)`. That is produced by the live projection (`getting-started-panel.tsx:64`, `isOnboardingComplete`) with all four records present, so `onboardingComplete` could be deleted from the router/store and this test still passes. | Reload once more after the milestone write, or delete/zero one record and assert the panel stays gone (that is what "durable milestone" means).

**4 | apps/web/src/lib/preferences.ts:15-25,92-99 | a failed read fails *open*, re-nagging a dismisser.** `readPreferences` throws, the hook runs `retry: false`, `query.data` is `undefined`, so `parse(undefined)` → `false` for both `dismissed` and `completed` (`parseBooleanPreference:22`). Any transient DB/loopback error on a packaged launch resurrects the panel a second time. | Distinguish error from unset (`query.isError` → render nothing / keep the last-known value) instead of defaulting to "not dismissed".

**3 | apps/web/src/lib/preferences.ts:110 | the `inFlight` guard silently drops writes.** `if (inFlight.current) return;` discards the request with no feedback. The keyboard path is never disabled: `app-shell.tsx:137-139` `toggleSidebar` → `updateValue` → `setValue`, wired at :146-150, while only the *Button* carries `disabled={collapsedPending || collapsedWriting}` (:170). Two fast Ctrl+B presses lose the second toggle. | Remember the latest intent and flush it after the in-flight write settles.

**3 | apps/web/src/pages/dashboard.tsx:88-91 | unbounded milestone retry loop.** The effect depends on `progress.dataUpdatedAt`, so while `completed` stays false and the four records stay complete, every 60s poll re-issues `acknowledge.mutate` (each attempt ×3 with `retry: 2`) for as long as the tab is open. | Back off, or stop after N failed observations (the panel is already hidden).

**2 | apps/web/src/pages/dashboard.tsx:59-60 | completion/dismissal are one-way doors.** `hidden = dismissed || completed`; nothing anywhere clears `ui.onboarding.dismissed` (only write is :109). A mis-click permanently removes the teaching surface with no settings escape hatch. | Add a "show getting started" toggle in settings, or let the dismissed state expire.

**2 | apps/web/src/pages/dashboard.tsx:108 | dead branch presented as a guarantee.** `dismissPending={dismissedPending || dismissedWriting}` — while `dismissedPending` is true the panel returns `null` (`getting-started-panel.tsx:63`, since `isPending` is forced false at :105), so that half of the expression can never disable a rendered control. | Drop the branch or render the skeleton while loading so the gate is real.

**2 | apps/api/src/store/drizzle-store.ts:1443-1452 | hidden contract in `recordOnboardingCompletion`.** `this.onboardingProgress()` / `this.setPreference(...)` only avoid re-entering the queue because `serializeStore` binds `raw` (`:403` `.bind(raw)`). That indirection is invisible at this call site; any refactor of the wrapper turns the milestone write into a self-deadlock on the single connection. | Call directly captured raw closures, or assert the invariant.

**2 | apps/web/src/components/app/sidebar-state.ts:52-57 | fallback only lands next launch.** If the owner's in-flight sidebar write *fails* after the migration check, the import is skipped for the session and the sidebar shows the default until the next app start (the kept legacy key is only consumed then). | Re-run the import once the pending write resolves to failure.

**1 | tests/e2e/00-onboarding.spec.ts:31-41 | suite cost + ordering hazard.** Two `execFileSync("bun", ...)` DB resets per test, plus `beforeAll`-only record reset, plus reliance on alphabetical file order and `serial` mode; a future `01-*` spec makes the fresh-install assertions lie. | Assert freshness in-spec rather than encoding it in the filename.

**1 | apps/api/src/rpc/router.ts:1409-1413 | unbounded preference map.** `preferencesGet` returns every row (`getPreferences`, `drizzle-store.ts:1494-1498`) with no key-count bound while any network client may insert keys. | Cap the map or allowlist keys (same fix as the milestone finding).

## Correct (verified)
- `onboardingProgress` is a single four-`EXISTS` read, session-guarded, no writes (`drizzle-store.ts:1413-1441`, `router.ts:1303`); no soft-delete/voided columns exist in `invoices`, so "real record" is honest.
- `hasDebt` matches the debt predicate byte-for-byte (`drizzle-store.ts:1310` vs `:1429-1431`).
- Ordering/`<ol>`/`sr-only` done-state text and the real `<Link>` rows are as specced (`getting-started-panel.tsx:93-113`), and `enabled: !hidden && !preferencesPending` does stop the poll.

## Notes
- Review-only task vs. the configured output path: the `write` tool was blocked by the tool budget, so the artifact is returned inline and nothing in the repo was modified; no tests were run (read-only instruction).
- Residual risk: none of the above was executed against a running build; all claims are read from source at `ef119c8`, which contains only the round-5 review docs on top of `27453f5`.