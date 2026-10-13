# #146, one invoice-draft module behind the sale and purchase screens

- **Tier:** Standard (web UI). Guard 1 + 2 in full. `debate` was run at the lane's
  request because the depth of the extraction is itself the risk.
- **Base:** `origin/develop` @ `fc951133134a9b0b18b5ae38f9658665c29e73ec`
- **Source:** architecture review candidate 3
  (`.scratch/explanations/architecture-candidates-explained-ar.html`, «وحدة مسودّة الفاتورة»).
- **Constraint from the issue:** the visual output and the Arabic copy stay
  identical. This is a behaviour-preserving extraction plus the quantity drift
  fix, not a redesign.

## 1. Problem, restated precisely

`sale.tsx` and `purchase.tsx` each owned the same draft mechanics. The drift was real:

| | sale | purchase (before) |
|---|---|---|
| quantity field | `quantityDraft: string`, resolved by `parseQuantityDraft` | `quantity: number`, written by `Number(event.target.value)` |
| empty field while typing | stays empty, line resolves to 0 | silently keeps the previous value |
| garbage or fractional | stays visible, line resolves to 0 | silently keeps the previous value |
| oversize (> 1,000,000) | resolves to 0, refused before the RPC cap | silently keeps the previous value |
| `0` | line resolves to 0, submit refuses | silently keeps the previous value |

The purchase silent-keep is the bug. The operator sees the cursor move but the
number does not change, and a stale quantity can be saved as if it were typed.
There is no owner-visible case where silent-keep is *correct*, because a stale
quantity is never what the operator meant. The issue's open decision 2
recommends adopting the sale parser, and this design adopts it:

> **Adopted rule (shared, both kinds).** A quantity field is a *draft*: empty,
> fractional, zero, negative, or above `MAX_DRAFT_QUANTITY` (1,000,000) resolves
> to `0`; the field is never rewritten, so a cleared field stays cleared. Submit
> refuses a line whose draft resolves below 1. Only an explicit add or scan
> action repairs a cleared draft, by bumping it to one unit, and that bump clamps
> at the cap so a line already at 1,000,000 stays billable.

`MAX_DRAFT_QUANTITY` mirrors `invoiceLineInputSchema.quantity`
(`.int().positive().max(1_000_000)`), so an oversized draft is refused
client-side instead of surfacing an opaque server error.

## 2. Genuine differences kept as intent

`purchase` has no per-line price override, no invoice discount and no debt
notice. That is intent, not drift:

- a purchase line prices the stock cost basis (`unitPrice` defaults to the item's
  `costPrice`), and the owner negotiates cost per unit, so a sale-style
  "discount" on the invoice has no meaning there;
- `invoiceCreateInputSchema` rejects a price override on `kind: "PURCHASE"`
  outright («price override is sale-only»).

The extraction therefore shares the math (`draftTotals`) and lets purchase pass
«no discount», but does not add discount or override UI to purchase.

`purchase`'s **unit-cost** field is also not a quantity draft. It is a controlled
money field whose reachable contract was, and still is: cleared reads as `0`
(`Number("") === 0`), a whole non-negative number reads as that number, anything
else keeps the previous value. Turning it into a draft would transiently bill the
line at `0` while the owner is mid-edit, which the brief's "preserve the money
math exactly" forbids. The rule moved into `nextUnitCost` so the page holds no
`Number(event.target.value)`, and it deliberately keeps the old reader, including
its generous spellings (`"1e3"` reads 1000, `"0x10"` reads 16). Tightening that
reader is a separate change and is logged as a follow-up, not smuggled into a
refactor.

## 3. The seam

Two modules, one seam each. Pure rules in the lib, React plumbing in the hook.

### 3.1 `apps/web/src/lib/invoice-draft.ts` (pure, framework-free)

