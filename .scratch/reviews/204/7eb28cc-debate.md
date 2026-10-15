# #204 — Debate evidence (delta round 2)

Head reviewed: `7eb28cc23d1c88bcd5e97ea923ecd90613c4c8e4`
Delta scope: `2ea36e8...7eb28cc`
Base: `8a7a7fa35de501efee15a802430193003926633d`
Tier: High-assurance (money-entering screen)
Method: independent critic + defender, plus three more reviewers (test-quality,
two-axis code-review) in one fan-out.

## Critic — findings and disposition

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| F1 | 6 | **In-flight refetch still posts.** `livePresentSupplierIds()` only blocks after the cache holds the fresh list. A refetch still in flight leaves the old list, so `dropped` is empty and the removed supplier travels in the batch. | **Accepted as out of scope, documented.** The Greptile finding is "the names refetch **finishes** while submit awaits"; a client cannot know a row is gone before the refetch writes. The doc comment was tightened so it no longer overclaims to cover this window. |
| F2 | 5 | The commit message claimed the fix was "independent of whether the effect or the resumed lookup wins", which reads as covering F1. | **Fixed** — comments scoped to the "refetch finished, effect not committed" window; the residual is named in the evidence. |
| F3 | 4 | **Evidence integrity: the race test was load-flaky** (a real `invalidateQueries` cache write could lose to the resumed `save()` under CPU load; a reviewer reproduced 6/6 failures). A nondeterministic guard is not evidence. | **Fixed** — the test now publishes the fresh list with a synchronous `setQueryData` before releasing the lookup. Re-verified 25/25 under 4 CPU burners, and it still fails when the write gate is reverted to the ref-only version. |
| F4 | 2 | False refusal or double-surface. | **No path found**: `droppedFilledDrafts` only returns filled drafts whose id is absent from `present`; `null` returns false; `setRemovedFilled` dedupes by id and deletes the drafts, so the effect recomputes nothing. |
| F5 | 2 | `abandonAttempt()` inside `removalBlocksSave()` could corrupt the refusal recovery. | **Safe**: it runs from `submit`/`save` handlers, never during render; in `save` it runs before `saveDismissal` is captured, and the early return skips recovery entirely. Dismissing the dialog is intended parity with the effect. |
| F6 | 2 | Stale ref/state-in-render hazard. | **None**: `draftsRef`/`removedFilledRef` are layout-effect synced; the gate reads live cache + live drafts; no render-time mutation. |
| F7 | 2 | Confirm-dialog and typed-new-row paths regress. | **Safe**: the confirm path is consistent with the effect; typed rows live in `newName`/`newAmount`, not in `drafts`, so `droppedFilledDrafts` ignores them. |

## Defender — key defenses (confirmed)

- Reading the live cache at write time is the correct minimal fix: silently
  filtering the row out is the #204 defect class, mirroring server rules drifts,
  and waiting on `fetchStatus` does not help because the refetch can be idle
  while React has not committed.
- The gate cannot fire without a genuinely vanished filled draft: the `null`
  case is skipped and only `status:"filled"` drafts are reported.
- No double-surfacing: the gate deletes the drafts and dedupes the notice by id,
  so the effect (reading the now-updated `draftsRef`) finds nothing dropped.
- `abandonAttempt` is the established dismissal + invalidation primitive.
- Disproof test: reverting `removalBlocksSave()` to the ref-only version makes
  the new race test fail (`captured` non-null). Supplied.

## Verdict

No blocker. F2/F3 (comment overclaim and the flaky guard) were fixed and
re-verified; F1 is inherent and explicitly scoped out; F4–F7 have no failing
path. The durable lesson remains
`.agents/wisdom/2026-10-15-live-write-gates-not-captured-render-values.md`,
extended by this round's rule: read the live cache at write time, not only state
set by an effect, and make the regression test deterministic.
