# Design — Issue #8: Payments on invoices (instalments)

**Tier:** HIGH-ASSURANCE (payment amounts exceeding invoice totals is an explicit
high-assurance example in docs/engineering-workflow.md).

**Base SHA:** af0c7a3 (merge-base with origin/develop).

## Problem

A customer (SALE) or the shop (PURCHASE) settles an invoice later, in instalments.
Each later payment must:
- reduce `remainingAmount` by exactly its amount (never below 0),
- refuse any amount > remaining (overpay) with an exact, clear error,
- accumulate: `paidAmount` = Σ payments,
- be visible in full on the invoice screen,
- log a `PAYMENT_RECORDED` activity,
- commit atomically: payment row + paid/remaining recompute + activity in ONE
  transaction (a crash mid-way must not persist a payment without its recompute).

## What already exists (checked)

- Schema: `payments` table + `invoices.paidAmount/remainingAmount`
  (`apps/api/src/db/schema.ts`).
- Store seam: `insertPayment` (tested) + `setInvoicePaidAmounts` + `getInvoiceDetail`
  returning `payments` ordered by (paidAt, id) — chronological history.
- RPC contract: `invoicesPay` already declared with
  `invoicePayInputSchema` (invoiceId, amount>0, method?, note?) →
  `invoiceDetailSchema` (`packages/contracts/src/core.ts`, `app-contract.ts`).
- Router: `invoicesPay` currently `notImplemented`.
- Session guard + `withTransaction` serialization patterns exist.
- Web: no invoice list/detail screen yet (purchase/sale creation pages only);
  html root is already `dir="rtl" lang="ar"`.

## Changes

### 1. API procedure — `invoicesPay` (apps/api/src/rpc/router.ts)

Inside `guardedInput` → one `withTransaction`:

1. `detail = tx.getInvoiceDetail(input.invoiceId)`; `undefined` → `NOT_FOUND` `INVOICE_NOT_FOUND`.
2. Business rule (the high-assurance boundary): if `input.amount > detail.remainingAmount`
   → `ORPCError("BAD_REQUEST", { message: "PAYMENT_EXCEEDS_REMAINING" })`.
   Exact-remaining passes; remaining=0 refuses any positive amount.
3. `tx.insertPayment({ invoiceId, amount, method: input.method ?? "CASH", note: null-or-trimmed, paidAt: now })`.
4. `tx.applyPaymentToInvoice(detail.id, input.amount)` — a single conditional
   `UPDATE ... SET paid_amount = paid_amount + ?, remaining_amount = remaining_amount - ?
   WHERE id = ? AND remaining_amount >= ?` (new StorePort seam). If it returns
   false the whole unit rolls back with `PAYMENT_EXCEEDS_REMAINING`: the DB,
   not a JS read, is the final authority, so two processes on the same file
   can never both overpay an invoice. This replaces the design's earlier
   JS-side `paid + amount` recompute (a check-then-act gap across processes).
5. `tx.insertActivity({ type: "PAYMENT_RECORDED", summary: "تسجيل دفعة <amount> دج على <invoiceNumber>", ref: id })`.
6. Re-read `tx.getInvoiceDetail(id)` and return it (fresh header + appended history).

Scope decision (recorded): a payment made AT invoice creation is audited by the
create transaction's `SALE_CREATED`/`PURCHASE_CREATED` activity; `PAYMENT_RECORDED`
is logged per LATER instalment — the issue's subject is "record later payments".
Emitting a second activity for one creation-time money event would split one
financial fact into two log entries.

### 2. Error key + i18n

- New stable server key `PAYMENT_EXCEEDS_REMAINING` → Arabic text
  "المبلغ يتجاوز المتبقي من الفاتورة".
- UI keys for the invoices list/detail + payment form (additive to i18n.ts).

### 3. Web UI (new, additive)

- `apps/web/src/pages/invoices.tsx` — `/invoices` list: kind filter
  (all/SALE/PURCHASE) + status filter (all/UNPAID/PARTIAL/PAID), rows link to
  `/invoices/$invoiceId`. Uses `orpc.invoicesList`.
