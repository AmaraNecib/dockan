# #204 — Code-review evidence (two axes, delta round 2)

Head reviewed: `7eb28cc23d1c88bcd5e97ea923ecd90613c4c8e4`
Delta scope: `2ea36e8...7eb28cc` (PR #219 fix round 2)
Base: `8a7a7fa35de501efee15a802430193003926633d`
Method: independent Standards and Spec `reviewer` agents over the delta diff.

## Standards

Sources: `docs/engineering-workflow.md`, `CONTEXT.md`, `AGENTS.md`,
`.agents/wisdom/*` (notably
`2026-10-15-live-write-gates-not-captured-render-values.md`),
`.agents/skills/*`; plus the Fowler smell baseline.

| Finding | Disposition |
|---|---|
| No documented-standard violations. The change follows the repo's own wisdom rule: back the gate with a ref synced in the same commit and read it inside `save()`; it reads the live cache the way `liveListFailure()` already does, and calls `abandonAttempt()` so the state change also invalidates the in-flight attempt. The `present === null` case honours the same file's "skip null, or a cache reset flags every draft" trap. | clean |
| Duplicated shape: the reconciliation `useEffect` body and `removalBlocksSave` repeat `abandonAttempt(); setRemovedFilled(dedupe-by-id); setDrafts(delete)`. | **Accepted (non-blocking)**: both already call the one shared pure seam `droppedFilledDrafts`; the three-line apply is small and colocated with its two call sites. A shared `applyDroppedDrafts(dropped)` is a reasonable follow-up but not required. |
| Primitive obsession / duplicated convention: `livePresentSupplierIds(): string[] \| null` encodes "absent vs empty" in a nullable array and restates the `{ items: { id }[] }` payload shape. | **Accepted**: matches the page's existing nullable-data convention for `presentSupplierIds`; the comment states the `null` meaning. |
| `livePresentSupplierIds()` re-derives what the `presentSupplierIds` memo computes (memo reads merged `suppliers`; cache reads raw names). | **Accepted, documented**: the memo gates the render-time effect; the cache read is the authoritative write-time source. The divergence is intentional and commented (the render value can lag the cache). |
| Test hooks mirror the existing `resolveHold`/`mutationHold` pattern and reset in `beforeEach`. | clean |

## Spec (the two Greptile findings this round closes)

| Requirement | Status |
|---|---|
| F1: "Check the latest cached supplier IDs before writing, rather than relying only on state set by the effect." | **Covered** — `livePresentSupplierIds()` reads `queryClient.getQueryData(orpc.suppliersListNames.queryKey())` at write time; `removalBlocksSave()` blocks, surfaces the loss, and drops the vanished drafts. |
| F1: "The new race test calls `settle()` before releasing the lookup, so it misses this ordering." | **Covered** — the old `settle()`-then-release order is gone; the fresh cache is published (synchronous `setQueryData`, i.e. the refetch's write) and the held lookup released in the same tick, so `save()` sees the fresh cache while the removal effect is uncommitted. Verified to fail with the gate reduced to the ref-only version. |
| F2: "Add a test that resets the query while its replacement read is held. Check that no removal notice appears, then release the read and verify that the typed amount remains and can be saved." | **Covered** — the new test asserts the loading state + no `opening-balance-removed` while `namesHold` holds the reset's replacement read, then releases and saves the surviving `100` plus the typed `50`. Fails when the `presentSupplierIds === null` guard is removed. |
| Rules: do not weaken the removal notice, the blocked save, or the silent-drop-for-unfilled-rows behaviour. | **Preserved** — the write gate is the same notice/block, now also live at write time; `droppedFilledDrafts` still only reports `status:"filled"` drafts. |
| Rules: keep the #196 `saveQuickAdd` helper and `tests/e2e/rpc-helpers.ts` intact. | **Untouched** — the delta is two files under `apps/web/src/pages/`. |

Scope creep: none. Implemented-but-wrong: none after the review-driven test/
comment corrections above.

## Residual (documented, not a blocker)

A names refetch that is still **in flight** (cache not yet written) cannot be
detected by any client-only gate; the finding is scoped to "the refetch
finishes". The doc comment now says so explicitly. This is pre-existing and out
of scope for this round.

## One-line summary

Standards: 0 hard violations (4 judgement-call smells accepted, all with
rationale); Spec: both Greptile findings covered at code + test level, residual
in-flight window documented, 0 blockers.
