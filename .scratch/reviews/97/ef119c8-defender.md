# Defence — issue #97, PR #104 @ `ef119c8` (charitable defender)

**1. Completion is genuinely record-derived (conf 9).** `apps/api/src/store/drizzle-store.ts:1422` — `EXISTS(SELECT 1 FROM items) AS has_items, EXISTS(SELECT 1 FROM invoices WHERE kind = 'SALE') AS has_sale, EXISTS(SELECT 1 FROM invoices WHERE kind = 'PURCHASE') AS has_purchase`. One read, no client-settable flag, no new table.

**2. `hasDebt` is not an invention; it copies the shipped predicate (conf 9).** `drizzle-store.ts:1429` — `WHERE kind = 'SALE' AND remaining_amount > 0 AND (counterparty_id IS NOT NULL OR counterparty_name IS NOT NULL)` matches the pre-existing `drizzle-store.ts:1310` — `WHERE remaining_amount > 0 AND (counterparty_id IS NOT NULL OR counterparty_name IS NOT NULL)`. A walk-in remainder is invisible on `/debts`, so it must not tick the step.

**3. Malformed data can never fake completion (conf 9).** `onboarding-steps.ts:39-40` — `progress[step.progressKey] === true` and `STEP_DEFINITIONS.every((step) => progress[step.progressKey] === true)`; a missing flag reads pending.

**4. "Finished means gone" holds without a client-side lie (conf 8).** `router.ts:1302` re-checks before writing, and `drizzle-store.ts` `recordOnboardingCompletion` upserts idempotently, so retries are safe; the milestone lives in the same preferences table.

**5. The double guard is deliberate, not redundant (conf 8).** `getting-started-panel.tsx:62-64` — `if (hidden) return null;` … `if (isOnboardingComplete(progress)) return null;`. The second covers the window between observing 4/4 and the server confirming the milestone — otherwise a finished checklist briefly re-renders.

**6. Preferences going server-side is a defensible scope call (conf 9).** `desktop.rs:17-18` — "It binds a listener on `127.0.0.1:0` — the kernel assigns a truly free, now-reserved port" → the webview origin changes each launch, wiping localStorage and breaking **pre-existing** #94 sidebar state. Fixing only #97 would leave that bug.

**7. Accessibility is done properly (conf 9).** `getting-started-panel.tsx:71` `aria-labelledby`, `:109` `<span className="sr-only">{step.done ? t("onboardingDone") : …}` — never colour-only.

**8. The scanner seam follows an established pattern (conf 7).** `use-barcode-scanner.ts` `SCAN_MAX_GAP_MS = parseEnvInt(import.meta.env.VITE_SCAN_MAX_GAP_MS) ?? 50`, mirroring the existing `VITE_SCAN_DUPLICATE_WINDOW_MS` line; production stays 50 ms.

## False alarms
- *"Unrelated preferences subsystem bolted on."* False: it repairs #94's real packaged-restart bug; `preferences.ts` is 135 lines, one awaited write path, no queue/optimism left.
- *"Duplicated debt SQL."* Pre-existing duplication between `dashboardSummary`/`debtSummaries`; already dispositioned, comment added at `drizzle-store.ts:1417`.
- *"Skeleton flash / wasted polling."* `dashboard.tsx:78` `enabled: !hidden && !preferencesPending` and `:105` `isPending={progress.isPending && !preferencesPending}` kill both the flash and the hidden-state fetch.
- *"Client-only completion can resurrect."* Contradicted by the server milestone re-check.

Residual risk: `scripts/reset-e2e-*.mjs` write the sqlite file directly; test-only, fails loudly if the DB path is wrong.
