# Issue 196 — code review (Standard tier, test-only) — round 2

- Reviewed source SHA: `e85cf6bb36da0758049780135e3da766ad138bf9`
- Base: `f75721133f25bfe29766266381893520e48d6bb0` (`origin/develop`)
- Diff: `git diff f75721133f25bfe29766266381893520e48d6bb0...e85cf6bb36da0758049780135e3da766ad138bf9`
- Commits: `test(e2e): extract the quick-add ack/gate helper and apply it to the sibling specs`; `test(e2e): convert the completion-screens quick-add save to saveQuickAdd`
- Two axes run as fresh-context parallel reviewer sub-agents; reports kept
  separate, not reranked. Round 2 includes the parent-confirmed
  `completion-screens` conversion.

## Standards

Hard violations: **none in the code.** The documented sources
(`docs/engineering-workflow.md`, `AGENTS.md`, `CONTEXT.md`) carry no rule on test
naming, duplication, or parameter shape. The workflow's evidence rule is met by
this round's `<sha>-<gate>.md` files keyed to `e85cf6b` (the round-1 `e2d40c9-*`
files were replaced, not left stale).

Judgement calls (Fowler ch.3):

1. **Duplicated Code** — the new `completion-screens` hunk repeats the same
   8-line options block now present at 10 sale/purchase sites. The helper already
   hoisted the ack/gate/refusal logic; the residual is mechanical locator data.
   Borderline, non-blocking.
2. **Data Clumps** — `itemName` + `lines` + `quantityLabel` always travel
   together to build one locator (`rpc-helpers.ts:60-66`).
3. **Speculative Generality** — `quantityLabel` is invariant (`"الكمية"`) at all
   sites; `Promise<{ id: string }>` is never bound by a caller.
4. **Primitive Obsession / Mysterious Name** — mild: `quantityLabel: string` is a
   fixed aria-label suffix; `options.save` sits beside specs' `sale-save` testid.

Not present: Feature Envy, Repeated Switches, Shotgun Surgery, Divergent Change,
Message Chains, Middle Man, Refused Bequest. The new conversion matches the
established call-site shape exactly and introduces no new smell kind (it
amplifies the existing Duplicated Code, judged borderline).

## Spec

All requirements are met. Verified against the app source:

- **`completion-screens` uses `itemsCreateWithStock`** and is correct: it fills
  `sale-quick-stock` `"3"` and `sale.tsx:355-361` routes a positive stock to
  `createWithStock`. Its existing `toContainText(itemName)` assertion is
  preserved verbatim.
- **The 4 `itemsCreate` sites are the parent-accepted plain/purchase paths**:
  items-flow (blank stock), learnability-purchase, purchase-intake, settings.
  `purchase.tsx:75` registers only `itemsCreate`; `sale.tsx` is the only
  with-stock path. The parent explicitly accepted this reading.
- **No timeout increased**: `playwright.config.ts` untouched (`timeout: 30_000`);
  every "timeout" in the diff is prose in `.scratch/*.md`; the proofs still show
  `Timeout: 5000ms`.
- **No scope creep**: the 14 call sites are the issue's specs (the issue's
  "plus any new spec that saves a quick-add" covers `completion-screens`,
  confirmed by the parent).
- The refusal guard is sound at the one risky site: `use-invoice-draft.ts:204`
  calls `options.setError(null)` synchronously at the top of `submit`, so
  sale-checkout's post-refusal call is not vacuous.
- Only remaining raw quick-add clicks are `receipts.spec.ts:61` (already
  ack-wrapped by #191) and `sale-checkout.spec.ts:56/62/69` (assert their Arabic
  refusal text; no request is sent) — correct by design.

### Axes summary

- Standards: 0 hard violations, 4 judgement calls (worst: Duplicated Code at the
  call sites).
- Spec: 0 missing, 0 scope creep, 0 wrong. `completion-screens` verified correct.
