# #121 — invoice print: settled A4 layout

Tier: **Standard**. Base: `origin/develop` @ `a0b9671` (#119 merged).

## Goal

Adopt the settled A4 invoice sheet (`.scratch/explanations/invoice-print-prototypes-v2.html`,
proof `.scratch/explanations/invoice-model1.pdf`) in the app, and make
`window.print()` produce paper without the browser's URL/date header.

## Interfaces

`apps/web/src/lib/receipt.ts`

```ts
interface Receipt {
  storeName: string;
  storePhone: string | null;
  storeAddress: string | null;   // NEW — the sheet's left header block
  invoiceNumber: string;
  kind: "SALE" | "PURCHASE";
  // business date + recording time, composed by buildReceipt: the date is the
  // invoice's own day, the clock time comes from createdAt
  invoiceDateTime: string;
  counterpartyName: string | null;
  lines: ReceiptLine[];
  subtotalAmount: number;
  discountAmount: number;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  payments: ReceiptPayment[];
}

interface ReceiptPage {
  number: number;              // 1-based sheet number
  lines: ReceiptLine[];
  carryIn: number;             // running net total before this sheet
  carryOut: number | null;     // running net total after this sheet; null when closing
  closes: boolean;             // prints the totals block and starts the payment history
  payments: ReceiptPayment[];  // closing sheet + overflow sheets
}

function paginateReceipt(receipt: Receipt): ReceiptPage[]
```

`apps/web/src/lib/print-format.ts` (new, pure)

```ts
formatPrintAmount(1234567) === "1,234,567"
```

Dates come from the shared `lib/dates.ts` formatter (#119): `formatDateTime`
for the date-and-time meta and for payment timestamps; the return voucher uses
`formatDate` for its date-only invoice field. The meta value is
`combineBusinessDateTime(invoiceDate, createdAt)` (new helper in dates.ts): the
business date stays authoritative for the day — a backdated invoice keeps its
own date — and the recording moment only supplies the clock time. The app
invoice detail screen shows the same composition, so print and app agree. The
print layer adds no date logic of its own.

`apps/web/src/lib/print-pagination.ts` (new, pure) — the shared weighted
paginator: `paginateLineSlices(costs, caps)` returns one slice per sheet, with
the smallest sheet count the weights actually fit into and no sheet over its
budget; `textRowUnits` weights a wrapping cell.

`apps/web/src/components/print-sheet.tsx` (new) — the shared A4 frame:
store name + contacts + rule + `children` + foot (store / page counter / ref),
plus the shared `PrintItemTable` (name/qty + two money columns) and
`PrintTotals` rows; both print documents compose them.

`apps/web/src/components/receipt-view.tsx` — rewritten to render `paginateReceipt`
output as N `.print-sheet`s.

`apps/web/src/components/return-voucher-view.tsx` — same sheet frame and its own
meta/lines/totals, paginated by `paginateReturnVoucher` (a return can carry up
to 200 lines, so "page 1 of 1" must not cover a clipped table).

`apps/web/src/index.css` — `.print-doc` / `.print-sheet` … classes from the
template (sizing in `rem`, sheet in `mm`, borders in `px` with `--hairline` /
`--heavy`) and `@page { size: A4; margin: 0 }`.

`apps/web/src/lib/i18n.ts` — one contiguous block of print labels.

## Pagination model

CSS cannot compute the page counter, so the split is decided in JS from a
conservative height budget (one unit ≈ one table row; the sheet's variable
content budget is ~20 units, so 13 is safe):

- page 1 furniture: items title 1 unit, carried-total block 2 units;
- continuation furniture: carry banner 2 + carried-total 2;
- closing block: totals 5 units (+ payment head 3 units and one unit per
  payment row, only when the invoice has payments);
- a line's weight is 1, or 2+ when its description wraps (`length / 32` chars).

So a no-payment invoice fits 7 lines on its closing sheet (13−5−1) and 10 on a
first continuation sheet; with a payment row the settled 12-line split is
10/2. Payment rows claim the closing sheet's spare room first (their real
UNITS, not their count — a wrapped note costs more than one row); any overflow
continues on sheets with the full header and a repeated payment table. With no
payments at all, the closing sheet renders no payment section.

The split itself is `paginateLineSlices`: it finds the smallest sheet count the
weights actually fit into (a sum of capacities is not enough — with uneven
weights a prefix can be too big to leave the closing sheet inside its budget)
and then fills each sheet with the feasible prefix closest to its even share.
The search allows one sheet MORE than the line count: the closing sheet may
legitimately carry only the totals/payment block with zero lines (e.g. a
payment-heavy invoice whose one line fits on an earlier sheet). A line heavier
than every cap falls back to one line per sheet so it still prints. The
voucher uses the same paginator with its own caps: the real meta row cost
(two base rows, plus the reason row, plus however many rows a wrapping party
name needs, clamped so the caps stay positive) and a three-row totals block,
with no carried total.

## Tests

- `lib/print-pagination.test.ts` (new) — weighted slicing: empty, one sheet,
  uneven weights never overrun, a zero-line closing sheet, a line heavier than
  every cap.
- `lib/receipt.test.ts` — projection (incl. address, no notes, backdated
  business date + recording time), pagination: one-sheet boundary (7 fit, 8
  split), 5-line single sheet, 12-line 10/2 with a payment, three sheets at 20
  lines, uneven weights, a payment-heavy invoice with a zero-line closing
  sheet, wrapped payment notes, a monster note (count=0 -> 1 fallback), the
  payment-overflow cap, carried totals, payment overflow. `assertCapacities`
  re-derives the paginator's budget and checks every sheet.
- `lib/return-voucher.test.ts` — the 200-line minimal sheet count (exactly
  18), a zero-line voucher, a reason + wrapped party charged to the budget,
  per-sheet capacity assertions and a wrapped description.
- `lib/dates.test.ts` — `combineBusinessDateTime` keeps the business day and
  takes the recorded clock time.
- `lib/print-format.test.ts` — grouped-amount format; the date shape is
  pinned by `lib/dates.test.ts` (#119).
- `components/receipt-view.test.tsx` — rendered document: labels, dir tokens,
  carry totals (both texts on a middle sheet), page footers, no payment
  section when empty, all-header-per-sheet.
- `tests/e2e/receipts.spec.ts` — 1-page invoice: sheet count, footer 1/1,
  formatted payment timestamp (no `T`).
- `tests/e2e/invoice-print-a4.spec.ts` (new) — a 12-line BACKDATED sale and a
  5-line purchase seeded through the real RPC wire: 2 sheets at 10/2 and 1
  sheet respectively, all lines present, the meta date is the business day
  with the recording time, the app invoice screen shows the same value, carry
  total + carry banner, payment row, both sheet headers, the RTL
  currency/amount bounding boxes, a long supplier name that wraps without
  overflowing the meta row or squeezing the short fields,
  `page.pdf({ preferCSSPageSize: true, displayHeaderFooter: true })` → 2 A4
  pages with no page URL in the decoded text, and a print-media geometry check
  that the sheet starts at the page origin.
- `tests/e2e/pdf-helpers.ts` (new) — decodes drawn PDF text through each font's
  ToUnicode CMap (Chrome encodes text as glyph IDs, so a byte scan cannot see
  a header). The spec proves the scanner with a positive control: a PDF printed
  with Chrome's own `.url` header template must contain `127.0.0.1`, while the
  production call (`displayHeaderFooter: true`, default templates) must not.

## Risks

- Chrome fragmenting a 297mm sheet into an extra page: capacities keep ~35 %
  headroom; the e2e pins the real page count.
- `@page` is global: the return voucher also loses the browser header/footer
  (intended) and adopts the shared sheet.
- Invoice `notes` are no longer printed — the settled sheet has no notes field.
- The meta row lets only the counterparty (and the voucher reason) wrap; every
  other field stays on one line, so a long name cannot squeeze the invoice
  number or the date onto second lines.
- Production source stays locale-neutral (no Arabic literals): the CI guard
  scans the receipt/voucher views and `invoice.tsx`, so Arabic lives only in
  `i18n.ts` and test fixtures.

## Out of scope

`lib/dates.ts` (#119) owns all date formatting and is now used directly;
customers/suppliers (#120) and the deps lane stay untouched.
