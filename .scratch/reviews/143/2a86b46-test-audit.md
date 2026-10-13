# Issue 143 — test-audit evidence

- Base: `da44b50`. Reviewed HEAD: `2a86b46`.
- Three parallel read-only reviewers: edge-case hunter, coverage analyst, test-quality reviewer.
- Inputs: `.scratch/sessions/143-review-156e135.diff`, `.scratch/sessions/143-issue.txt`, design doc, source, and the two test files.

## Coverage map (nine write sites → parity tests)

| Call site | Test pins rows / stockOnHand / costPrice |
|---|---|
| `itemsCreateWithStock` | ✓ / ✓ / ✓ |
| `itemsUpdate` | ✓ / ✓ / ✓ |
| `stockAddManual` | ✓ / ✓ / ✓ (+ backdated-outflow rule 233) |
| `invoicesCreate·SALE` | ✓ / ✓ / ✓ (+ per-line FIFO test added) |
| `invoicesCreate·PURCHASE` | ✓ / ✓ / ✓ |
| `returnsCreate` | ✓ / ✓ / ✓ |
| `returnsReject` | ✓ / ✓ / ✓ (costPrice assertion added) |
| `purchasesCorrectLine` | ✓ / ✓ / ✓ |
| `suppliersReturn` | ✓ / ✓ / ✓ |

All design planned unit tests exist, plus an unplanned inflow-first-ordering test. Diversity is good (blend, FIFO snapshot, backdate clamp, reject/rollback, correction ordering, cache assertions) rather than one repeated shape.

## Findings and decisions

| Source | Severity | Finding | Decision |
|---|---|---|---|
| edge | 🔴 | Mapper + multi-movement rollback untested. | **Covered by pre-existing tests:** `stock ledger (ticket 27)` oversell asserts `STOCK_NEGATIVE` and an untouched ledger (mapper); `purchasesCorrectLine` "rejects a correction that would oversell … and writes nothing" exercises the two-call first-succeeds/second-throws rollback. No new test needed. |
| edge | 🟠 | Fractional/NaN delta bypasses the mapper (plain `Error` from `fifoOutflowCost`). | **Accepted:** unreachable through the contract (`delta`/`quantity` are `int().positive()`); matches base behaviour (also a plain `Error`). |
| edge | 🟠 | Correction × backdated replay untested. | **Covered by pre-existing issue-144 tests:** "keeps a correction against a future-dated row, then blends a later purchase from it" (the harder ordering) and "keeps an edited cost across a later purchase replay". |
| edge | 🟠 | `seq` presence assumed. | **Verified:** the store returns `seq` (`drizzle-store.ts` `listStockMovements` selects `rowid`); the fake now supplies and orders by it. |
| edge | 🟠 | Multi-line SALE untested. | **Fixed:** added "each line's FIFO read sees the prior line's movement" (cogsExact `[300, 600]`, costAtSale `[100, 150]`, stock 3, cost 150). |
| edge | 🟠 | Race/read-modify-write. | **Accepted:** behaviour-preserving; callers run inside the store's serialized transaction. |
| edge | 🟡 | Zero-delta non-correction no-op, zero-cost fallback, returnsCreate fallback. | **Accepted:** latent/unreachable or already covered elsewhere. |
| coverage | — | `returnsReject` parity omitted `costPrice`. | **Fixed:** added `costPrice === 100`. |
| coverage | — | Wire test for `StockItemMissingError` mapper. | **Accepted:** the branch is a pre-validated backstop; every wire call site checks the item first, so it is unreachable through the contract. |
| coverage | — | Duplicate coverage with pre-existing suites. | **Accepted:** the parity tests add value by pinning rows + stockOnHand + costPrice together. |
| quality | minor | Setup duplication (`itemsAll().find(...)` repeated). | **Accepted:** mirrors the existing repo test style; the parity block is small and each anchor names its item. |
| quality | minor | Fake ordering diverged from the store. | **Fixed:** the fake now sorts by `occurredAt, seq`, mirroring `listStockMovements`. |
| quality | minor | `fallbackUnitCost` explicit override untested. | **Fixed:** the unused spec field was removed in the code-review pass; the replay fallback is always the item's cached cost, and that default path is pinned. |

## Post-fix state

- `bun test src/lib/stock-posting.test.ts` → 11 pass / 0 fail.
- `bun test src/rpc/router.test.ts -t "movement posting seam parity"` → 11 pass / 0 fail.
- Quality grade: A− (no correctness blockers; the reviewer called the suite trustworthy for a behaviour-preserving refactor).
