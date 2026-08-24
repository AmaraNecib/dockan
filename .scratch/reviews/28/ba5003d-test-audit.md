# Test Audit (addendum) — Ticket #28 @ ba5003d

- Base audit: **PASS** at `58f7665` (`58f7665-test-audit.md`)
- Delta audited: fix commit `ba5003d` — adds **no new tests**; changes only
  `apps/web/src/{lib/i18n.ts, lib/use-barcode-scanner.ts, pages/items.tsx}`.
  Review-only run — no source or test files modified.

## Gate results at HEAD ba5003d

- `bun run lint` → clean
- `bun run typecheck` → 3/3 packages successful
- `bun run test` → **89 pass / 0 fail**, 204 expects (bun task cache hit — legitimate:
  delta is web-only, the unit suite lives in `apps/api`, unchanged since 58f7665 where it
  ran green cold)
- e2e not re-run per instructions; parent verified `test:e2e` 3/3 green at this commit,
  which covers the changed scan flows end-to-end.

## Coverage impact of the delta

| New behavior | Covered by | Assessment |
| --- | --- | --- |
| RPC failure → retry notice instead of unknown dialog (`items.tsx`) | Not directly unit-tested; exercised by existing e2e scan happy paths only indirectly | 🟡 gap — a mocked-RPC-rejection test would pin the branch |
| Confirmed miss → unknown dialog (restructured control flow) | Existing e2e unknown-scan scenarios (parent-verified green) | ✅ behavior preserved |
| Mid-burst target-change buffer reset (`use-barcode-scanner.ts`) | None directly; hook still has zero direct unit tests | 🟡 carried-over gap (see below) |

The restructure of `handleScan` (result hoisted out of try) is behavior-preserving for both
success paths and is guarded end-to-end by green e2e at this exact commit, so the lack of a
dedicated rejection-path test does not block.

## Gaps remaining (unchanged from base audit + two delta-specific notes)

1. `use-barcode-scanner.ts` still has zero direct unit tests; the new target-change reset
   joins IME passthrough / editable gap reset / modifier guard as implicitly-covered logic.
2. No unit/e2e test simulates `catalogSearch` rejecting during a scan to pin the retry-
   notice branch.
3. All six carry-over gaps from `58f7665-test-audit.md` remain open (picker keyboard nav,
   RPC-seam limit param, Arabic tie-break, whitespace normalization, rankCatalog first-wins,
   editable-regime negative e2e). None block ticket #28.

## Test-quality check of the delta

No assertions added or weakened; no timing constants introduced; no test files touched.
Nothing in the delta can destabilize the suite.

VERDICT: PASS
