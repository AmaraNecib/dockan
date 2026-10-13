# #161 — Supplier account: signed ledger, payments, returns, refunds

Closes the supplier half of #164. Base: `origin/develop` @ `c873e16`. Tier: **High-assurance**.

## Model (ADR-0009)

One **signed account per supplier**. Every money movement is one append-only entry:

| kind | sign | meaning |
|---|---|---|
| `PURCHASE` | + | a purchase invoice's charge (its total) |
| `PAYMENT`  | − | money paid to the supplier |
| `RETURN`   | − | goods returned to the supplier |
| `REFUND`   | + | cash received from the supplier to close a credit |

`balance = Σ signed amounts`. Positive = the shop owes the supplier. Negative =
the shop is ahead (a **credit**). Customers keep their invoice-based debt
untouched.

An entry may name an invoice (`invoiceId`). When a payment/return names an
invoice, only the part that still fits the invoice's remaining debt is attached
to it; the excess becomes a credit entry (`invoiceId = null`). This keeps the
purchase invoice's `paid / remaining` a **derived cache** of the entries that
name it, and keeps the printed invoice unchanged.

Typed-name purchases (no supplier record) stay invoice-based, exactly like
customers — there is no account to sign.

## Database

New table `supplier_account_entries` (DDL in `SCHEMA_DDL`):

```
id TEXT PK, supplier_id TEXT NOT NULL REFERENCES suppliers(id),
kind TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0),
invoice_id TEXT NULL REFERENCES invoices(id), method TEXT NULL,
note TEXT NULL, ref TEXT NULL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL
```

Index on `(supplier_id, occurred_at)`.

`CURRENT_SCHEMA_VERSION` is bumped to **2** (ADR-0009): an older build would
accept the version-1 shape and record purchases/payments with no supplier
entries, silently corrupting the balance, so it must refuse the upgraded data
(ADR-0008 §4.5).

A purchase whose total is zero opens no charge entry (the ledger's
`CHECK (amount > 0)` would reject it); the invoice and its stock intake still
land.

`invoices.paid_amount / remaining_amount` remain the printed invoice's cache.
They are written by the existing conditional UPDATEs (`applyPaymentToInvoice`,
`applyDebtOffsetToInvoice`) inside the same `BEGIN IMMEDIATE` unit as the entry.
A pure `deriveInvoicePaid(entries, total)` proves the cache matches the entries;
a store test asserts it on fixture data.

### Backfill (develop fixtures only)

On `setup()`, once (guarded by setting `migration.supplierAccountV1`), for each
`PURCHASE` invoice with a `counterparty_id`:
- insert a `PURCHASE` entry of `total_amount`;
- insert a `PAYMENT` entry per existing `payments` row, attached to the invoice.
Already-returned debt (`returns.debt_applied`) has no purchase sibling today, so
nothing else is migrated. Customer `SALE` invoices are untouched.

## Pure modules (unit-tested, no IO)

`apps/api/src/lib/supplier-ledger.ts`
- `supplierEntrySign(kind)` → +1/−1
- `supplierBalance(entries)` → signed sum
- `allocateOldestFirst(invoices, amount)` → `{ invoice, applied }[]`, oldest by
  `invoiceDate → createdAt → numeric invoice number → id`, each capped at its
  remaining, tail left undistributed (credit)
- `splitAgainstRemaining(amount, remaining)` → `{ attached, credit }`
- `deriveInvoicePaid(entries, invoiceId, totalAmount)` → `min(total, Σ PAYMENT entries attached)`
- `supplierReturnSplit(returnValue, invoiceRemaining)` → `{ debtReduction, credit }`
- `availableSupplierCredit(balance)` → the refundable credit (`max(0, −balance)`)

A purchase return is not "paid" money: the printed purchase invoice reconciles
as `total − paid − returnCredit = remaining`, where `returnCredit` sums the
sale-side `returns.debtApplied` and the supplier-side
`supplier_returns.debtReduction` for that invoice.

