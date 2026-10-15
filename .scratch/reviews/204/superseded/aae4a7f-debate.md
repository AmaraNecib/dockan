# #204 — Debate evidence

Head reviewed: `aae4a7f` (code identical to `b27c5ec`+`e4d1e73`; the only delta
since `e4d1e73` is the `.agents/wisdom/` lesson, no code. Full findings retained in
`superseded/e4d1e73-debate.md`.)
Base: `8a7a7fa35de501efee15a802430193003926633d`
Tier: High-assurance (money-entering screen)
Method: independent `reviewer` critic + defender, plus five more reviewers
(test-audit + two-axis code-review) in one fan-out.

## Critic — findings and disposition

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| F1 | 7 | `hasRemovedFilled` was a captured render value; a removal landing during `submit`'s async resolve could still post the removed row (the stale-closure class already fixed for `listFailed`). | **Fixed** in `e4d1e73`: `removalBlocksSave()` reads `removedFilledRef` at write time and the reconciliation effect calls `abandonAttempt()`. Regression test: "never writes a supplier removed during the submit's async name lookup". |
| F2 | 6 | Mid-typing: a partial figure was reported as a final lost amount. | **Fixed**: copy says "ما كتبته فيه"; the partial figure is still reported (it is real state the owner typed). |
| F3 | 5 | a11y: `role="alert"` wrapped the dismiss button; focus dropped. | **Fixed** (partially): live region wraps the statement only, button outside; focus not stolen. |
| F4 | 5 | Block not routed through the single blocker channel. | **Accepted as designed**: a named per-row loss notice; the guard is now one live helper. |
| F5 | 4 | Removal with the confirmation open left a stale dialog. | **Fixed**: `abandonAttempt()` closes it; test added. |
| F6 | 3 | `supplierOpeningRemovedBlocked` near-dead. | **Kept and pinned** by a test (programmatic-submit path). |
| F7 | 3 | No re-entry affordance. | **Deferred** (non-blocking), documented. |
| F8 | 3 | Name is edit-time / non-disambiguating for folded twins. | **Dismissed (defender)**: the name the owner saw is the honest label; `name ?? ""` pinned. |
| F9 | 3 | Cache-reset empty list could flag every draft. | **Fixed**: `presentSupplierIds` is `null` until loaded; effect skips `null`; negative test added. |
| F10 | 2 | `draftsRef` unnecessary. | **Dismissed (defender)**: keeps `drafts` out of deps, no per-keystroke run. |
| F11 | 2 | Colon/bidi cosmetic. | **Dismissed**. |

## Defender — key defenses (confirmed)

- The pure seam and identity snapshot are the only way to name a vanished supplier
  without mirroring a rule client-side (mirrors #184's `expectedSupplierId`).
- Block+dismiss beats flag-only on a silent-loss issue; dismiss keeps it recoverable.
- The block is enforced at three layers (button, confirm button, `save`/`submit`).
- Effect keyed on the id set, dedupe by id, draft deletion — no loop, no re-warn.
- i18n keys + `role="alert"`; no realistic transient-empty false positive.

## Verdict

No blocker remains. F1 and F5 fixed with regression tests; the rest documented,
dismissed with reasons, or deferred as non-blocking UX. The durable lesson is
captured in `.agents/wisdom/2026-10-15-live-write-gates-not-captured-render-values.md`.
