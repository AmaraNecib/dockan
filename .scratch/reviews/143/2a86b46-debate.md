# Issue 143 — debate evidence (critic + defender)

- Base: `da44b50` (origin/develop merge-base)
- Reviewed HEAD: `2a86b46` (debate ran on `ea8804b`; fixes folded through `156e135` → `80fb564` → `ba3230ad` → `2a86b46`)
- Workflow: 2 reviewers in parallel — harsh critic + charitable defender (`reviewer` agent, read-only)
- Inputs: `.scratch/sessions/143-debate-ea8804b.diff`, `.scratch/sessions/143-issue.txt`, `.scratch/implementation/143-design.md`, full changed files.

## Critic findings

| # | Sev | Finding | Decision |
|---|-----|---------|----------|
| 1 | 5 | `stockAddManual` inflow now supplies a replay fallback (`item.costPrice`) it did not have; base passed none (null-cost inflow contributed 0). Latent — no code path writes a positive-delta null-cost row — but a second behaviour change beyond the outflow rule. | **Fixed (characterised):** kept the uniform fallback as a deliberate second unification (one home for the invariant) and pinned it with a unit test; documented in the design. |
| 2 | 4 | `itemsUpdate` cache source changed from cached `stockOnHand` to `projection.stockOnHand`; differs only if the cache was already drifted. | **Accepted:** intended self-healing, same for opening/suppliersReturn; documented in the design. |
| 3 | 3 | `posted.outflowCost!` non-null assertion; a zero-quantity SALE line would throw a `TypeError`. | **Fixed:** replaced with an explicit guard (contract quantity is `positive()`, so unreachable; the guard keeps types honest). |
| 4 | 3 | `postStock` dead rethrow reads as if a raw error could escape. | **Fixed:** catch now narrows to the two domain error classes; anything else rethrows. |
| 5 | 3 | Per-movement item re-fetch adds one query per line. | **Accepted:** the module must not trust a caller-cached `costPrice`; one indexed lookup inside the caller's transaction. Documented. |
| 6 | 2 | `StockItemMissingError` → `BAD_REQUEST` while other sites use `NOT_FOUND`. | **Accepted:** matches the historical `stockAddManual` refusal; backstop only (every site pre-validates). |
| 7 | note | `purchasesCorrectLine` two-step validation writes an intermediate cache before the reversal. | **Verified equivalent:** final committed state and rowid order match; rollback on failure. |

Critic confirmed correct: the backdated-outflow crux is real and pinned at both unit and wire level (233); `returnsReject` per-line vs aggregate is safe; the SALE movement-before-line reorder is FK-safe; `itemsHistory` last running balance equals `projection.stockOnHand`.

## Defender highlights

- Sequence owned once; DoD verified (no direct `projectLedger`/`weightedAverageCost`/`fifoOutflowCost`/`setItemStockAndCost` calls remain in `router.ts`).
- Validation precedes writes; the SALE FIFO snapshot comes from the same read that moves stock.
- One error mapper replaces five inline `try/catch` blocks (strict superset of the old mappings).
- Outflow unification is the ADR-0005-correct value and equals the old preserve branch for in-sync, non-backdated outflows.
- Nine sites, not six: the DoD forbids direct math calls for stock writes, and the design explains the three handlers absent from the older review snapshot.
- Honest weaknesses: `itemsCreateWithStock` with `stockOnHand = 0` (contract requires `min(1)`, so unreachable); `itemsUpdate` projected `stockOnHand` (accepted, above).

## Synthesis

- Blocker/major (8–10): none.
- Fixed now: findings 1, 3, 4 (plus the design doc characterisation).
- Accepted with written reason: findings 2, 5, 6, and the note.
- Dismissed: none.
- No `decisionRequest` needed for the outflow rule: ADR-0005's "replayed from the full ledger after any write" and ADR-0002's amendment settle it.

## Post-fix state

- `bun test src/lib/stock-posting.test.ts` → 11 pass / 0 fail.
- `bun run lint` → clean.
- Reviewers did not execute the suite (read-only); the parent ran Guard Phase 1 separately.
