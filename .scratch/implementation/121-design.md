# #121 — invoice print: settled A4 layout

Tier: **Standard**. Base: `origin/develop` @ `8579fcf`.

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
  invoiceDate: string;           // raw YYYY-MM-DD, formatted by the view
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
formatPrintDateTime("2026-10-01T00:34:15") === "01/10/2026 00:34"
formatPrintDateTime("2026-10-01")          === "01/10/2026"
formatPrintAmount(1234567)                 === "1,234,567"
```

`apps/web/src/components/print-sheet.tsx` (new) — the shared A4 frame:
store name + contacts + rule + `children` + foot (store / «صفحة X من Y» / ref).

`apps/web/src/components/receipt-view.tsx` — rewritten to render `paginateReceipt`
output as N `.print-sheet`s.

`apps/web/src/components/return-voucher-view.tsx` — same sheet frame, its own
meta/lines/totals; no pagination (returns are short).

`apps/web/src/index.css` — `.print-doc` / `.print-sheet` … classes from the
template (sizing in `rem`, sheet in `mm`, borders in `px` with `--hairline` /
`--heavy`) and `@page { size: A4; margin: 0 }`.

`apps/web/src/lib/i18n.ts` — one contiguous block of print labels.

## Pagination model

CSS cannot compute «صفحة X من Y», so the split is decided in JS from a
conservative height budget (one unit ≈ one table row; the sheet's variable
content budget is ~20 units, so 13 is safe):

- page 1 furniture: items title 1 unit, carried-total block 2 units;
- continuation furniture: carry banner 2 + carried-total 2;
- closing block: totals 5 units + payment head 3 units + one unit per payment row;
- a line's weight is 1, or 2+ when its description wraps (`length / 32` chars).

Pages are packed to the minimal count and distributed evenly (so a 14-line
invoice does not leave a one-line middle sheet). Payment rows claim the closing
sheet's spare room first; any overflow continues on sheets with the full header
and a repeated payment table.

## Tests

- `lib/receipt.test.ts` — projection (incl. address, no notes), pagination:
  1 sheet / 2 sheets / carried totals / long descriptions / payment overflow.
- `lib/print-format.test.ts` — date and grouped-amount formats.
- `components/receipt-view.test.tsx` — rendered document: labels, dir tokens,
  carry totals, page footers, payment history, all-header-per-sheet.
- `tests/e2e/receipts.spec.ts` — 1-page invoice: sheet count, footer 1/1,
  formatted payment timestamp (no `T`).
- `tests/e2e/invoice-print-a4.spec.ts` (new) — a 12-line invoice seeded through
  the real RPC wire: 2 sheets, all lines present, carry total + carry banner,
  payment row, both sheet headers, `page.pdf({ preferCSSPageSize: true,
  displayHeaderFooter: true })` → 2 pages, every MediaBox A4, no page URL,
  embedded fonts, and a print-media geometry check that the sheet starts at the
  page origin (`@page { margin: 0 }` removes the header/footer box).

## Risks

- Chrome fragmenting a 297mm sheet into an extra page: capacities keep ~35 %
  headroom; the e2e pins the real page count.
- `@page` is global: the return voucher also loses the browser header/footer
  (intended) and adopts the shared sheet.
- Invoice `notes` are no longer printed — the settled sheet has no notes field.

## Out of scope

`lib/dates.ts` (#119), customers/suppliers (#120), deps lane. The print date is
formatted inline with a `TODO(dates)`.
