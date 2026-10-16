# #210 — Arabic-Indic digits for the money readers

Follow-up to #198. #198 widened the quantity readers by sharing
`normalizeArabicIndicDigits` and left the money readers ASCII-only **on purpose**,
pinning the one reachable delta. This ticket widens the money readers too, so the
same digit types wherever a number is typed.

**Tier: High-assurance** (invoice/discount/override money math; a normalisation
bug here changes a billed amount, not a message).

Base: `origin/develop` @ `a52084d`.

## Scope (from the brief)

Widen acceptance to:

1. the sale **override** reader (amount + percentage) — `saleUnitPrice`,
   `saleOverrideInvalid`, and the submit payload in `sale.tsx`;
2. the sale **discount** reader — `nonNegativeOr` / `discountAmountFor`, the
   page's `discountInvalid`, and the submitted `discount.value`;
3. `parseWholePercentage` (initial payment / settle panels);
4. `parseWholeAmount`, which backs supplier-return line quantities and the
   free-standing return quantity.

Plus the one reader that reads the **same draft** as a widened reader and would
otherwise disagree with it: the supplier-return invoice-linked **preview**
(`supplier-return-panel.tsx` sums `Number(quantities[id])` while
`parseReturnQuantities` reads the same map with `parseWholeAmount`). Widening
only the submit path there would preview 0 and submit 5.

## Public API

- `amount-parse.ts`
  - `parseWholeAmount(draft)`: normalise digits before the digits-only test.
  - `parseWholePercentage(draft)`: same.
  - **new** `parseLooseNumber(draft): number` — `Number` after digit
    normalisation. The shared loose read for the override/discount fields, which
    historically used raw `Number` (`"1e3"` → 1000, `"12.5"` → 12.5, `""` → 0).
    Only ASCII→ASCII identity is guaranteed; digits are the only thing that moves.
- `invoice-draft.ts`
  - `nonNegativeOr(value, fallback)`: read through `parseLooseNumber`.
  - `saleOverrideInvalid(line)`: read through `parseLooseNumber`.
- `amount-percentage-input.tsx`
  - `percentageEdited`: the over-100 clamp fallback reads `parseLooseNumber`, so
    `«١٥٠»` clamps to 100 exactly like `"150"` does (otherwise `parseWholePercentage`
    now accepts it but the fallback's raw `Number` sees `NaN`).
- `sale.tsx`
  - `discountInvalid` and the submitted `priceOverride.value` read through
    `parseLooseNumber`, so validate/preview/submit agree.
- `supplier-return-panel.tsx`
  - the invoice-linked preview reads through `parseLooseNumber` (keeps the
    historical loose sum for a fractional draft, but normalises digits).

## Why this cannot move an ASCII money value

`normalizeArabicIndicDigits` only rewrites `U+0660..U+0669` and `U+06F0..U+06F9`
to `0..9`. Every ASCII code point is returned untouched, so:

- `parseWholeAmount` / `parseWholePercentage`: identical characters, identical
  regex, identical `Number` result.
- `parseLooseNumber`: `Number(x)` after a no-op replacement.
- The two page call sites swap `Number(x)` for `parseLooseNumber(x)`, which is
  `Number(x)` for ASCII.

This is pinned, not argued: each reader gets a property test that maps an ASCII
draft to its Arabic-Indic and Extended Arabic-Indic forms and asserts the three
reads are equal, plus the pre-existing ASCII values stay in the existing tests.

## Risks

| Risk | Mitigation |
|---|---|
| A reader is widened for Arabic but a sibling still reads raw `Number`, so preview/submit disagree | Find every reader of the **same draft**; the supplier-return preview is the one hit. Property tests compare reader outputs. |
| The loose `Number` predicate changes for ASCII (e.g. rejecting `1e3` where it was accepted) | Do NOT switch these to a strict reader; normalise then `Number`. Pinned (`parseLooseNumber("1e3") === 1000`). |
| `parseWholeAmount` widening leaks into a caller that is deliberately strict | Its callers are supplier-return quantities and the `amount-percentage-input` re-export; both are number drafts the ticket wants widened. Audit: `rg parseWholeAmount`. |
| Decimal Arabic separator `٫` (U+066B) accidentally normalised | The normaliser maps digits only; `«٥٫٥»` still fails the digits-only test. Pinned. |
| `parseGroupedAmount` double-normalises after `parseWholeAmount` also normalises | Idempotent; the grouped reader still rejects grouping its own regex rejects. Existing grouped pins cover it. |

## Deliberately out of scope (documented, not silent)

The issue's acceptance says "every numeric input", but this lane is scoped by the
brief to the four readers above. Independent readers that still read drafts with
raw `Number`/regex and are **not** touched here (each would be its own change
with its own money review):

- customer-return line quantities in `apps/web/src/pages/invoice.tsx`
  (`returnQuantityError`, the `valueTotal` projection, the submit map);
- the free-standing supplier-return amount and the purchase `unitCost` field;
- `apps/web/src/lib/numeric-input.ts` (`parseWholeNumber` /
  `parseSignedWholeNumber`), used by items/stock/quick-add.

None of them becomes *inconsistent with itself* by this change: they do not read
any draft that a widened reader also reads.

## Tests

Unit (`bun test`):

- `amount-parse.test.ts` — `parseWholeAmount` and `parseWholePercentage` accept
  `٥`/`۵`/`١٠١` etc.; the Arabic/Extended script equals the ASCII read for a
  draft set; ASCII values unchanged; `«٥٫٥»` still null; `parseLooseNumber` pins
  `1e3`/`12.5`/`""`/`abc`.
- `invoice-draft.test.ts` — override amount/percentage Arabic values bill like
  ASCII; `saleOverrideInvalid` accepts valid Arabic and still refuses `١٠١`,
  `١٢.٥`; `discountAmountFor` Arabic amount/percentage equals ASCII;
  `nonNegativeOr` normalises but keeps `1e3`. The pre-existing
  `resolveInitialPaid` "digit asymmetry" pin is replaced: #210 widens
  `parseWholePercentage` too, so the amount/percentage pair now resolves a
  wholly-Arabic draft exactly like its ASCII twin (and still caps at 100).
- `supplier-return-draft.test.ts` — `parseReturnQuantities` accepts `٥` and `۵`,
  rejects `«٥٫٥»`, and equals the ASCII read.
- `amount-percentage-input.test.tsx` — `percentageEdited` clamps `«١٥٠»` to 100
  and links `«٥٠»` to half.
- `sale.test.tsx` (page level) — a sale typed entirely in Arabic-Indic
  (quantity + override + discount) submits the same payload as ASCII, and the
  paid-percentage field links `«٥٠»` to half the total.

Playwright (`tests/e2e/sale-checkout.spec.ts`): one browser-level test typing
Arabic-Indic digits into the quantity, override, and discount fields and asserting
the rendered subtotal/total. Run on a lane-isolated port pair
(`DOKAN_PORT=4417 DOKAN_WEB_PORT=5273`, vault pair likewise): passed, and the
full `test:e2e` suite passed 76/76.

## Test infrastructure (found while running the new page test)

`apps/web/src/tests/select-driver.ts`: Base UI leaves a **closed** popup mounted,
so two selects that share an option label resolve to the stale one — the sale
line-override and invoice-discount selects both offer «مبلغ», and
`findOption("مبلغ")` returned the already-closed override option, so the new page
test saw the discount never select. `findOption(label, trigger?)` now filters to
the listbox the trigger's `aria-controls` names (the one-argument form is
unchanged for existing callers), and `chooseOption` passes its trigger. This is
test-only; it moved no production code.
