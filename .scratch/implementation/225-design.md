# #225 — widen the remaining ASCII-only numeric readers to Arabic-Indic digits

Follow-up to #210 / PR #229. #229 widened the four money readers named in its
brief plus the supplier-return invoice-linked preview; this ticket widens the
reader families it deliberately left behind, so no screen reverts to ASCII when
the owner's keyboard is Arabic.

**Tier: Standard** — a digit-acceptance widening that reuses #229's normaliser;
it moves no money arithmetic, no rounding, and no schema, so the High-assurance
triggers (money-value math, auth, schema bump) do not fire. It touches invoice
quantity/amount *drafts*, not the money math that prices them.

Base (stack): `origin/fix-210-arabic-indic-money` @ `afe15fe` — PR #229's head,
per the brief. Do **not** rebase onto `develop`.

## Reader inventory (enumerated from the code, not the brief)

In scope (the brief's list), all ASCII-only today:

| Reader | Location | Current read |
| --- | --- | --- |
| `nextUnitCost` (purchase line unit cost) | `apps/web/src/lib/invoice-draft.ts` | `Number(value)` + integer/`>=0` |
| `parseWholeNumber` / `parseSignedWholeNumber` | `apps/web/src/lib/numeric-input.ts` | `^\d+$` + `Number` |
| sale quick-add cost / sell | `apps/web/src/pages/sale.tsx` | `Number(fields.cost)` / `Number(fields.sell)` |
| customer-return quantity — validator | `apps/web/src/pages/invoice.tsx` `returnQuantityError` | `^\d+$` + `Number` |
| customer-return quantity — `valueTotal` projection | `apps/web/src/pages/invoice.tsx` | `Number(drafts[id] ?? "")` |
| customer-return quantity — submit payload | `apps/web/src/pages/invoice.tsx` | `Number(drafts[id])` |
| free-standing supplier-return amount | `apps/web/src/components/parties/supplier-return-panel.tsx` | `Number(amount) \|\| 0` |

Readers the brief's list **missed**, found by the enumeration:

| Reader | Location | Current read | Why it is the same class |
| --- | --- | --- | --- |
| `profitPreview` | `apps/web/src/pages/items.tsx` | `Number(costText)` / `Number(sellText)` | the same cost/sell drafts the save path reads with `parseWholeNumber`; an Arabic draft would preview `…` and then save the value |
| purchase quick-add cost / sell / threshold | `apps/web/src/pages/purchase.tsx` | `Number(fields.unitCost)` / `Number(fields.sellPrice)` / `Number(fields.threshold)` | the purchase twin of the sale quick-add listed in the ticket |

Deliberately **out of scope** (not money/quantity readers; recorded, not fixed):

- `apps/web/src/components/ui/pager.tsx`, `apps/web/src/lib/pagination.ts` — page numbers (navigation, ASCII by design).
- `apps/web/src/lib/use-barcode-scanner.ts`, `normalizeBarcode` — barcodes are ASCII by spec.
- `apps/web/src/lib/dates.ts` — date parts; a separate digit concern.
- `apps/web/src/components/parties/party-settle.ts` `invoiceSequence` — the invoice number's trailing ASCII sequence, not an owner draft.
- `apps/web/src/pages/activity.tsx` `Number(debt)` — a value already parsed by the API, not a draft.
- `apps/web/src/lib/vault-client.ts` `Number.parseInt(raw, 10)` — a stored port/token read, not an owner-typed amount.
- the Arabic decimal separator `٫` (U+066B) and Arabic thousands separator `٬` (U+066C) in the *loose* readers: #225 widens the digit *script* only, so `١٢٫٥` stays refused exactly as `12.5` is accepted by `parseLooseNumber`'s `Number` and rejected by the strict readers. Widening separators is a behaviour change the brief did not ask for and was left alone.

## Public API / the one shared reader

No new normaliser. The constraint from the brief is explicit: a second
digits-normaliser is a regression. Every reader above routes through one of
#229's existing helpers in `apps/web/src/lib/amount-parse.ts`:

- **strict** (digits only, `null` on anything else) → `parseWholeAmount`. Used by
  `numeric-input.ts`'s `parseWholeNumber` (and therefore `parseSignedWholeNumber`,
  `resolveOpeningStock`, items, stock) and by the invoice-return quantity reader
  (validator, projection, submit all agree).
- **loose** (`Number` after digit normalisation, ASCII behaviour byte-for-byte) →
  `parseLooseNumber`. Used by `nextUnitCost`, sale/purchase quick-add cost & sell,
  the supplier-return free-standing amount, and `profitPreview`.

