# Issue 143 / PR #192 — round-1 test-audit evidence

- Base: `da44b50` (origin/develop merge-base)
- Round-1 delta audited: `e36d0fc` against `f048e45`; fixes folded through `12c7c49` → `60c1c0e` (final HEAD)
- Workflow: 3 read-only `reviewer` agents — edge-case hunter, coverage analyst, test-quality reviewer — plus a verification pass on the fold
- Test files audited: `apps/api/src/lib/stock-posting.test.ts`, `apps/api/src/rpc/router.test.ts`
- Inputs: `.scratch/sessions/143/e36d0fc-delta.diff`, `.scratch/sessions/143/12c7c49-fold.diff`, both test files, both source files

## Requirement coverage (round-1 brief)

| # | Requirement | Status |
|---|-------------|--------|
| 1 | Fake updates `item.costPrice` in `setItemStockAndCost`; a two-post test that **fails without the fix** | **Met.** Fake mirrors the real `UPDATE` (`stockOnHand` + `costPrice`); "defaults the next inflow to the cost the previous post wrote" expects `unitCost 567`; verified failing against the stale fake (`Received: 500`). |
| 2 | Batch path shares the history read and final cache write, preserving each line's movement row | **Met.** `recordStockMovements`: one `getItemsByIds`, one `listStockMovements` per distinct item, one `setItemStockAndCost` per item after the loop, one `insertStockMovement` per spec. `recordStockMovement` is the length-one case. |
| 3 | A multi-line scrap yields the same movements, `stockOnHand` and `costPrice` as the per-line path | **Met at the strongest seam.** The unit A/B drives identical specs (now including a zero-delta cost correction and a backdated sale, over a legacy null-cost inflow) through both paths and asserts `batchResults`, `movements` and `cache` are `toEqual`; the router test asserts 3 rows, sum −3, per-line ref/reason, `stockOnHand 0`, `costPrice 100`. |
| 4 | A test pins the number of history reads so a regression to per-line reads fails | **Met at both levels.** Unit: `stats === {historyReads: 1, cacheWrites: 1}` vs `specs.length` per-line. Router: a counting store asserts `expectedLedgerReads = 1 + 1`; verified that reverting to per-line posting yields **4**. |

## Edge-case hunter — missing cases and decisions

| Risk | Missing case | Decision |
|------|--------------|----------|
| ORANGE | Multi-item batch (fake is single-item by construction) untested | **Deferred** — no in-tree caller batches distinct items; production batches per item. Recorded in the debate evidence. |
| ORANGE | Mid-batch oversell leaves earlier rows, relying on the caller's transaction | **Documented** — the seam doc states the precondition; the scrap clamp makes it unreachable. |
| ORANGE | Counting test wrapped only `listStockMovements`; hard-coded `2` | **Fixed** — named `expectedLedgerReads` with a comment explaining the two reads. |
| YELLOW | Empty batch guard untested | **Fixed** — "touches the store for nothing on an empty batch". |
| YELLOW | `backdateTo` inside a batch untested | **Fixed** — a backdated SALE is now an equivalence-test spec. |
| YELLOW | Zero-delta `COST_CORRECTION` inside a batch untested | **Fixed** — a correction spec is now in the equivalence test. |
| YELLOW | 200-line scrap not exercised | **Accepted** — reads are pinned (constant with size); the in-memory replay is inherent and cheap. |
| YELLOW | Missing item mid-batch untested | **Fixed** — dedicated test, plus a precedence test added after the verification pass. |

The hunter found **no RED** (would-break) case; it traced multi-item grouping, the running-cache fallback and the deferral and found no correctness break in the shipped path.

## Coverage analyst

- Req 1 ✅, Req 2 ✅, Req 4 ✅; Req 3 met via the seam A/B plus router assertions (the literal router-level A/B is not reproduced — accepted).
- Good layering: unit A/B plus a counting-store integration test; the two read-count pins are complementary, not duplicated.
- Beyond-brief gaps listed by the edge hunter are all either fixed above or deferred with a reason.

## Test-quality reviewer

**Grade: A−** (no blockers).

- The two-post test pins the exact regression (asserts the fallback value and the live `item.costPrice`), not "does not crash".
- The batch test is a genuine differential oracle (same seed and specs through both paths, `toEqual` on results/rows/cache) and additionally pins the efficiency claim.
- The router counting test counts real ledger reads through the wrapped transaction and re-verifies behaviour, so the counter is not the only signal.
- Notes: `clientForStore` duplicates the `linkWith` body (test-only, deferred); the magic read count is now a named constant; multi-item and empty-batch were the noted gaps (empty batch now fixed).

## Verification pass on the fold

Confirmed the fold's lazy `cacheFor` is correct, `running` is complete, and the new tests are genuine. The one coverage note — the precedence fix was not directly pinned — was **fixed** with "reports an earlier movement's oversell before a later spec's missing item" (verified failing against the pre-fold upfront check).

## Post-fix state

- `bun test src/lib/stock-posting.test.ts` → 16 pass / 0 fail.
- `bun test src/rpc/router.test.ts` → 224 pass / 0 fail; full `bun test` (43 files) → 883 pass / 0 fail.