```ts
export type AmountKind = "" | "AMOUNT" | "PERCENTAGE"; // discount and override share one shape

/** One draft line: the item plus the raw quantity text the owner is typing. */
export interface DraftLine { item: Item; quantityDraft: string; }
export interface SaleDraftLine extends DraftLine { overrideType: AmountKind; overrideValue: string; }
export interface PurchaseDraftLine extends DraftLine { unitCost: number; }

export const MAX_DRAFT_QUANTITY = 1_000_000;

// the one quantity parser both screens use
parseQuantityDraft(draft): number
quantityDraftInvalid(draft): boolean
lineQuantity(line): number
firstUnusableQuantity(lines): T | undefined

// purchase line unit cost: a controlled money field, not a draft
nextUnitCost(value, previous): number

// per-kind line price
saleUnitPrice(line): number          // item.sellingPrice plus override
saleOverrideInvalid(line): boolean   // moved out of sale.tsx verbatim
purchaseUnitPrice(line): number

// line-list rules
addDraftLine(lines, line): T[]       // repeat item bumps by 1, repairs a cleared draft, clamps at the cap
setDraftQuantity(lines, itemId, draft): T[]
patchDraftLine(lines, itemId, patch): T[]
removeDraftLine(lines, itemId): T[]
draftReducer(lines, action): T[]     // add | quantity | patch | remove | reset

// totals, one path for both screens
draftSubtotal(lines, unitPriceFor): number
discountAmountFor(subtotal, type, draft): number
draftTotals(lines, unitPriceFor, type, draft): { subtotal, discountAmount, total }
toAmountKind(value): AmountKind

// the initial-payment pair (#162), byte-identical in both screens before this change
nextPaymentPair(total, current): PaymentPair
resolveInitialPaid(total, amountDraft, percentageDraft): { ok: true; paid: number | undefined } | { ok: false }
```

Money stays in whole DZD integers: subtotal is the sum of
`lineQuantity × unitPrice`; a percentage discount rounds like before
(`Math.round(subtotal × p / 100)`, capped at the subtotal); `total = subtotal −
discountAmount`.

### 3.2 `apps/web/src/lib/use-invoice-draft.ts` (React plumbing)

```ts
/** Per-kind config: the fresh line and the unit-price rule. Stable module scope. */
export interface InvoiceDraftConfig<T extends DraftLine> {
  emptyLine(item: Item): T;
  unitPrice(line: T): number;
}

/** The line list behind both screens. Wraps the pure reducer above. */
useInvoiceDraft(config): {
  lines: T[];
  addItem(item, extras?): void;
  setQuantity(itemId, draft): void;
  patch(itemId, patch): void;   // kind-specific fields (override, unit cost)
  remove(itemId): void;
  reset(): void;
  subtotal: number;
}

/** The #162 amount and percentage pair, shared verbatim. */
usePaymentPair(total): { amount, percentage, source, onChange, reset };

/** The quick-add form's state and submission. */
useQuickAdd(spec, options): {
  open; fields; setField(key, value); openForm(seed?); close; toggle;
  submit(create: (fields) => Promise<QuickAddOutcome>): Promise<void>;
}
```

`draftReducer` is exported pure, so the line-list rules are unit-tested without
React. `useInvoiceDraft` is a thin adapter at the seam: the deep module is the
pure one, and the reducer stays the single test surface for the rules.

## 4. What stays in the pages

- **sale.tsx**: customer picker, per-line override column, discount controls,
  debt notice (`saleDebt` plus the `submittedNotice` freeze), scan handling,
  commit freeze (`commitRef`), checkout-bar JSX, and the quick-add field list.
- **purchase.tsx**: supplier picker, notes, initial payment, `LinkProposalPanel`,
  checkout-bar JSX, and the quick-add field list.

Both pages delegate the line list, the quantity rule, the totals and the
initial-payment pair to the module.

### 4.1 The quick-add markup stays per-kind (a decision to confirm)

The issue's open decision 3 recommended sharing the quick-add item form.
Behaviour is shared (`useQuickAdd` owns open and close, the field bag, the
category and seed plumbing, the create-then-land-the-line flow, and error
routing). The **markup** is not, because the two forms differ in ways that a
config would have to restate field by field:

| | sale | purchase |
|---|---|---|
| fields | name, barcode, category, cost, sell, stock (6) | name, barcode, category, sell, threshold, qty, unit cost (7) |
| category | defaults to the first category, no empty option | requires an explicit pick, has a «—» option |
| stock | optional on the plain path, required on the scan path, takes focus | absent |
| qty | absent | required, seeds `"1"`, becomes the line quantity |
| reset | resets on every open (a scan seeds the barcode) | keeps what is typed across a close |
| buttons | submit plus close | submit only |
| test ids, labels, layout | sale-quick-* | quick-*, purchase-* |

A descriptor list carrying all of that would be as long as the forms it replaced,
which is the definition of a shallow module. So the module owns the quick-add's
rules and the pages own its fields. This narrows the issue's wording, and it is
reported as a `decisionRequest` rather than treated as settled.

## 5. Dependencies

`@dokan/contracts` (`Item`) and `@/lib/amount-parse` (`parseGroupedAmount`,
`parseWholePercentage`, `percentageDraftInvalid`, `amountFromPercentage`,
`percentageFromAmount`). The last three moved from
`@/components/ui/amount-percentage-input` into `@/lib/amount-parse` so the pure
module does not import a React component; the component re-exports them, so every
existing import site is unchanged. No new dependency, and no server, contract or
schema change.

