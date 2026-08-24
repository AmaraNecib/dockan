# Review evidence — test-auditor
Base: 3bbad9c  Head: f2361d2

## Review — Test Audit, ticket #27 stock ledger (diff 3bbad9c...f2361d2)

### What's already well-covered (verified by reading the three suites)

- **Pure module** (`apps/api/src/lib/stock-ledger.test.ts`): multi-layer FIFO consumption with mixed costs (lines 20–38), same-timestamp ordering **by seq** (lines 40–48), `fallbackUnitCost` when inflow omits cost (lines 50–53), STOCK_NEGATIVE fail-loud + error code (lines 60–77), input non-mutation (79–84), empty ledger (86–88), `stockAsOf` boundary dates **equal** to movement dates incl. same-day-later-time inclusion (91–103), out-of-order `historyWithRemaining` (107–118), corrupt-history throw (120–125). This layer is genuinely strong.
- **Store** (`apps/api/src/store/stock-ledger-store.test.ts`): insertion-order tiebreak under identical timestamps (lines 39–70), per-item counts, opening-backfill idempotency via repeated `setup()` (84–110), skip-items-with-movements (112–124), transactional rollback of movement+stock pair (127–148).
- **E2E** (`tests/e2e/ticket27.spec.ts`): setup→login→item→manual stock-in→history row→oversell rejection via Arabic error text.

### Numbered missing tests

1. **GAP (HIGH)** — *No router-level test for `stockAddManual` at all.* `apps/api/src/rpc/router.test.ts` (read in full) has zero cases for `stockAddManual`/`itemsHistory`; grep confirms STOCK_NEGATIVE appears in no test outside the pure-module file. Add: `await expect(client.stockAddManual({ itemId, delta: -99 })).rejects.toMatchObject(/STOCK_NEGATIVE/)` **plus** `expect((await client.itemsHistory({ itemId })).movements.length)` unchanged — proving the rejected write left the append-only ledger untouched.
2. **GAP (HIGH)** — *No router-level test for the inflow unit-cost fallback* (`router.ts`: `input.unitCost ?? (input.delta > 0 ? item.costPrice : null)`). Add: create item with `costPrice: 200`, call `stockAddManual({ itemId, delta: 4 })` with no `unitCost`, then `itemsHistory` and assert the movement's `unitCost === 200`.
3. **GAP (HIGH)** — *No router-level test for cost blending on inflow.* `router.ts` writes `averageCostAfter(item.costPrice, stockOnHand, delta, unitCost)` back via `setItemStockAndCost`. Add: item cost 500/10 units, `stockAddManual({delta: 10, unitCost: 700})`, assert `itemsList()` returns `costPrice === 600` and `stockOnHand === 20`. Without this, the fast-path/dual-write drifts silently from the ledger — the exact HIGH-ASSURANCE risk.
4. **GAP (HIGH)** — *E2E cannot distinguish FIFO from LIFO.* `ticket27.spec.ts` creates exactly **one** inflow layer (+6 @ 2000) before the rejected oversell; every assertion passes identically under FIFO, LIFO, or average-cost. Add to e2e or (better) a router/store test: purchases of 5@100 then 5@200, sale of −6, assert remaining `unitCost` layer is 200 (FIFO) not 100 (LIFO), plus history `stockAfter` = [5,10,4].
5. **GAP** — *Arabic reason strings are inserted but never asserted anywhere.* Store test line 47 inserts `reason: "كسر"` yet the subsequent `listStockMovements` assertions check only deltas/seq — the round-trip of the Arabic string through sqlite is unverified, and e2e never fills the reason field. Add: `expect(rows.map(r => r.reason)).toContain("كسر")` in the store test; optionally e2e fills reason and asserts it renders in the history row.
6. **GAP** — *No post-rejection state check in e2e.* Step 5 asserts the error text but never re-verifies stock stayed at 6 (a buggy impl could apply the delta *and* show an error). Add: `await page.goto("/items"); await expect(row).toContainText("6")`.
7. **GAP** — *No `itemsHistory` output-shape test*: derived `stockAfter ≥ 0`, `seq` stripped from response, top-level `stockOnHand` equals projected ledger and equals `items.stockOnHand`. Currently only exercised indirectly via UI.
8. **GAP (mild)** — *No consistency-drift test between ledger projection and `items.stock_on_hand`* after several mixed operations — the acceptance criterion "current stock derived from movements" is only checked once.
9. **NICE-TO-HAVE** — *Same-timestamp ordering without seq (pure module)*: `ordered()` falls back to input index when both `seq` are undefined; only the with-seq variant is tested. Assert `[P(500,t), P(300,t), SALE(-10)]` leaves `{10, unitCost: 500}`.
10. **NICE-TO-HAVE** — *Mixed seq present/absent at same timestamp*: current comparator ignores a defined seq when the counterpart lacks one; pin the intended behavior with a test.
11. **NICE-TO-HAVE** — *Sale-to-zero then repurchase*: consume all layers exactly (`SALE -10` after `PURCHASE 10`), then `PURCHASE 5@300`; assert `layers === [{quantity:5, unitCost:300}]`.
12. **NICE-TO-HAVE** — *Adjacent same-cost layer merging* (`last.unitCost === unitCost` branch) is untested; a regression changes layer topology that future COGS math will walk.
13. **NICE-TO-HAVE** — *Zero-delta movement through the module*: contracts reject delta 0 at the API input, but `projectLedger` silently ignores such rows if a corrupt row lands in the DB; document/pin behavior.
14. **NICE-TO-HAVE** — *Concurrency*: no parallel `insertStockMovement` calls (the router suite already has a concurrency precedent at "two concurrent creates"). SQLite single-writer makes failure unlikely; one smoke test would close it.
15. **NICE-TO-HAVE** — *`occurredAt` defaults to now* when omitted at the API; and huge-delta sanity (e.g., delta 1_000_000_000 projects correctly).

### Overall coverage verdict

**Not adequate for HIGH-ASSURANCE tier as-is.** The pure-math seam (layer 1) is excellent — FIFO, seq tiebreak, fallback cost, negative-stock, and `stockAsOf` boundaries are properly exercised. The store seam is solid except for the unasserted Arabic reason round-trip. But the middle seam — the oRPC router where money-relevant decisions (cost fallback, weighted-average writeback, STOCK_NEGATIVE → BAD_REQUEST, append-only integrity under rejection) actually live — has **zero** ledger tests, and the e2e's single-layer scenario is provably blind to a LIFO implementation. Items 1–6 should land before this diff feeds COGS/profit math.