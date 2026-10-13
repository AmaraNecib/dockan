# #146 — One invoice-draft module behind the sale and purchase screens

- **Tier:** Standard (web UI). Guard 1 + 2 in full; `debate` run at the lane's request
  because the extraction's *depth* is itself the risk.
- **Base:** `origin/develop` @ `fc951133134a9b0b18b5ae38f9658665c29e73ec`
- **Source:** architecture review candidate 3
  (`.scratch/explanations/architecture-candidates-explained-ar.html` — «وحدة مسودّة الفاتورة»).
- **Constraint from the issue:** visual output and Arabic copy stay identical. This is a
  behaviour-preserving extraction plus the quantity-drift fix, **not** a redesign.

## 1. Problem, restated precisely

`sale.tsx` and `purchase.tsx` each own the same draft mechanics. The drift is real:

| | sale | purchase (before) |
|---|---|---|
| quantity field | `quantityDraft: string`, resolved by `parseQuantityDraft` | `quantity: number`, written by `Number(event.target.value)` |
| empty field while typing | stays empty, line resolves to 0 | **silently keeps the previous value** |
| garbage / fractional | stays visible, line resolves to 0 | silently keeps the previous value |
| oversize (> 1,000,000) | resolves to 0 (refused before the RPC cap) | silently keeps the previous value |
| `0` | line resolves to 0, submit refuses | silently keeps the previous value |

`purchase`'s silent-keep is the bug: the operator sees the cursor move but the number
does not change, and a stale quantity can be saved as if it were typed. There is no
owner-visible case where silent-keep is *correct* — a stale quantity is never what the
operator meant. The issue's open decision 2 recommends adopting the sale parser; this
design adopts it and states the rule:

> **Adopted rule (shared, both kinds).** A quantity field is a *draft*: empty, fractional,
> zero, negative, or above `MAX_DRAFT_QUANTITY` (1,000,000) resolves to `0`; the field is
> never rewritten, so a cleared field stays cleared. Submit refuses a line whose draft
> resolves below 1. Only an explicit add/scan action repairs a cleared draft, by bumping
> it to one unit.

`MAX_DRAFT_QUANTITY` mirrors `invoiceLineInputSchema.quantity` (`.int().positive().max(1_000_000)`),
so an oversized draft is refused client-side instead of surfacing an opaque server error.

## 2. One genuine difference kept as intent (not silently unified)

`purchase` has **no** per-line price override, **no** invoice discount, and **no** debt
notice. That is not drift:

- a purchase line prices the *stock cost basis* (`unitPrice` defaults to the item's
  `costPrice`); the owner negotiates cost per unit, so a sale-style "discount" on the
  invoice has no meaning there;
- `invoiceCreateInputSchema` rejects a price override on `kind: "PURCHASE"` outright
  («price override is sale-only»).

The extraction therefore shares the **math** (`discountAmountFor`, `draftTotals`) and lets
purchase pass «no discount», but does not add discount/override UI to purchase. Copy,
columns, and checkout-bar composition stay per-kind.

`purchase`'s **unit-cost** field is also *not* a quantity draft. It is a controlled money
field whose reachable contract is: cleared → `0` (today `Number("") === 0` sets it to 0),
digits → that whole number, unreadable → keep the previous value. Turning it into a draft
would transiently bill the line at `0` while the owner is mid-edit, which the brief's
"preserve the money math exactly" forbids. The rule still moves into the module
(`nextUnitCost`), so the page no longer writes `Number(event.target.value)`.

## 3. The seam

Two modules, one seam each. Pure rules in the lib, React plumbing in the hook.

### 3.1 `apps/web/src/lib/invoice-draft.ts` — pure, framework-free

