# Code Review (re-check) — Ticket #28 @ 58f7665

- Prior verdict: **PASS** at `bbff481` (`bbff481-code-review.md`)
- Re-reviewed delta: single fix commit `58f7665` ("fix(review): dialog Escape/focus-trap/restore …") on top of `bbff481`; HEAD unchanged since
- Scope: full `git show 58f7665` + current state of all touched files
- Review-only run — no source or test files modified

## Prior PASS stands?

**Yes.** No regressions found. The fix commit is narrowly scoped to review findings:

| Fix-commit change | Verified |
| --- | --- |
| `apps/web/src/lib/use-modal-dialog.ts` (new, 63 lines): shared Escape/focus-trap/focus-restore primitive | ✅ correct: capture-phase window keydown for Escape, rAF focus-into-panel, double-modulo Tab cycling incl. shift-tab wrap, cleanup restores `previouslyFocused` |
| Both dialogs consume the hook (`unknown-scan-dialog.tsx`, `item-picker-dialog.tsx`) | ✅ |
| `items.tsx`: `role="status" aria-live="polite"` on scan notice; `aria-label` on search input; distinct `search.isError` branch with retry button; empty-state gated on `!search.isError`; imports shared `matchBadgeKey` | ✅ |
| `use-barcode-scanner.ts`: modifier-chord guard (`ctrlKey\|\|metaKey\|\|altKey` early-return); `SCAN_DUPLICATE_WINDOW_MS` injectable via `VITE_SCAN_DUPLICATE_WINDOW_MS` (validated `parseEnvInt`, ≥0 finite else default) | ✅ |
| `router.ts`: triplicated try/catch extracted into `withBarcodeConflict<T>` helper used by all three handlers (itemsCreate, itemsCreateWithStock, itemsUpdate) | ✅ identical semantics, one mapping site |
| `playwright.config.ts`: `VITE_SCAN_DUPLICATE_WINDOW_MS: "1200"` under webServer env | ✅ |
| `tests/e2e/ticket28.spec.ts`: deterministic duplicate-suppression via `/api/rpc/catalogSearch` request counting; cancel assertion switched to auto-retrying `toHaveCount(0)` | ✅ |
| New tests: concurrent same-barcode `itemsCreate` race (`Promise.allSettled("RACE-1")` → 1 fulfilled / 1 rejected BARCODE_EXISTS), `updateItem` barcode collision (rejects `/unique/i`, plus clear-then-move positive path), zod boundary of `catalogSearchInputSchema` through the RPC seam (empty + 129 chars both reject) | ✅ |

## Prior Notes addressed

1. **Note (helper extraction)** — `withBarcodeConflict` extracted at `apps/api/src/rpc/router.ts:216-226`; all three call sites converted. **Resolved.**
2. **Note (matchBadgeKey reuse)** — `items.tsx:13,141` now imports and uses the exported helper instead of re-inlining the string-mangling expression. The *debounce duplication* half of that note (shared 150 ms debounce effect between CatalogSearch and ItemPickerDialog) remains as-is — it was phrased as "consider extracting", acceptable as an open judgement-call follow-up. **Partially resolved (the flagged part is done).**

## Hygiene

- `router.ts` missing-trailing-newline note: **fixed** (file now ends `}\n`).
- New hygiene nit introduced by the fix commit: `playwright.config.ts` ends without a trailing newline (`\ No newline at end of file` on the new side of the diff). Cosmetic.

## New observations (minor, non-blocking)

- `useModalDialog` lists `onClose` in the effect deps; both callers pass inline arrow functions (`items.tsx:69,155`), so any parent re-render while a dialog is open tears down and re-runs the effect (restore-then-refocus). Functionally benign — the panel regains focus immediately and e2e is green — but memoizing the callbacks or splitting deps would remove the churn. Also `closeLabel`/`t` are dead weight (returned but never consumed).
- Residual risk carried over unchanged: "exact match adds immediately" is only fully demonstrable once ticket #30 provides an invoice/cart consumer.

## Verification run

- `bun run lint` → clean (oxlint, no findings)
- `bun run typecheck` → 3/3 packages successful
- `bun run test` → **89 pass / 0 fail**, 204 expect calls, 15.3 s (includes the 3 new audit tests)
- `bun run test:e2e` intentionally not run here; verified green upstream by the parent orchestrator.

VERDICT: PASS
