# Standards review — PR #104 (#97), HEAD ef119c8, merge-base 5f8b94e

Hard violations of documented standards: **none found**.

## Documented-standard (soft) findings
1. **4pt spacing scale** — `.github/copilot-instructions.md` → *"Layout: 4pt spacing scale, `gap` over margins"*. `apps/web/src/components/app/getting-started-panel.tsx:44` `className="mt-0.5 h-5 w-56"` and `:107` `className="mt-0.5 block text-sm text-muted-foreground"` use a 2px step; the rest of the diff is scale-clean (`p-4`, `gap-3`, `mt-1`). Baseline precedent exists (`app-sidebar.tsx:95`), so judgement call.
2. **Raw SQL in a test script vs ADR** — `docs/adr/0003-store-port-sqlite-first.md`: *"Persistence is reached through one `StorePort` interface"*. `scripts/reset-e2e-records.mjs:29-46` hardcodes `DELETE FROM stock_links; ... DELETE FROM preferences;`, and validates only `if (!fs.existsSync(dbPath)) throw ...`, so a table rename silently resets nothing (Shotgun Surgery). E2E infra, ADR is about app persistence → judgement call.
3. **Scope** — `apps/web/src/lib/use-barcode-scanner.ts:21` `export const SCAN_MAX_GAP_MS = parseEnvInt(import.meta.env.VITE_SCAN_MAX_GAP_MS) ?? 50;` plus `playwright.config.ts:53-56` are unrelated to #97 (prod default unchanged). No documented minimal-diff rule exists; flagged as a scope note only.

## Baseline smells (judgement calls, non-blocking)
- **Duplicated Code** — `removeTempDirRetry`/`freshStore` verbatim in `apps/api/src/store/onboarding-progress.test.ts:23-47` and `preferences.test.ts:23-47`; `DELETE FROM preferences;` in `reset-e2e-records.mjs:45` vs `reset-e2e-preferences.mjs:18`. Baseline already duplicates these helpers (`dashboard-summary.test.ts`, `drizzle-store.test.ts`) and no linter enforces it.
- **Mysterious Name** — `apps/web/src/pages/dashboard.tsx:64` `const acknowledge = useMutation({...orpc.onboardingComplete.mutationOptions()...})`; "acknowledge" hides "record the completion milestone".
- **Middle Man** — `onboarding-state.ts:12` `export const ONBOARDING_COMPLETED_KEY = ONBOARDING_COMPLETED_PREFERENCE_KEY;` pure alias; tests use the contract constant directly.
- **Data Clumps / Primitive Obsession** — `apps/web/src/lib/preferences.ts:76` `usePreference<T>(key, defaultValue, parse, serialize)`: `parse`/`serialize` always travel as a pair (`sidebar-state.ts:21,26`; `onboarding-state.ts:17,21`). `port.ts:247` `getPreferences(): Promise<Record<string, string>>` re-spells the exported `Preferences` (core.ts:960).
- **Divergent Change (local)** — `drizzle-store.ts:1413` raw `db.all(sql\`...\`)` + cast beside the builder-based read at `:1498`; justified by the four-EXISTS comment.
- **Speculative Generality** — preference machinery (stale time, refetchOnWindowFocus/Reconnect, `{key,value}` echo) for two booleans.

## Correct
- DoD #3 holds: ar-only resources (`i18n.ts:8-9`, `lng`/`fallbackLng: "ar"`), keys typed via `MessageKey` (`i18n.ts:503`).
- Non-color-only status + ARIA per copilot-instructions Accessibility: `CheckCircle2`/`Circle` + `sr-only` text, `aria-labelledby`.
- Skeleton geometry comment verified: header 16+24+4+20+16=80; rows 32+20+2+20=74.
- `ui.*` namespace keeps shell state out of store identity (`schema.ts:117` comment; `preferences.test.ts` "keeps preferences out of store-identity settings").
- Evidence naming per `engineering-workflow.md`: last source change 27453f5 has `27453f5-*-{code-review,test-audit}.md`; ef119c8 itself is evidence-only.