```ts
export type DraftKind = "SALE" | "PURCHASE";
export type AmountKind = "" | "AMOUNT" | "PERCENTAGE"; // discount + override share a shape

/** One draft line: the item plus the raw quantity text the owner is typing. */
export interface DraftLine { item: Item; quantityDraft: string; }

export const MAX_DRAFT_QUANTITY = 1_000_000;

// quantity draft (the one parser both screens use)
parseQuantityDraft(draft): number            // "" | non-integer | 0 | >cap → 0
quantityDraftInvalid(draft): boolean
lineQuantity(line): number

// purchase line unit cost: a controlled money field, not a draft
nextUnitCost(value, previous): number        // "" → 0; digits → n; else previous

// per-kind line price (the only pricing rule that varies)
saleUnitPrice(line): number                  // item.sellingPrice + override
saleOverrideInvalid(line): boolean           // moved out of sale.tsx verbatim

// line-list operations — the add/merge/remove rules
addDraftLine(lines, line): T[]               // repeat item bumps by 1, repairs a cleared draft
setDraftQuantity(lines, itemId, draft): T[]
patchDraftLine(lines, itemId, patch): T[]
removeDraftLine(lines, itemId): T[]

// totals
draftSubtotal(lines, unitPriceFor): number
discountAmountFor(subtotal, type, draft): number
draftTotals(lines, unitPriceFor, type, draft): { subtotal, discountAmount, total }
toAmountKind(value): AmountKind

// initial-payment pair (#162) — byte-identical in both screens before this change
type PaymentSource = "amount" | "percentage" | null;
interface PaymentPair { amount: string; percentage: string; source: PaymentSource }
EMPTY_PAYMENT_PAIR
nextPaymentPair(total, current): PaymentPair  // the shared effect, as a pure transition
resolveInitialPaid(total, pair): { ok: true; paid: number | undefined } | { ok: false }
```

Money stays in whole DZD integers, unchanged: subtotal is the sum of
`lineQuantity × unitPrice`; a percentage discount rounds like before
(`Math.round(subtotal × p / 100)`, capped at the subtotal); `total = subtotal − discount`.

### 3.2 `apps/web/src/lib/use-invoice-draft.ts` — React plumbing

```ts
/** Per-kind config: the fresh line and the unit-price rule. Stable module scope. */
export interface InvoiceDraftConfig<T extends DraftLine> {
  emptyLine(item: Item): T;
  unitPrice(line: T): number;
}

/** The line list behind both screens. Wraps the pure reducer above. */
useInvoiceDraft<T extends DraftLine>(config): {
  lines: T[];
  addItem(item): void;            // add/merge via addDraftLine
  setQuantity(itemId, draft): void;
  patch(itemId, patch): void;
  remove(itemId): void;
  reset(): void;
  subtotal: number;
}

/** The #162 amount ⇄ percentage pair, shared verbatim. */
usePaymentPair(total): { amount, percentage, source, onChange, reset };

/** The quick-add form's state and submission. */
useQuickAdd<F extends Record<string, string>>(spec, onCreated): {
  open; fields: F; error; pending;
  setField(key, value); setError; openForm(seed?); close; toggle; reset;
  submit(create: (fields: F) => Promise<QuickAddOutcome>): Promise<void>;
}
```

`draftReducer(lines, action)` is exported pure (`add | quantity | patch | remove | reset`)
so the line-list rules are unit-tested without React.

## 4. What stays in the pages (thin adapters)

- **sale.tsx**: customer picker, per-line override column, discount controls, debt
  notice (`saleDebt` + `submittedNotice` freeze), scan/barcode handling, commit freeze
  (`commitRef`), checkout bar JSX, quick-add **fields** (cost/sell/stock + the scan's
  required-stock variant and focus).
- **purchase.tsx**: supplier picker, notes, initial payment, `LinkProposalPanel`,
  checkout bar JSX, quick-add **fields** (sell/threshold/qty/cost).

### Why the quick-add stays a per-kind *markup* surface

The issue's open decision 3 recommends sharing the quick-add item form. Sharing the
**state machine and submission** is done (above). Sharing the *markup* was rejected on the
codebase-design depth test: the two forms differ in fields, labels, defaults, required
flags, test ids, buttons, and layout (sale has a submit+close row; purchase has one
submit). A single config-driven form would need a descriptor list as long as the forms it
replaces — a shallow module whose interface is as complex as the duplication it removes.
The *rules* are what is shared; the fields are per-kind by intent. That is the one place
this design deliberately reads "the module owns the quick-add item form" as
"owns its behaviour, not its markup", and it is called out here so the debate can attack it.

## 5. Dependencies

