# Ticket 11. Receipt printing: design

- **branch:** `feat/11-receipt-printing`
- **base SHA:** `706a498` (merge-base with origin/develop; == HEAD at design time)
- **review tier:** Standard (money-adjacent display only — no new money math;
  totals are reused verbatim from the invoice detail)
- **issue:** github #11 — a print button on the invoice screen generates a PDF
  receipt and opens the system print dialog; paper when the owner wants it,
  no special printer required; Arabic RTL.

## Scope decisions up front

- **Print path is the browser's, not Rust's.** The desktop shell is a stock
  Tauri/WebView2 window (no custom IPC in `src-tauri`). WebView2 supports
  `window.print()`, which opens the OS print dialog (and can "Save as PDF"
  from that dialog on Windows). Per the issue: "prefer `window.print()` on a
  print-only receipt view ... do NOT add a native Rust printing dependency".
  No Rust changes, no new npm packages.
- **Dedicated print route, in-app.** A print-only route
  `/invoices/$invoiceId/print` renders the receipt and auto-fires
  `window.print()` once the data lands. This is testable by route (E2E print
  dialogs are headless-hostile — we assert the receipt route content, never
  the OS dialog, and say so in the spec comment). The app chrome (top nav) is
  hidden when printing via a small `@media print` rule.
- **No new money math.** `buildReceipt` is a pure projection of the
  `InvoiceDetail` + `Settings` already fetched by the invoice screen:
  lines, totals, paid/remaining, and payment history are copied, never
  recomputed. RTL: the receipt root is `dir="rtl"`; dates and the phone stay
  left-to-right spans, exactly like the existing invoice detail screen.
- **Payment history on the receipt** = the same `invoice.payments` array the
  invoice screen already shows; a fully-paid invoice prints its history too.
- Additive only: shared `router.tsx` gains one route, `i18n.ts` gains a few
  keys; auth/config/store seams untouched.

## Public interfaces

### `apps/web/src/lib/receipt.ts` (pure, new)

```ts
export interface ReceiptLine { description: string; quantity: number; unitPrice: number; netTotal: number; }
export interface ReceiptPayment { paidAt: string; method: PaymentMethod; amount: number; note: string | null; }
export interface Receipt {
  storeName: string;
  storePhone: string | null;
  invoiceNumber: string;
  kind: InvoiceKind;
  invoiceDate: string;
  counterpartyName: string | null;
  notes: string | null;
  lines: ReceiptLine[];
  subtotalAmount: number;
  discountAmount: number;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  payments: ReceiptPayment[];
}

export function buildReceipt(invoice: InvoiceDetail, settings: Settings): Receipt;
```

Pure projection; no i18n, no DOM, no network — the deterministic unit-test
seam for "lines/totals/paid/remaining/payment history joined correctly".

### `apps/web/src/components/receipt-view.tsx` (presentational, new)

`ReceiptView({ receipt }: { receipt: Receipt })` — the print-only layout:
store identity header, invoice number/date/kind/party, lines table, totals
(subtotal / discount / final), paid / remaining, payment history table.
`data-testid`s: `receipt-view`, `receipt-store`, `receipt-number`,
`receipt-date`, `receipt-line`, `receipt-total`, `receipt-paid`,
`receipt-remaining`, `receipt-payment`, plus a `dir="rtl"` root. No queries
inside — parents feed it data, so the render test is deterministic.

### `apps/web/src/pages/receipt-print.tsx` (new)

`ReceiptPrintPage` — `useParams("/invoices/$invoiceId/print")`, fetches
`invoicesGet` + `settingsGet`, builds the receipt, renders `ReceiptView`,
and once both queries are ready fires `window.print()` exactly once
(StrictMode-safe via a ref gate). Toolbar with back-to-invoice link +
"print now" button; toolbar carries `print-hidden` so paper shows only the
receipt. Loading/error states mirror the invoice page (skeleton/alert).

### `apps/web/src/router.tsx` (additive)

- New route `invoices/$invoiceId/print` → `ReceiptPrintPage` (child of root).
- The top nav `<header>` gets `print-hidden` so it never prints.

### `apps/web/src/index.css` (additive)

```css
@media print {
  .print-hidden { display: none !important; }
}
```

### `apps/web/src/pages/invoice.tsx` (additive)

A "طباعة الإيصال" link (`→ /invoices/$invoiceId/print`) next to the existing
back link, `data-testid="invoice-print"`.

### `apps/web/src/lib/i18n.ts` (additive keys)

`invoicePrint`, `receiptBack`, `receiptPrintNow`, `receiptKindLabel`,
`receiptPaidLabel`, `receiptRemainingLabel`, `receiptDateLabel`,
`receiptPartyLabel` (reusing existing values where they already exist:
line headers, totals, payment labels come from the current invoice keys).

## Dependencies

- None new. react-query, react-i18next, @tanstack/react-router, shared
  contracts — all already in `apps/web`.

## Tests

Unit (`apps/web`):

- `lib/receipt.test.ts` — `buildReceipt`:
  - maps lines verbatim (description / quantity / unitPrice / netTotal) with
    discount lines present, in invoice order;
  - totals copied: subtotal, discount, total, paid, remaining — no
    recomputation (a deliberately inconsistent fixture keeps its values);
  - payment history joined in order with method + note + paidAt preserved,
    including a `null` note and an empty-payments case;
  - store identity: storeName + non-null phone carried through; `null` phone
    stays null; counterpartyName null → null; RTL-relevant fields (date,
    phone) stay raw strings for the view to set `dir="ltr"`.
- `components/receipt-view.test.tsx` — deterministic render in happy-dom:
  - renders store name, invoice number, date, lines, every total, paid /
    remaining, and every payment row;
  - root `dir="rtl"`, date/phone cells carry `dir="ltr"`;
  - hidden-history state (no payments → empty note row) still renders totals.

E2E (`tests/e2e/ticket11.spec.ts`):

- setup + login (shared-db pattern);
- create category + item; sale with `sale-paid` = partial (500 of 900) →
  one payment row already in history;
- open the invoice from `/invoices`, settle the remaining 400 via the payment
  panel → paid invoice with 2 history rows;
- click `invoice-print` → navigate to `invoices/$id/print`; assert the print
  preview contains store name, invoice number, both lines' totals, paid /
  remaining (0), and both payment rows.
- NOTE in the spec: `window.print()` opens the OS dialog which is
  headless-hostile; the assertion targets the print route content (the
  dialog itself is exercised manually in the desktop shell).

## Implementation risks

- `window.print()` in headless e2e Chromium is a no-op — safe, and the route
  content is what we assert. In WebView2 it opens the OS dialog.
- StrictMode double-mount could double-fire `window.print()` — a ref gate
  makes the effect fire once per mount.
- Auto-print timing: firing before fonts/layout settle prints a blank page —
  a short delay after the queries resolve (and a manual "طباعة الآن" button
  as the escape hatch) covers it.
- The app chrome must not print: `.print-hidden` on the nav header; the
  receipt document itself is the only `@media print` content.