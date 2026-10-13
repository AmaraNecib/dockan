# Issue 143 — code-review evidence (Standards + Spec axes)

- Base: `da44b50`. Reviewed HEAD: `2a86b46` (reviews ran on earlier SHAs; fixes folded into `2a86b46`).
- Two parallel read-only reviewers: Standards axis and Spec axis.
- Diff: `.scratch/sessions/143-review-80fb564.diff` (the reviewed increment).

## Standards

**Hard violation — fixed.**
1. *Stale evidence filename.* `docs/engineering-workflow.md`: evidence filenames must contain the reviewed HEAD SHA. The source commit tracked `.scratch/reviews/143/156e135-debate.md` while HEAD had moved. **Fixed** in the evidence commit: debate/test-audit/code-review now name `ba3230ad`, and the superseded file is removed.

**Hard-ish — dismissed with reason.**
2. *Source-only change policy.* The commit carries `.scratch/implementation/143-design.md`. The repo already tracks every prior design doc under `.scratch/implementation/` (20+ files), so the design is a standard tracked artifact here, not a build/coverage artifact. Kept.

**Judgement calls (baseline smells).**
- *Duplicated Code* — `postStock` repeated the two `instanceof` checks already in the mapper. **Fixed:** the mapper is now inlined into `postStock` (one function, one check per class, no unreachable rethrow).
- *Speculative Generality* — `StockMovementSpec.fallbackUnitCost` was never supplied by any router call site. **Fixed:** removed; the replay fallback is always the item's cached `costPrice`, matching ADR-0002.
- *Data Clumps / Primitive Obsession* — the movement fields are spelled once in the `candidate` and once in the insert payload, and the `delta` sign triad appears twice. **Accepted:** the candidate is the ledger-math shape; the insert payload is the store shape. Merging them would couple the module to the store row type for little gain.
- *Middle Man* — `itemStockProjection` is a thin pass-through. **Accepted:** it is the read seam `returnsReject`'s clamp and `itemsHistory` need; documented in the design.
- Comment conventions verified: locale-neutral oRPC tokens and a `SAFETY:` justification at the SALE snapshot. DoD verified: no `projectLedger`/`weightedAverageCost`/`setItemStockAndCost` calls remain in `router.ts`.

## Spec

**Requirements verified.**
- DoD "the call sites call one function; `projectLedger`/`weightedAverageCost`/`setItemStockAndCost` are no longer called from `router.ts` for stock writes": met (grep-verified).
- Q1 FIFO snapshot returned for `delta < 0`: met. Q4 typed refusals + one mapper: met (mapper inlined). No schema/contract change: met.
- Crux: **sound.** The diff does not silently pick — it hardcodes full-ledger replay with a code comment, documents the decision in the design, and pins the diverging case (backdated outflow → 233) at unit and wire level. ADR-0005 states verbatim "the average is replayed from the full ledger after any write", so the rule is directly supported (and Q2 chose it).
- "Existing wire tests stay green": the parent ran `bun test apps/api/src/rpc/router.test.ts` → 223 pass / 0 fail (6 consecutive runs after the flaky-assertion fix).

**Scope.**
- Nine sites, not six: **justified.** The three extras (`itemsCreateWithStock`, `itemsUpdate`, `suppliersReturn`) each inline the write sequence, and the DoD cannot hold while they do.
- `itemsHistory` read swap (`projected.at(-1).stockAfter` instead of `projectLedger`): numerically equivalent, a read not a write; kept so the reader also drops the `projectLedger` import.
- Second deliberate change (uniform replay fallback): characterised in the design, unreachable with current data (no code path writes a positive-delta null-cost row), and pinned by a unit test.

## Synthesis

| Finding | Decision |
|---|---|
| Stale evidence filename | Fixed (evidence commit) |
| Mapper duplication / unreachable rethrow | Fixed (inlined) |
| `fallbackUnitCost` speculative surface | Fixed (removed) |
| Design doc tracked | Kept (repo convention) |
| Nine sites | Kept (DoD) |
| `itemsHistory` read swap | Kept (equivalent, drops the import) |
| Uniform fallback as a second change | Kept + documented + pinned |
| Data clumps / sign triad / middle man | Kept (judgement calls) |

No Standards or Spec blocker remains after the fixes. Residual: no ADR added for the valuation decision (the rule is already stated in ADR-0005 and the decision is recorded in the design + debate evidence).