## Contracts (`packages/contracts/src/core.ts`)

- `supplierEntryKinds = ["PURCHASE","PAYMENT","RETURN","REFUND"]`
- `supplierAccountEntrySchema` (id, supplierId, kind, amount, invoiceId?,
  invoiceNumber?, method?, note?, ref?, occurredAt, createdAt)
- `supplierAccountSchema` (balance: int (signed), entries: array)
- `supplierPayInput` `{ supplierId, amount>0, method?, note?, target: {kind:"OLDEST"|"INVOICE"|"CREDIT", invoiceId?} }`
- `supplierReturnInput` `{ supplierId, invoiceId?, lines?, itemId?, quantity?, amount?, reason?, cashBack? }` — superRefined: exactly one of (invoice-linked `lines`) or (free-standing item).
- `supplierRefundInput` `{ supplierId, amount>0, method?, note? }`
- `partyDetailOutputSchema` gains `account: supplierAccountSchema.nullable()`
- `debtsOutputSchema` supplier rows gain `balance` (signed) while customers keep
  `remainingTotal`.

## API (`apps/api/src/rpc/router.ts` + store)

- `invoicesCreate` PURCHASE: insert the `PURCHASE` charge entry (only when the
  invoice has a `counterpartyId`); `initialPaid` also writes a `PAYMENT` entry.
- `suppliersPay`: `BEGIN IMMEDIATE`. Resolve target invoices (oldest-first, one
  specific invoice, or pure credit). For each target, attach `min(remaining,
  left)` and write a `PAYMENT` entry + conditional UPDATE; the remainder is one
  credit `PAYMENT` entry (`invoiceId = null`). Activity `PAYMENT_RECORDED`.
- `suppliersReturn`: `BEGIN IMMEDIATE`. Invoice-linked validates the
  bought-minus-already-returned cap per line, prices at the line's unit cost and
  reduces stock at the current average. Free-standing takes item+quantity+amount
  and reduces stock. **Auto-accepted** (status ACCEPTED, no PENDING_REVIEW).
  `RETURN` entry: attached part capped at the invoice remaining, excess credit.
  `cashBack` records a matching `REFUND` entry (cash received), never above the
  resulting credit.
- `supplierRefundsCreate`: `BEGIN IMMEDIATE`. Requires an existing credit;
  amount ≤ |balanced|; writes a `REFUND` entry. Activity `PAYMENT_RECORDED`.
- `suppliersGet` (`partyDetail`): suppliers also return `account`.
- `reportsDebts`: supplier rows use the account balance; expansion lists the
  supplier's invoices + account movements.

## Web

- `party-detail.tsx` (supplier): balance header with «دفعة», «مرتجع», «استرداد»
  actions; the «الدفعات» tab shows account entries joined with the invoice number.
- New components `components/parties/supplier-pay-panel.tsx`,
  `supplier-return-panel.tsx`, reusing `AmountPercentageInput` (#162).
- `debts.tsx`: supplier rows render the signed net balance; the drill-down lists
  invoices + account movements.
- `returns.tsx`: two tabs «مرتجعات الزبائن» (existing review list) and
  «مرتجعات الموردين» (plain history + voucher link, no accept/reject).

## Risks

- Money paths must run `BEGIN IMMEDIATE` with conditional guards; a payment and
  a return can never exceed what is owed, the excess flows to credit.
- The backfill must not double-charge a supplier on repeated boots (marker).
- Customer sale flows must be untouched.

## Tests

Unit: sign/balance, oldest-first allocation, excess-to-credit split, invoice
derivation vs cache, invoice-linked return cap, free-standing return, refund cap.
Store: entry insert + balance + backfill.
Playwright: pay a supplier invoice from the supplier page → balance drops;
purchase return moves balance/credit and marks the invoice; account refund
closes a credit.