## 6. Tests

**New, `apps/web/src/lib/invoice-draft.test.ts` (pure):**
- the quantity parse table: `""`, `"   "`, `"0"`, `"-3"`, `"2.5"`, `"abc"`,
  `"12x"`, `"0042"`, `"1e3"`, `"٥"`, `"1000000"`, `"1000001"`, overflow.
- `nextUnitCost`: cleared reads 0, digits read their value, unreadable keeps the
  previous value, and the pre-#146 generous spellings are pinned.
- line list: add new, add repeat merges and repairs a cleared draft, the cap
  clamp, set quantity, patch, remove, `firstUnusableQuantity` order.
- `draftReducer`, one case per action.
- totals: subtotals for both kinds, the discount cap and rounding, `total =
  subtotal − discountAmount`.
- `saleUnitPrice`, `saleOverrideInvalid` and the percentage boundaries.
- `nextPaymentPair` and `resolveInitialPaid`: the transitions, the over-total
  refusal, the invalid percentage, and the malformed grouping.

**Changed, `apps/web/src/pages/sale.test.tsx`:** the moved parser tables now live
in the lib test; `saleDebt` stays. New rendered tests pin the cleared-draft rule
and one discounted cart total, so "purchase behaves like sale" has a sale-side
anchor.

**Changed, `apps/web/src/pages/purchase.test.tsx`:** the drift proof. A test
clears the quantity field and asserts it stays empty, the line resolves to zero,
the save is refused with `purchasesInvalidQuantity`, and nothing is sent. A loop
asserts `"abc"`, `"2.5"`, `"-3"` and `"0"` stay visible and resolve to zero. A
unit-cost test pins the money contract of that field, and an over-cap quick-add
quantity is refused instead of landing a dead line.

**E2E:** `tests/e2e/sale-checkout.spec.ts` and `tests/e2e/purchase-intake.spec.ts`
stay green. `purchase-intake.spec.ts` gains the browser-level drift proof:
clearing the quantity keeps it empty, the save is refused by name, and the total
is intact after a fresh value.

## 7. Money math pins

| case | pinned value |
|---|---|
| sale: 1 × 1000, default price | subtotal 1000, total 1000 |
| sale: 3 × 900 (amount override) − amount discount 100 | subtotal 2700, total 2600 |
| sale: 1 × 500 at 80% override − 10% discount | subtotal 400, total 360 |
| sale: percentage discount on subtotal 333 | discount 33, total 300 |
| sale: 100% discount | total 0, never negative |
| purchase: 2 × 1200 + 3 × 900, no discount | subtotal 5100, total 5100 |
| purchase: cleared quantity draft | line 0, the other lines unchanged |
| both: `initialPaid` | 0 reads as `undefined`, partial reads as that number, over total is refused |

## 8. Review outcomes and follow-ups

- `nextUnitCost` keeps the old `Number` reader on purpose, so no reachable money
  input changes the billed number. A strict reader for this field is a
  **follow-up**, not part of this lane.
- The quick-add markup split is a **`decisionRequest`** (see 4.1).
- **Deferred, pre-existing:** an amount-typed initial payment is not cleared when
  a discount zeroes the total, so the amount-source case can be refused by the
  over-total check until the operator clears it. The percentage-source case is
  handled. This behaviour is unchanged by the extraction and needs its own
  decision about what the operator meant when the reference disappears.
- **Deferred, pre-existing:** purchase's line quantity and unit-cost inputs are
  not disabled while a save is in flight, unlike sale's. Parity change, out of
  scope here.
- **Deferred, test hygiene:** `purchase.test.tsx` declares its input-driving
  helper in several describes. Hoisting one file-level helper is a test-only
  cleanup for another lane.

## 9. Risks

| risk | mitigation |
|---|---|
| The payment-pair extraction changes a money path | `nextPaymentPair` is a pure transition proven equivalent to the old effect; the `#162` and `#171` rendered tests in both pages stay green unchanged |
| Making purchase's quantity a draft changes the reachable UI | that change is the point of the ticket; the browser-level test proves the new behaviour |
| The quick-add plumbing moves state without removing duplication | the hook owns open and close, the field bag, the seed, the create-then-land flow and error routing; the pages keep only fields and payload. The debate critic was asked to attack exactly this |
| Visual or copy drift while re-plumbing | no label, class or test id changed; the rendered page tests and the E2E specs are the guard |
