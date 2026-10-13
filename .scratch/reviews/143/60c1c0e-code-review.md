# Issue 143 / PR #192 — round-1 code-review evidence (Standards + Spec)

- Base: `da44b50` (origin/develop merge-base)
- Round-1 delta reviewed: `e36d0fc` against `f048e45`; fixes folded through `12c7c49` → `60c1c0e` (final HEAD)
- Workflow: 2 read-only `reviewer` agents — Standards axis and Spec axis — plus a verification pass on the fold
- Inputs: `.scratch/sessions/143/e36d0fc-delta.diff`, `.scratch/sessions/143/12c7c49-fold.diff`, full changed files, `AGENTS.md`, `docs/engineering-workflow.md`, `docs/adr/0002`, `docs/adr/0005`, surrounding `apps/api` style, `.scratch/implementation/143-design.md`, the round-1 brief

## Standards

**(a) Documented-standard breaches (hard): none found.**

- Every type assertion carries a `SAFETY:` comment (`stock-posting.ts` `posted!`, `router.ts` `posted!`), matching the repo's wisdom note; oxlint/anti-slop is clean.
- Doc comments were updated where behaviour changed (`recordStockMovements` header, `postStockBatch` note); the ADR-0002/0005 rules themselves are unchanged, so no ADR edit is owed.
- The design test plan is honoured (unit seam + wire parity).

**(b) Baseline smells (judgement calls).**

| Smell | Location | Decision |
|-------|----------|----------|
| Middle Man / Speculative Generality | `recordStockMovement` is now a pure delegation with no production caller | **Dismissed** — the brief requires the single-item path to remain a thin case over the batch; it is the seam's public single-movement API, exercised by tests. |
| Data Clumps | four parallel maps keyed by `itemId` (`items`, `history`, `running`, `appended`) | **Deferred** — a single per-item struct would drop two non-null assertions; not worth the churn in this review round. |
| Duplicated Code (test) | `clientForStore` copies the `linkWith` body | **Deferred** — test-only boilerplate, low value. |
| Note | the batch removes IO, not the per-line in-memory sort | **Fixed** — comments now say the store round-trips were the blocking cost. |
| Nit | `postStockBatch` dropped the `readonly` the lib accepts | **Fixed** — signature is now `readonly StockMovementSpec[]`. |

The standards axis traced behavioural equivalence independently and agreed appended candidates (`seq: undefined`, input-index tie-break) match the rowids the per-line path assigns.

## Spec

Spec sources: the round-1 brief (`.scratch/sessions/crew/briefs/feat-143-greptile-round1.md`) and the issue-143 design.

**(a) Missing / partial**

- **Partial, accepted:** the brief's symptom was "reads **and replays** an item's whole history per scrapped line". The fix collapses the reads and the cache write to once per item; the in-memory replay still runs once per movement. The commit message and comments claim only the reads/writes win, so the claim is accurate. Only the IO half of the symptom needed fixing to stop blocking other store requests; the replay is O(lines × history) CPU and is inherent to the per-line movement rows.
- **Unpinned clause, deferred:** "one history read per item" for a multi-item batch is not tested (production batches per item). Recorded in the debate evidence.

**(b) Scope creep**

- All nine single-post call sites now funnel through the batch accumulator (`postStock` → `postStockBatch` → `recordStockMovements`). This is required by the brief's "one implementation of the rule, not two"; a one-element batch is behaviour-identical (proven by the length-one path and the full unit suite).
- The fake additionally models `stockOnHand` and a `stats` counter beyond the brief's "fake updates `item.costPrice`" — necessary to assert the batch's read/write counts.

**(c) Implemented but wrong: none found.**

The spec axis verified the exact numeric equivalence of the two test-post chain (500 → 567 → 567) and the read-count pins at both levels.

## Verification pass on the fold

The fold addressed critic finding 1 (error precedence) and the comment/readonly nits. The verification reviewer confirmed: no number can differ from the per-line path; `running` is complete; the new tests are genuine. One coverage note (precedence unpinned) was fixed with an extra test.

## Summary

- Standards: 0 hard breaches; 2 judgement-call smells fixed, 2 deferred, 1 dismissed. Worst issue: the perf-comment overstatement (fixed).
- Spec: 0 wrong implementations; 2 partial/deferred items (both recorded). Worst issue: the "replay" half of the symptom is not eliminated (documented, not needed to stop the blocking).
- One-line: **both axes pass** — no blocker or major finding on either.