- `apps/web/src/pages/invoice.tsx` — `/invoices/$invoiceId` detail:
  - `InvoiceHeader` (settings identity) + invoice meta (number, kind, party, date)
  - summary block: total / paid / remaining (testids)
  - full payment history table (amount, method, note, paidAt)
  - record-payment form (amount, method select CASH/BANK, note), hidden
    validation: positive integer, ≤ remaining; overpay → inline error;
    disabled once remaining = 0; success invalidates invoicesGet/invoicesList/
    activitiesList queries.
  - Exported pure validator `paymentInputInvalid(amount, remaining)` for unit tests.
- `apps/web/src/router.tsx` — add nav link "الفواتير" + two routes.

### 4. Tests

**API router (apps/api/src/rpc/router.test.ts — new describe "invoice payments (ticket 8)"):**
- unauthed `invoicesPay` → UNAUTHORIZED
- partial payment on a SALE invoice reduces remaining; returned detail has the payment appended
- two payments accumulate → paid = Σ, remaining = total − Σ
- exact-remaining payment OK → remaining 0
- overpay +1 DA → PAYMENT_EXCEEDS_REMAINING; nothing written (payment count + paidAmount unchanged)
- payment on already-PAID invoice refused
- TWO CONCURRENT instalments: exactly one lands, one refused — never overpay
- status transitions: PARTIAL after first instalment, leaves PARTIAL at settlement
- PURCHASE invoice payable (both kinds)
- missing invoice → INVOICE_NOT_FOUND
- zod rejects non-positive / fractional / NaN / > MAX_SAFE_INTEGER amounts before the handler
- empty/whitespace-only note normalizes to null
- `PAYMENT_RECORDED` activity logged with ref + summary containing the number
- rollback atomicity: failing store whose `insertActivity` throws →
  payment row absent, paid/remaining unchanged, no phantom activity row
  (mirrors the settings-atomicity test harness).

**API store (apps/api/src/store/drizzle-store.test.ts):**
- multiple `insertPayment` + `setInvoicePaidAmounts` accumulate; `getInvoiceDetail`
  returns them in chronological order (extended additively).
- `applyPaymentToInvoice` cross-connection: a second store/connection on the same
  file cannot apply an instalment against a stale remaining.
- zero-total invoice is PAID, never UNPAID.

**Web (apps/web/src/pages/invoice.test.ts):**
- `paymentAmountError`: accepts exact remaining; rejects +1, 0, negative,
  fractional, scientific/hex spellings, > MAX_SAFE_INTEGER, non-numeric.
- `PaymentPanel` component (router-free, mirrors LinkProposalPanel): empty
  history, ordered history rendering, client-side overpay blocks + sends
  nothing, valid submit + `role="status"` success, server-refusal translation
  path, form locked at remaining 0.

**E2E (tests/e2e/ticket8.spec.ts):**
- setup/login (shared-db idempotent pattern) → seed category+item →
  create a SALE invoice with zero paid via /sale quick-add-with-stock →
  /invoices → open it → record two payments → history shows both → remaining
  decreases to 0 → overpay attempt refused with the clear error AND a
  request-count proves nothing reached the server → pay form disabled when
  paid off → activity log shows the two PAYMENT_RECORDED rows.

## Risks / notes

- Concurrency: the overpay boundary is enforced by a single conditional UPDATE
  (`applyPaymentToInvoice`), atomic at the SQLite statement level, so no
  check-then-act race survives even across two processes on one file. The unit
  still wraps insert + UPDATE + activity in one BEGIN/COMMIT for crash atomicity.
- Money schema: `dinarsSchema` is capped at `Number.MAX_SAFE_INTEGER` so no
  persisted sum can drift into float-inexact territory or overflow SQLite i64.
- Shared files (router.ts, router.test.ts, i18n.ts, router.tsx) are edited
  additively only; debts (#31) and expenses (#9) seams untouched.
- Money is whole DA integers throughout; no float arithmetic.
- Deferred (documented follow-ups, not blockers): DB-level `CHECK` on
  paid/remaining columns would need a SQLite table rebuild (ALTER cannot add
  CHECK); a `payments(invoice_id)` index and a note length cap are scale
  niceties; `/invoices` inherits the pre-existing 200-row list cap; pre-change
  purchase invoices with an initial payment carry no payment row (no backfill).
- Timestamp: one reused `localDateTime()` for paidAt pins the payment into the
  history order at its real position (store orders by paidAt, rowid).
- `.dokan-port` tracked file must be byte-restored after e2e (4317, 4 bytes).