# Test audit — #257 review round 2 (PR #266)

- **Reviewed head:** `893ab0e` (fix round; base `5723f91a` = PR head Greptile scored 3/5)
- **Tier:** standard
- **Scope:** `git diff 5723f91a..893ab0e` — the two-finding fix on the inline
  product-create path of `apps/web/src/pages/purchase.tsx`, its five new tests in
  `apps/web/src/pages/purchase.test.tsx`, and one i18n key.
- **Runner:** independent `reviewer` sub-agent (test-audit lens), read-only.
- **Disclosure:** the lens **ran no tests** (it said so itself: "I ran no tests —
  budget ran out before a `vitest` run, so every 'pinning' claim below is mutation
  *reasoning* from source, not an executed failure"). Every executed claim in this
  file was re-produced in-lane: the red run, the green run, the 5−ablation matrix
  and the 1302-test web sweep, all recorded in the commit message of `893ab0e`.

## Correct, with the evidence it cites

- The F1 test pins five independent observables (the abandoned form's absence after
  the re-add, the re-added line's quantity/unit cost, the name cell, the absence of
  the created item on any line, and the trailing save payload). Without the new
  effect the create row re-renders inside the re-added line's Fragment and the
  release re-points that line.
- The F2 tests use the real gated `itemsCreate` write rather than fake timers, and
  assert both the disabled attribute and the payload; the cancel test covers the
  hung-write escape.
- The `pickInOpenPicker` / `pickForLine` / `pickAppend` split is a pure extraction.

## Findings and disposition

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | P1 | The attempt-matched pending updater (`setLineCreatePending((p) => p?.attempt === attempt ? null : p)`) is unpinned: if it regressed to `null`, a second in-flight create would lose its gate and the F2 bug would return. | **Acted on, reframed.** The two-in-flight path is unreachable: `createItem.isPending` disables both create submits, so only one placement exists at a time. The attempt match is kept as insurance and the *reachability fact* is now pinned by its own test ("lets only one create be in flight, so the save gate holds a single slot"). A test of the unreachable two-gate path would have been a vacuous guard. |
| 2 | P1/P3 | The `submit()` guard is UI-unreachable (a disabled React button never fires `onClick`), so `expect(lastPurchaseInput).toBeNull()` proves only the attribute, and `purchasesLineCreatePending` ships as dead text. | **Acted on.** Confirmed and extended: React suppresses `onClick` for a button whose `disabled` *prop* is set, so even stripping the attribute and dispatching a bubbling click never reaches `submit()`. The guard was removed as dead code; the string is now rendered as a `role="status"` line beside the disabled save, and the block is pinned end-to-end by the payload assertion (reddens under ablation A5, which drops the `disabled` prop). |
| 3 | P2 | The retarget's save release is unpinned: if `openLineCreate` stopped calling `abandonLineCreate`, the existing retarget test would stay green while the invoice stayed blocked behind a form the owner left. | **Acted on.** `expect(saveButton(container)?.disabled).toBe(false)` added to the existing retarget test at the point of the retarget. |
| 4 | P2 | A create that fails while its form is open is untested. | **Acted on.** New test: gate + `itemsCreateFails` → the form reports `errorGeneric`, the draft and the line survive, the save is released, no item was created, and the invoice books the line's original product. |
| 5 | P2 | The effect's other real trigger — the line re-pointed by its own picker while the create is in flight — has no test. | **Deliberately not acted on.** It is the same branch body as the delete case (`lines.some(...)` is false either way) and ablations A1/A2 redden that branch. Adding a second test of one branch buys no new signal. |
| 6 | P3 | `releaseCreate()` used `releaseItemsCreate?.()`, so a test that forgot its gate went green without settling the write. | **Acted on.** It throws when no gate is open. |
| 7 | P3 | The effect's `linePendingTarget` fallback is unreachable, and the comment claiming the draft and the pending stay "pointed at the same line" overstates. | **Acted on (comment).** Reworded: the draft's target is the one that matters, the pending target is a defensive fallback, because every other path that clears the draft clears the pending in the same commit. |
| 8 | P3 | `react-hooks/exhaustive-deps` on the new effect is unverified (no config found, no lint run). | **Verified in-lane.** `bun run lint` (oxlint) → exit 0. No rule fires, so no `useCallback` is needed. |
| 9 | P3 | i18n locale parity for the new key is unverified. | **Verified in-lane.** `i18n.ts` initialises a single locale (`ar`); `src/lib/i18n.test.ts` → 19 pass / 0 fail. |

## Verdict from the lens

> "Sufficient in shape for a Standard-tier fix round (both headline findings are
> genuinely pinned), but not airtight — the newer-create-keeps-its-slot branch and
> the retarget release are unpinned, and F2 #1 may only pin the `disabled`
> attribute rather than the `submit()` guard."

Both caveats are closed above: the retarget release is pinned, the single-slot
reachability is pinned, and the `disabled` attribute is now the deliberate block
rather than an accident of a guard that could never run.

## In-lane re-runs behind this audit

- Red-first: `bun test src/pages/purchase.test.tsx -t "round 2"` → 1 pass / 3 fail
  at `expect(createRow(container)).toBeNull()` (F1) and
  `expect(saveButton(container)?.disabled).toBe(true)` (F2 ×2).
- Green: `bun test src/pages/purchase.test.tsx` → 46 pass / 0 fail.
- Ablations: `.scratch/ablation/run-257-round2.ts` → **5/5 red**, control green.
- Web sweep: 78 files by name → 1302 pass / 0 fail.
