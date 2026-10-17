# Code review — #257 review round 2 (PR #266)

- **Reviewed head:** `893ab0e` (fix round; base `5723f91a` = the PR head Greptile scored 3/5)
- **Tier:** standard
- **Spec:** `D:/projects/mani-project/.scratch/sessions/crew/briefs/feat-257-inline-product-round2.md`
  — close or refute **F1 "Old create changes new line"** (`r4302740535`) and
  **F2 "Purchase stocks wrong product"** (`r4302740540`), both in
  `apps/web/src/pages/purchase.tsx`.
- **Runner:** independent `reviewer` sub-agent (code-review lens, Standards + Spec), read-only.
- **Disclosure:** the lens **ran no test, typecheck or lint command** (it listed
  the read-only git/grep/sed commands it did run and said so explicitly). Every
  gate claim below was reproduced in-lane and is recorded in the commit message of
  `893ab0e`.

## Spec axis

| Finding | Verdict | Line evidence |
|---|---|---|
| F1 "Old create changes new line" | **CLOSED** | The effect at `purchase.tsx` (`lineDraftTarget`/`linePendingTarget` → `lines.some(...)`) clears the form and abandons the attempt when the target line is gone; `abandonLineCreate()` bumps `lineAttemptRef`, so the in-flight write fails `attempt !== lineAttemptRef.current` and cannot re-point a line that reuses the item id. Test "does not let a create in flight re-point the line that re-adds its deleted item" — red before, green after. |
| F2 "Purchase stocks wrong product" | **CLOSED** | `lineCreatePending` is set before the `await`, cleared on answer/failure/cancel, and the save is `disabled={createInvoice.isPending || lineCreatePending !== null}` with a `role="status"` reason line. Tests "blocks the invoice save while a line create is in flight" and "frees the invoice save when the owner cancels the create in flight" assert `disabled` and `lastPurchaseInput === null`. |
| "Save after a failed create" (the brief's own risk list) | **CLOSED in code, test gap found** | The pending clears before the `!outcome.ok` branch, so a failed create releases the save. Acted on: the gap is now covered by "frees the save when the create fails while the form is still on its line". |
| Deadlock / stuck disabled button / save that can never happen | **REFUTED** | No reachable path: cancel is never disabled and is the universal escape; every clear path bumps the attempt and clears the gate together. |

## Standards axis — PASS

- **Blankness ratchet:** no new raw `.trim()` blankness gate is added by the diff;
  the four pre-existing gates in `purchase.tsx` stay classified `raw` in
  `blankness-ratchet.test.ts`, which stays green.
- **Naming and comments:** `PendingLineCreate`, `lineCreatePending`,
  `abandonLineCreate` are descriptive; the comment idiom
  (`#257 review round 2 (F1)/(F2)`) matches the file's existing
  `(review round 1, M3)` style.
- **Hook rules:** the new `useEffect` is top-level and unconditionally called; no
  conditional hooks.
- **i18n:** single locale (`ar`); the key sits with the other `purchasesLine*` keys.
- **a11y:** the focus obligation (`requestFocus`) and its WCAG comment are
  preserved; the new status line closes the only gap found.

## Findings and disposition

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | P2 | No test for "owner unable to save after a failed create". | **Acted on.** New test covers it (see the Spec table). |
| 2 | P3 | Stale comment: "A retarget or a cancel keeps `lineDraft` and `lineCreatePending` pointed at the same line" — a retarget calls `abandonLineCreate()`, which nulls the pending, so that state cannot occur. | **Acted on.** Reworded: the draft's target is the one that matters; the pending target is a defensive fallback. |
| 3 | P3 | The disabled save carries no accessible reason: the new string was only set by the (unreachable) `submit()` guard, so a screen-reader user met a disabled Save with no explanation. | **Acted on.** The string is now rendered as a `role="status"` line beside the save while a placement is owed, and the unreachable guard was removed. |
| 4 | P3 | `purchasesLineCreatePending` was effectively dead in the UI (every path to `submit()` went through the disabled button). | **Acted on.** The guard is gone; the string renders. |
| 5 | P3 | The effect reads `abandonLineCreate` without listing it in the deps array; `react-hooks/exhaustive-deps` unverified. | **Verified in-lane.** `bun run lint` → exit 0; no rule fires. |
| 6 | P3 | "explicitly cancelled" is wider in the brief than in the implementation: opening a create on another line also releases the save. | **Refuted as harm, now pinned.** `replaceDraftLineItem` no-ops for an item id that is gone, so the line still shows the product the invoice books; round 1 set the rule that a retarget abandons the placement. The retarget test now asserts the released save. |

## In-lane re-runs behind this review

- `bun run typecheck` → exit 0 (4/4 turbo tasks); `bun run lint` → exit 0.
- `bun test src/pages/purchase.test.tsx` → 46 pass / 0 fail.
- Ablations → 5/5 red (`A1`–`A5`), control green.
- Web sweep, 78 files by name → 1302 pass / 0 fail.
- E2E in an `e2e-slot.sh` slot → 7 passed
  (`purchase-inline-product`, `purchase-intake`, `stock-ledger`).
