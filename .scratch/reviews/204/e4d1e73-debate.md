# #204 — Debate evidence

Head reviewed: `e4d1e73` (fixes landed after the first head `b27c5ec`; this file is the
post-fix review)
Base: `8a7a7fa35de501efee15a802430193003926633d`
Tier: High-assurance (money-entering screen)
Method: one `reviewer` critic + one `reviewer` defender, independent, plus 5 more
reviewers (test-audit + code-review) in the same fan-out.

## Critic — findings and disposition

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| F1 | 7 | `hasRemovedFilled` was a captured render value; a removal landing during `submit`'s async resolve could still post the removed row (the stale-closure class already fixed for `listFailed`). | **Fixed** in `e4d1e73`: `removalBlocksSave()` reads `removedFilledRef` at write time, and the reconciliation effect calls `abandonAttempt()` (bumps the attempt, closes the dialog). Regression test: "never writes a supplier removed during the submit's async name lookup". |
| F2 | 6 | Mid-typing: a partial `1` toward `1500` was reported as "this amount was not saved". | **Fixed** in `e4d1e73`: copy now says "ما كتبته فيه" ("what you wrote in its row"), true for a partial figure. The partial value is still reported — deliberate, since the draft is real state the owner typed. |
| F3 | 5 | a11y: `role="alert"` wrapped the dismiss button; focus dropped when the input unmounts; three live regions could fire at once. | **Partially fixed**: the live region now wraps only the statement, the button is outside. Focus is not stolen (moving focus on a background refresh would be worse than Tab access); the notice is announced. |
| F4 | 5 | "Block until dismiss" right, but not routed through the single blocker channel. | **Accepted as designed**: the block is a named, per-row loss notice, not a generic `blockedReason`; the guard is now one live helper, not a captured flag. |
| F5 | 4 | Removal with the confirmation open left a stale dialog naming a shrunken batch. | **Fixed** in `e4d1e73`: the effect calls `abandonAttempt()`, closing the dialog. Test: "closes the confirmation when a refresh removes a row it named". |
| F6 | 3 | `supplierOpeningRemovedBlocked` near-dead / duplicate copy. | **Kept and pinned**: it is the programmatic-submit path's explanation; a test now asserts it. |
| F7 | 3 | No re-entry affordance. | **Deferred** (non-blocking): the owner can retype in the inline new-supplier row. Documented in the design's deferred list. |
| F8 | 3 | Name is edit-time and non-disambiguating for folded twins. | **Dismissed (defender)**: the name the owner saw is the honest label; a raw id is worse. `name ?? ""` fallback pinned by a pure test. |
| F9 | 3 | Transient/cache-reset empty list could flag every draft. | **Fixed** in `e4d1e73`: `presentSupplierIds` is `null` until the list is loaded, and the effect skips `null`. Test: failed refetch never flags a phantom removal. |
| F10 | 2 | `draftsRef` + layout effect unnecessary. | **Dismissed (defender)**: it keeps `drafts` out of the effect deps so reconciliation never runs per keystroke; ordering is correct. |
| F11 | 2 | Colon placement / flex-wrap bidi. | **Dismissed** as cosmetic. |

## Defender — key defenses (all confirmed)

- D1/D4 the pure seam and the identity snapshot are the only ways to name a vanished
  supplier without mirroring a rule client-side (mirrors #184's `expectedSupplierId`).
- D2 block+dismiss beats flag-only on a silent-loss issue; dismiss keeps it recoverable.
- D3 the block is enforced at three layers (button, confirm button, `save`/`submit`).
- D5/D6 effect keyed on the id set, dedupe by id, draft deletion — no loop, no re-warn.
- D7/D8 i18n keys + `role="alert"`, no literal Arabic; no realistic transient-empty
  false positive.

## Verdict

No blocker remains. The one real hole (F1) and the confirmation-staleness hole (F5)
are fixed with regression tests; the rest are documented, dismissed with reasons, or
deferred as non-blocking UX.
