# Issue 196 — code review (Standard tier, test-only)

- Reviewed source SHA: `e2d40c91fae892092f3974c00dc4a8b634ee6b1c`
- Base: `f75721133f25bfe29766266381893520e48d6bb0` (`origin/develop`)
- Diff: `git diff f75721133f25bfe29766266381893520e48d6bb0...e2d40c91fae892092f3974c00dc4a8b634ee6b1c`
- Commits: `test(e2e): extract the quick-add ack/gate helper and apply it to the sibling specs`
- Two axes run as fresh-context parallel reviewer sub-agents; reports kept
  separate, not reranked.

## Standards

Hard violations: **none.** The documented sources (`docs/engineering-workflow.md`,
`AGENTS.md`, `CONTEXT.md`) carry no rule on test naming, duplication, or
parameter shape. The one path obligation touched is met: the design sits at
`.scratch/implementation/196-design.md` as the workflow prescribes, and
`.scratch/implementation/` is not ignored. No baseline smell is a blocker.

Judgement calls (Fowler ch.3):

1. **Duplicated Code** — the repeated call-site option blocks. Nine sale sites
   repeat `error`/`lines`/`itemName`/`quantityLabel` verbatim except `itemName`;
   three purchase sites repeat the `purchase-error`/`purchase-lines` pair. The
   helper already hoisted the ack/gate/refusal logic; the residual is mechanical
   locator data. Re-extraction (e.g. a `form: "sale" | "purchase"` discriminator)
   is defensible but borderline.
2. **Data Clumps** — `itemName` + `lines` + `quantityLabel` always travel
   together to build one locator (`rpc-helpers.ts:63-70`).
3. **Speculative Generality** — `quantityLabel` is invariant across all call
   sites (`"الكمية"`); `Promise<{ id: string }>` is never bound by a caller.
4. **Primitive Obsession** — mild: `quantityLabel: string` is a fixed aria-label
   suffix, not data. The `procedure` union is genuinely variable (the #191
   hazard) and correct.
5. **Mysterious Name** — mild: `options.save` (a `Locator`) sits beside specs'
   `sale-save` testid.

Not present: Feature Envy, Repeated Switches, Shotgun Surgery, Divergent Change,
Message Chains, Middle Man, Refused Bequest.

## Spec

All four brief sub-requirements are implemented: ack armed before the click;
`toBeEnabled()` pre-click gate; the synchronous-refusal guard inside the action;
and the server-id row binding matching `sale.tsx:490` / `purchase.tsx:360`.
`sale-error`/`purchase-error` are conditionally rendered, so `toHaveCount(0)` is
a valid refusal probe. Both create procedures output `itemSchema`
(`packages/contracts/src/app-contract.ts:110-111`), so `created.id` is sound. All
8 brief specs converted; existing assertions preserved; no timeout increases.

- **`itemsCreate` at 4 sites is the only correct reading, not a violation.** The
  brief's "not `itemsCreate`" targets the sale with-stock path. `sale.tsx:355-362`
  routes a positive stock to `itemsCreateWithStock` and blank/0 to `itemsCreate`;
  `purchase.tsx:75` registers only `itemsCreate`. The 4 `itemsCreate` sites are
  items-flow (blank stock) and the three purchase-form sites. All with-stock sale
  sites pass `itemsCreateWithStock`.
- **sale-checkout 4 writes vs the brief's "3" — justified.** The fourth (oversell,
  `sale-quick-stock=1`) is an independent quick-add click that relied on the same
  5 s poll; leaving it would leave the exact anonymous-timeout class #196 targets.
  It required hoisting `const oversellName` above the call — harmless.
- **`completion-screens.spec.ts:32`** still clicks the sale quick-add with
  filled stock. Issue #196 lists it; the brief swapped in `settings` and is
  authoritative, so this is compliant; one sibling remains unconverted and is
  flagged for the parent.
- **Named-failure proof** was required by the brief and, at review time, lived
  only in the working tree; it is now committed at
  `.scratch/reviews/196/e2d40c9-verification.md`.

### Axes summary

- Standards: 0 hard violations, 5 judgement calls (worst: Duplicated Code at the
  call sites).
- Spec: 0 blockers; 1 item-listed sibling (`completion-screens`) intentionally
  out of the brief's eight; the `itemsCreate`/4-vs-3 questions resolved in the
  change's favour.
