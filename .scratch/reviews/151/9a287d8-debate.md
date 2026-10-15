# Issue 151 — Debate (critic + defender)

Head reviewed: `9a287d8` (merge-base `3c3abcf`). Tier: Standard (brief requested
debate explicitly). Two independent reviewer children ran the critic and
defender briefs against `git diff 3c3abcf...d8355fd`; this file synthesizes them
against the final head.

## Critic findings

| # | Severity | Finding | Verdict |
|---|---|---|---|
| 1 | 9 | Pagination: the badge is computed on the current page only, so a correction on an earlier page never badges a superseded inflow on a later page. | **Deferred (out of scope).** Fixing needs recording order on the wire (`seq`), which the brief forbids ("no schema/contract change"). The exact issue scenario (correction + future row in one page) works. Documented under "Known limits" in `151-design.md`; surfaced to the parent in the handoff. |
| 2 | 7 | `router.ts` strips `seq` while replay orders by it. | **Deferred.** Same contract constraint. `createdAt` is the closest signal the view has. |
| 3 | 6 | `createdAt` is a wall-clock proxy; backup-restore/clock skew could reorder it. | **Dismissed (for normal flow).** The store sets `createdAt = now()` at insert; no restore path re-inserts movements. The fixed-width `YYYY-MM-DDTHH:mm:ss` shape is schema-enforced, so the lexical compare is sound. |
| 4 | 5 | Strict `createdAt >` misses a same-second purchase-then-edit. | **Addressed.** The e2e now waits out the second boundary before the edit; the strict tie is a documented, tested under-annotation. |
| 5 | 4 | With two corrections straddling the row, the badge may name the wrong correction above. | **Dismissed.** The badge says "recorded before the cost correction above, so its effect on the average was replaced". Any correction drawn above and recorded after the row implies the row's contribution was replaced by the earliest such correction; the statement stays true. |
| 6 | 3 | `isCostCorrection` requires a non-null unit cost, so a null-cost correction is invisible. | **Dismissed.** Mirrors the api exactly (`stock-ledger.ts:218`): a null-cost zero-delta row is a replay no-op, so it must not supersede anything. Locked by a new unit test. |
| 7 | 4 | Badge uses physical `mr-2` and is inline prose with no ARIA role. | **Dismissed.** `mr-2` matches the sibling reason span two lines above; the text is informative and screen-reader visible (an annotation, not decoration). |
| 8 | 3 | A warning chip is louder than "render the correction at its recording position". | **Dismissed by design choice.** The brief explicitly allows either; annotating the superseded row avoids reordering rows (which would sacrifice the date-ordered ordinary case). |

## Defender findings (confidence)

- Diagnosis matches ADR-0002 and `drizzle-store.ts` `orderBy(occurredAt, rowid)` (10/10).
- Minimal display-only change: `stock.tsx` + `i18n.ts` only, no API/contract/money path (9/10).
- Pure, exported, guarded helper with `noUncheckedIndexedAccess` handling (9/10).
- Conservative strict tie (8/10).
- Tests prove the behaviour at unit and e2e level (9/10).
- E2E seeds via a typed RPC envelope and completes a real UI cost edit (8/10).
- Overall: 9/10.

## Synthesis

No blocker was in scope for this ticket. The one high-severity finding
(pagination) is a real limitation of the no-contract-change rule, not a defect
in the chosen label; it under-annotates and never changes a displayed number. It
is documented and handed to the parent as a decision item. Same-second and
page-local limits are both documented in the design doc. No code path touches
the ledger, replay, or any computed cost.
