# Issue 196 — code review (Standard tier, test-only) — round 2, final

- Reviewed source SHA: `8e67761` (full: see `git rev-parse HEAD`)
- Base: `f75721133f25bfe29766266381893520e48d6bb0` (`origin/develop` merge-base)
- Diff: `git diff f75721133f25bfe29766266381893520e48d6bb0...8e67761` (462 lines, 15 files)
- Commits: `e2d40c9` extract helper + 8 specs; `e85cf6b` completion-screens;
  `8e67761` receipts (this round)
- Two axes run as fresh-context parallel `reviewer` sub-agents against the saved
  diff (`.scratch/reviews/196/8e67761-diff.patch`) and the app sources; reports
  kept separate, not reranked.

## Standards

Hard violations: **none.** AGENTS.md governs search scope only; the workflow
docs govern lifecycle/tiers/evidence. The workflow's evidence rule is met by
this round's `8e67761-*.md` files (the `e85cf6b-*` files are replaced, not left
stale — the reviewer flagged exactly this, and it is now done).

Judgement calls (Fowler ch.3; repo standard overrides, all non-blocking):

1. **Data Clumps** — `QuickAddSave.save`/`.error`/`.lines` always travel
   together and are always sliced from one form subtree. A single form root
   would remove the trio. Deliberate: explicit locators keep the generic helper
   free of page-testid coupling.
2. **Speculative Generality / Primitive Obsession** — `quantityLabel` is
   `"الكمية"` at all 15 sites; the parameter hypothesises a variant that does
   not exist.
3. **Duplicated Code** — (a) the helper's id-key assertion is re-asserted by the
   specs' kept `toContainText(itemName)`; (b) the save-button chain repeats
   verbatim at every site; (c) routing rationale is restated in four comments.
   The sweep extracted the *ack*, not the locator.
4. **Mysterious Name** — `saveQuickAdd` names the click, not what it proves
   (server ack + server-issued id); only receipts consumes the return.
5. **Divergent Change** — `sale-checkout.spec.ts` now holds both idioms:
   converted success sites (`:75/:120/:170/:198`) and raw refusal clicks
   (`:56/:62/:69`). Intentional: refusals send nothing, so no ack may be armed.

Not present: Feature Envy, Repeated Switches, Shotgun Surgery, Message Chains,
Middle Man, Refused Bequest.

## Spec

All requirements met, verified against the app source:

- **Routing correct.** `sale.tsx:330-364` routes `stock.value > 0` to
  `createWithStock`, else `createItem`; `purchase.tsx:157-180` only ever calls
  `itemsCreate`. So items-flow/settings and the three purchase sites correctly
  pass `itemsCreate`.
- **Keyed assertion matches the DOM.** `sale.tsx:490` and `purchase.tsx:360`
  render `name={`quantity-${line.item.id}`}` with `aria-label`
  `` `${line.item.name}: ${t(...)}` ``; both `saleQuantity` and `purchasesLineQty`
  are `"الكمية"` (`i18n.ts:356,390`), so the helper's `quantityLabel` works on
  both tables.
- **Refusal guard is real.** `sale-error` (`sale.tsx:438,513`) and
  `purchase-error` (`purchase.tsx:261,395`) exist.
- **No timeout increased.** `playwright.config.ts` untouched, still
  `timeout: 30_000`.
- **No scope creep.** The only behaviour added at the new sites is
  `toBeEnabled()` + the keyed `name` assertion, both required by the design
  contract.
- **Receipts folded in as decided.** `8e67761` routes the last inline #191 block
  through `saveQuickAdd` and preserves the server-issued `invoiceNumber` regex
  and the `sale-saved-number` check.

### Parent verification of the Spec reviewer's open notes

The Spec reviewer left three "cheap check for parent" items; all resolved:

1. `receipts.spec.ts` unused import — **not unused**: `actAndAck`/`rpcOutput`
   are consumed by the `invoicesCreate` ack at `receipts.spec.ts:82-83`.
2. Oversell `itemName` literal — **matches**: the name fill is
   `` `بيع-تجاوز-${stamp}` `` and `oversellName` is the same literal.
3. Oversell `toContainText(itemName)` — **never existed** at that site
   (pre-diff code clicks then reads `oversellQty`); nothing was dropped. The
   helper adds the stronger id-keyed assertion.

### Axes summary

- Standards: 0 hard violations; 5 judgement calls (worst: Duplicated Code).
- Spec: 0 missing, 0 scope creep, 0 wrong; the three open notes were checked and
  closed by the parent.
