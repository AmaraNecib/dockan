# PR #104 / issue #97 — adversarial review synthesis

Reviewed head `ef119c8`, merge-base `5f8b94e`. Four independent fresh-context
reviewers (`ef119c8-{standards,spec,critic,defender}.md`).

Red evidence: the new tests fail against `ef119c8` (three preference tests,
three dashboard tests, one api test) — captured before the implementation.

| # | Finding | Score | Decision |
|---|---|---|---|
| 1 | A failed dismissal was swallowed: `writePreference` returned null and nothing told the owner, so the control snapped back silently | 6 | **Fixed** — `usePreference` exposes `writeFailed`, the panel renders `role="alert"` |
| 2 | The completion milestone was client-writable through the generic `preferencesSet`, so one call could hide the checklist forever with no records behind it | 5 | **Fixed** — the server owns the key; only `ui.sidebar.collapsed` and `ui.onboarding.dismissed` are writable, and the api test pins the refusal |
| 3 | **The milestone was never recorded at all when the client navigated away mid-write** — the strengthened e2e exposed this | P1 | **Fixed** — the server records it when the progress read observes all four records, which is when it learns the shop is complete |
| 4 | A failed read failed *open*, defaulting to "not dismissed" and re-nagging a dismisser on any transient loopback error | 4 | **Fixed** — `isError` is exposed and the dashboard treats it as "not visible"; the old test that pinned the opposite is replaced |
| 5 | The in-flight guard silently dropped a second change, so two fast Ctrl+B presses lost the second | 3 | **Fixed** — the newest intent is queued and sent when the in-flight write settles |
| 6 | The milestone write re-issued on every 60s poll for as long as a failure persisted | 3 | **Fixed** — capped, counted when an attempt starts (a retrying mutate would otherwise let the next poll start another) |
| 7 | The e2e reset could target a different database than the server ran against when `E2E_DATA_DIR` was overridden | P1 | **Fixed** — `playwright.config.ts` derives its path from the same variable, so there is one source of truth |
| 8 | The milestone e2e passed against a milestone that never reached the server | 5 | **Fixed** — it now settles the debt, revisits the dashboard, and asserts the panel stays gone |
| 9 | `dismissPending` included `dismissedPending`, which can never disable a rendered control (the panel returns null while loading) | 2 | **Fixed** — the dead half is dropped |
| 10 | The skeleton and the panel were 8px apart after the spacing fix | — | **Fixed** — the skeleton's hint row moved to the same 4pt step; the footprint e2e caught it |
| 11 | `mt-0.5` off the documented 4pt scale | standards | **Fixed** — both the panel and its skeleton use `mt-1` |
| 12 | `acknowledge` hid "record the completion milestone" | judgement | **Fixed** — renamed `recordCompletion` |
| 13 | The design doc's Interfaces section never described the preferences table and RPCs it added | spec | **Deferred** — issue filed |
| 14 | Completion and dismissal are one-way doors with no settings escape hatch | 2 | **Deferred** — issue filed; needs a settings toggle, which is a new feature |
| 15 | `recordOnboardingCompletion`'s safety depends on an invisible `raw` binding | 2 | **Deferred** — issue filed |
| 16 | The sidebar's legacy-key import only retries on the next launch when a write fails | 2 | **Deferred** — issue filed |
| 17 | The e2e suite's fresh state depends on its filename ordering | 1 | **Kept** — the numeric prefix is documented in the file header |
| 18 | Preferences are server-side, which is scope beyond #97 | spec | **Kept** — the Tauri shell rebinds `127.0.0.1:0` each launch, so localStorage is wiped; fixing only #97 would leave #94's sidebar broken |
| 19 | The scanner env seam is unrelated to #97 | spec | **Kept** — it stabilises a load-sensitive e2e; production stays 50ms |
| 20 | No hard standards violations | standards | — |