- `@dokan/contracts` (`Item`), `@/lib/amount-parse` (`parseGroupedAmount`,
  `parseWholePercentage`), `@/lib/numeric-input` (`parseWholeNumber`),
  `@/components/ui/amount-percentage-input` (`amountFromPercentage`, `percentageFromAmount`,
  `percentageDraftInvalid`). No new dependency; no server, contract, or schema change.

## 6. Planned tests

**New — `apps/web/src/lib/invoice-draft.test.ts` (pure):**
- quantity parse table: `""`, `"   "`, `"0"`, `"-3"`, `"2.5"`, `"abc"`, `"12x"`, `"0042"`,
  `"1e3"`, `"٥"`, `"1000000"`, `"1000001"`, safe-integer overflow.
- `nextUnitCost`: `""`→0, digits, garbage→previous, negative→previous.
- line list: add new, add repeat merges +1 and repairs a cleared draft, set quantity,
  patch, remove, remove-last, unknown item id is a no-op.
- `draftReducer` covers each action (the recommended test surface).
- totals: pinned subtotal for both kinds' line shapes; discount amount + percentage
  (incl. rounding and the cap); `total = subtotal − discount`.
- `saleUnitPrice` / `saleOverrideInvalid` moved tables.
- `nextPaymentPair` / `resolveInitialPaid`: the six transitions + over-total + invalid percent.

**Changed — `apps/web/src/pages/sale.test.tsx`:** imports the moved helpers from the lib;
`saleDebt` tests stay; all rendered tests stay green.

**Changed — `apps/web/src/pages/purchase.test.tsx`:** the drift proof —
*types an invalid quantity into purchase and asserts the same behaviour sale has*:
1. clearing the quantity field leaves it empty (no snap-back to the stale value);
2. the line's total drops to 0 and the invoice total follows;
3. submit is refused with `purchasesInvalidQuantity` and nothing is sent;
4. typing a fresh value after the cleared draft works;
5. `"abc"` / `"2.5"` also stay visible and resolve to 0.
Plus a pinned-totals test: `battery ×2 @1200 + filter ×3 @900 = 5100` through the
shared path, and `purchase` still sends `unitPrice` per line.

**E2E:** `tests/e2e/sale-checkout.spec.ts` and `tests/e2e/purchase-intake.spec.ts` stay
green unchanged (they already pin scan→lines→totals→save for both screens). A new
assertion is added to `purchase-intake.spec.ts`: clearing the quantity field keeps it
empty and the save is refused — the browser-level proof of the drift fix.

## 7. Money-math pinning (the brief's "prove it")

Before/after the extraction the totals must be byte-identical. The pins:

| case | pinned value |
|---|---|
| sale: 1 × 1000, default price | subtotal 1000, total 1000 |
| sale: 3 × 900 (amount override) − amount discount 100 | subtotal 2700, total 2600 |
| sale: 1 × 500 @ 80% override, − 10% discount | subtotal 400, total 360 |
| sale: percentage discount rounding `subtotal 333, 10%` | discount 33, total 300 |
| purchase: 2 × 1200 + 3 × 900, no discount | subtotal 5100, total 5100 |
| purchase: cleared quantity draft | line 0, subtotal unchanged minus that line |
| both: initialPaid `0` → `undefined`; partial → that number; over total → invalid |

## 8. Risks

| risk | mitigation |
|---|---|
| The payment-pair extraction changes a money path | `nextPaymentPair` is a pure transition proven equivalent to the old effect; the existing `#162`/`#171` rendered tests in both pages stay green unchanged |
| Making purchase's quantity a draft changes the reachable UI | the drift fix is exactly the goal; the silent-keep behaviour is impossible to assert as *correct*, and E2E proves the new behaviour |
| The quick-add plumbing moves state without removing duplication | the hook owns open/close, the field bag, category defaulting, the create-then-land flow, and error routing; the page keeps only fields + payload (`build`) — the debate critic is asked to attack exactly this |
| `sale.test.tsx` imports moved helpers | helpers are re-exported from the lib and the test's import site is updated; no test is deleted |
| Visual/copy drift while re-plumbing | no JSX copy, label, class, or test id changes; the rendered page tests and E2E specs are the guard |
