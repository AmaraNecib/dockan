# Ticket #28 — Quality Review: UI + E2E (re-check @ 58f7665)

Prior verdict: **FAIL** at `bbff481` (`bbff481-quality-ui-e2e.md`). This re-check verifies each P1/P2 finding against `git show 58f7665` and the current files. Review-only run; e2e not executed here (verified green upstream by the parent).

## P1

**1. unknown-scan-dialog: no Escape / focus management — FIXED.**
New shared primitive `apps/web/src/lib/use-modal-dialog.ts` (63 lines): (a) Escape closes via capture-phase window keydown (`use-modal-dialog.ts:34-39`) regardless of where focus sits; (b) focus moves into the dialog on open via rAF + first-focusable query (`:22-25`); (c) Tab is trapped with wrap-around including shift-tab (`:40-55`, double-modulo handles index -1 and negative steps); (d) cleanup restores `previouslyFocused` (`:60`). `UnknownScanDialog` wires it via `panelRef` on the `role="dialog"` panel. Acceptance criterion met.

## P2

**2. item-picker-dialog Escape only from input — FIXED.**
Same hook applied (`item-picker-dialog.tsx:40,76-82`); Escape now works globally while the dialog is open, not just in the search input. Focus trap + restore come along.

**3. search input aria-label — FIXED.** `items.tsx:109` adds `aria-label={t("itemsSearchPlaceholder")}`.

**4. scan notice not announced — FIXED.** `items.tsx:59` adds `role="status" aria-live="polite"` to the `scan-found` paragraph. The "ideally also results region" suggestion remains unimplemented (it was optional wording); not a blocker.

**5. e2e timing-coupled duplicate window — FIXED (deterministic).**
Window made injectable: `SCAN_DUPLICATE_WINDOW_MS = parseEnvInt(import.meta.env.VITE_SCAN_DUPLICATE_WINDOW_MS) ?? 800` (`use-barcode-scanner.ts:22-33`, validated finite ≥0), set to `"1200"` in `playwright.config.ts` webServer env. Margins are deterministic both directions: typing ~150 ms ≪ 1200 ms window guarantees suppression is observable; the 1500 ms wait before the fresh rescan of UNKNOWN-777 exceeds the 1200 ms window.

**6. true duplicate suppression never tested / stale assertion — FIXED.**
`ticket28.spec.ts` now counts `/api/rpc/catalogSearch` requests via `page.on("request")`; after the first UNKNOWN-999 scan opens the dialog it polls until calls settle, retypes the same code inside the window, waits 400 ms, then asserts `searchCalls` unchanged (second commit swallowed → no RPC) and the dialog still visible. The old round-1 stale-`toContainText` assertion was removed entirely. Cancel path replaced `waitForTimeout(300)` + raw row count with auto-retrying `expect(rowsWithUnknownCode).toHaveCount(0)` before/after cancel — also closes prior P3-10.

**7. error rendered as "no results" — FIXED.** `items.tsx:117-123` renders a distinct red `itemsSearchError` block with a working retry button (`search.refetch()`); the empty-state `<li>` is gated on `!search.isError` (`items.tsx:141`).

## P3 carried over

- **8. modifier-chord guard — FIXED**: `ctrlKey || metaKey || altKey` early-return added before buffering (`use-barcode-scanner.ts:52-54`).
- **9. global `workers: 1`** — unchanged; accepted tech debt as previously noted.
- **10. `waitForTimeout(300)` after cancel — FIXED** (see #6).

## New issues introduced by 58f7665

1. **Minor** — `playwright.config.ts` ends without a trailing newline (`\ No newline at end of file`). Cosmetic.
2. **Minor** — `useModalDialog` effect depends on `onClose` identity; both callers pass inline arrows (`items.tsx:69,155`), so a parent re-render while a dialog is open tears down/re-runs the effect (focus restore-then-refocus churn). Functionally benign (panel regains focus immediately; e2e green), but memoized callbacks would remove it. Relatedly, `closeLabel`/`t` in the hook are dead code (returned, never consumed).
3. **Note** — the hook's Escape handler calls `event.stopPropagation()` at window capture phase; fine today since only one modal exists at a time, but nested-overlay stacking would need care later.

No correctness regressions found; lint clean, typecheck 3/3, unit suite 89 pass / 0 fail at this HEAD.

VERDICT: PASS