`numeric-input.ts` imports `normalizeArabicIndicDigits` from `amount-parse.ts`
(the module #229 put it in) and normalises before its own digits-only test, so
its ASCII control flow is untouched.

### ASCII semantics preserved (per reader)

| Reader | `1e3` | `0x10` | `12.5` | `""` |
| --- | --- | --- | --- | --- |
| `nextUnitCost` | 1000 (accepted) | 16 (accepted) | previous | `0` (explicit zero) |
| `parseWholeNumber` / `parseSignedWholeNumber` | `null` | `null` | `null` | `null` |
| sale quick-add cost/sell | 1000 (accepted) | 16 (accepted) | rejected | `0` |
| invoice-return quantity | `INVALID` | `INVALID` | `INVALID` | untouched (`null`, not part of the return) |
| supplier-return free-standing amount | 1000 (accepted) | 16 (accepted) | rejected | `0` |
| `profitPreview` | 1000 | 16 | 12.5 | `0` |
| purchase quick-add cost/sell/threshold | 1000 (accepted) | 16 (accepted) | rejected (cost) / accepted (threshold, loose) | `0` / `unitCost` fallback |

Loose readers keep `Number()` exactly, so `1e3`/`0x10`/`12.5` keep the meaning
they had. Strict readers keep `^\d+$`, so those forms were and stay `null`.

One behaviour *narrowing*, and it is a fix, not a regression: the
customer-return `valueTotal` projection used `Number(draft)` for a draft the
validator (`^\d+$`) already refuses to submit. It now reads through
`parseWholeAmount`, so projection and submit agree on every draft (the same
split #229 fixed in the supplier-return preview). `1e3` therefore projects as
"not a line" instead of 1000 — but it could never have been submitted before, so
no saved number changes. The agreement is pinned by
`invoice-returns.test.tsx` ("projects only drafts the validator will submit").

## Dependencies

None new. No schema, no contract, no store/router change.

## Planned tests

Unit / page tests, one per widened reader plus an ASCII-identity pin:

- `apps/web/src/lib/numeric-input.test.ts` — `parseWholeNumber` /
  `parseSignedWholeNumber` / `resolveOpeningStock` accept both Arabic scripts and
  keep `1e3`/`0x10`/`12.5`/`""` as before.
- `apps/web/src/lib/invoice-draft.test.ts` — `nextUnitCost` Arabic digits equal
  their ASCII twin, and the existing loose-ASCII pins stay green.
- `apps/web/src/pages/sale.test.tsx` — quick-add cost/sell typed in Arabic produce
  the same create payload as ASCII.
- `apps/web/src/pages/purchase.test.tsx` — quick-add cost/sell/threshold typed in
  Arabic produce the same create payload as ASCII.
- `apps/web/src/pages/invoice-returns.test.tsx` — `returnQuantityError` accepts
  Arabic digits; the ReturnsPanel previews and submits an Arabic-Indic quantity
  as the same number.
- `apps/web/src/components/parties/supplier-return-panel.test.tsx` — the
  free-standing amount accepts Arabic digits and submits the same number.
- `apps/web/src/pages/items.test.tsx` — the profit preview shows the same figure
  for an Arabic and an ASCII cost/sell draft.

Each page test that translates a draft uses the shared, hand-written scripts in
`apps/web/src/tests/arabic-digits.ts` (never the production normaliser, which
would make the pin tautological). One mutation was run to prove a pin is
discriminating: reverting `nextUnitCost` to `Number(value)` fails
`nextUnitCost ... reads both Arabic-Indic scripts exactly like ASCII (#225)`
(expected 900, received 1200), and the revert was restored before commit.

Playwright: `bun run test:e2e tests/e2e/sale-checkout.spec.ts` (a single spec
needs no lane slot) — 4 passed on ports 4357/5197.

## Implementation risks

- A loose reader silently tightening (`parseGroupedAmount` would reject `1e3`);
  the plan deliberately uses `parseLooseNumber` where the old reader was `Number`.
- Projection/submit disagreement on the return quantity: pinned by routing all
  three sites through `parseWholeAmount`.
- `parseSignedWholeNumber` keeps the ASCII `-` prefix; a localised minus sign is
  not in scope (the brief scopes *digits*).

## Left for other tickets

- #227 — bidi marks in these drafts (untouched).
- A follow-up if desired: unify the sale/purchase quick-add cost/sell readers
  with the strict items form reader (an ASCII-only inconsistency that predates
  #225 and is not a digit-script issue).
