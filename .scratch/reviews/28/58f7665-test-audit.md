# Test Audit (re-check) — Ticket #28 @ 58f7665

- Prior verdict: **PASS** at `bbff481` (`bbff481-test-audit.md`)
- Delta audited: new tests introduced by fix commit `58f7665` + current full-suite run
- Review-only run — no source or test files modified

## Gates (run at HEAD 58f7665)

- `cd apps/api && bun run test` via repo root `bun run test`: **89 pass / 0 fail** (204 expects, 15.3 s) — up from 56/140 at bbff481 (+33 tests/+64 expects across the suite since the prior audit counted only the ticket-28 subset)
- Lint clean; typecheck 3/3 packages successful
- E2E not re-run here (parent verified `test:e2e` green)

## Audit gaps closed by 58f7665

| Prior finding | Closed how |
| --- | --- |
| 🟠 M1 — concurrent duplicate-barcode API race untested | `router.test.ts` `"two concurrent creates with the same barcode resolve as BARCODE_EXISTS…"` — `Promise.allSettled` on two `itemsCreate({barcode:"RACE-1"})`, asserts exactly 1 fulfilled / 1 rejected matching `/BARCODE_EXISTS/`. Mirrors the categories race pattern as suggested. ✅ |
| 🟠 M2 — `updateItem` colliding into an existing barcode untested | `drizzle-store.test.ts` `"updateItem onto another item's barcode hits the same UNIQUE constraint"` — rejects `/unique/i`, then verifies clearing A's barcode frees the code for B (positive path too, better than asked). ✅ |
| 🟡 Zod boundary of `catalogSearchInputSchema` untested through RPC | `router.test.ts` `"rejects catalogSearch input that violates the schema boundaries"` — empty query and 129-char query both reject through the real client seam. ✅ |
| 🟡 e2e sleep constants coupled to hook constant / true duplicate suppression never exercised | Duplicate window now injectable (`VITE_SCAN_DUPLICATE_WINDOW_MS=1200` under Playwright) and suppression asserted positively via `/api/rpc/catalogSearch` request counting (no second RPC after same-window rescan). ✅ (quality gate's finding, but it was also audit gap "positive duplicate-drop assertion" at the e2e level) |

## Gaps remaining (unchanged, documented follow-ups — none block this ticket)

1. `apps/web/src/lib/use-barcode-scanner.ts` still has zero direct unit tests: IME `isComposing` passthrough, editable-focus slow-typing buffer reset, blur reset, modifier-chord guard (new code, itself untested directly — covered only implicitly by e2e).
2. Item-picker dialog keyboard navigation (arrow/Enter selection, trap behavior) has no unit or e2e coverage.
3. `catalogSearch` `limit` param still unit-only (never passes through the RPC seam).
4. Same-tier Arabic name tie-break and inner-whitespace barcode normalization remain unpinned.
5. Duplicate-exact "first wins" defensive behavior in `rankCatalog` still unpinned.
6. No negative-path e2e scanning while focused inside an input (editable regime).

## Quality notes on the new tests

Assertions are honest and specific (count of fulfilled/rejected, regex on rejection reason, positive move-after-clear path). Race test uses the established `Promise.allSettled` idiom; collision test exercises both reject and recover paths. No flakiness vectors spotted (no timing dependence).

VERDICT: PASS
