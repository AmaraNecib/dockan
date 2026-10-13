# Issue 174 — Paginate the party-detail tabs and the supplier account entries (design)

Tier: **High-assurance** (the settle/pay money math must stay unchanged).
Base: `origin/develop` @ `8bf2a81` (merge-base = `8bf2a81`).
Branch: `feat-174-party-pagination`.

## Problem

#163 paginated every flat list but deliberately left the party-detail tabs
(a customer/supplier's invoices and payments) and the #161 supplier-account
entries whole. Those lists are entangled with the in-page settle/pay panels
and the `deleteParty` FK guard, all of which need the **complete invoice set**
for a correct money distribution. This change adds page reads for the tabs
while leaving the money reads whole.

## Hard constraint

`partyDetail` keeps returning the full invoice set. The settle/pay panels
(`CustomerSettlePanel`, `SupplierPayPanel`, `SupplierReturnPanel`,
`SupplierAdjustPanel`) and the delete guard (`stats.invoiceCount`,
`account.entries.length`) read it. No pagination may reach:

- `deleteParty` / `customersDelete` / `suppliersDelete`;
- `distributePayment` / `unpaidTotal` / the settle cap;
- `suppliersPay` / `suppliersReturn` / `suppliersAdjust` / `suppliersRefund`.

Only the **tab tables** read the new paginated endpoints.

## Public interfaces

### Contracts (`packages/contracts/src/core.ts`)

```ts
export const partyInvoicesInputSchema = paginationInputSchema.extend({
  role: z.enum(["customer", "supplier"]),
  id: idSchema,
  /** customer invoices tab: only rows with remaining > 0 (matches unpaidInvoices) */
  unpaidOnly: z.boolean().optional(),
});
export const partyInvoicesOutputSchema = pagedOutputSchema(invoiceSchema);

export const partyPaymentsInputSchema = paginationInputSchema.extend({
  role: z.enum(["customer", "supplier"]),
  id: idSchema,
});
export const partyPaymentsOutputSchema = pagedOutputSchema(partyPaymentSchema);

export const supplierEntriesInputSchema = paginationInputSchema.extend({ id: idSchema });
export const supplierEntriesOutputSchema = pagedOutputSchema(supplierAccountEntrySchema);
```

All three reuse the shared envelope: `{ limit, offset }` in (optional),
`{ items, total }` out, `resolvePagination` defaults (10 / 0). A `limit` of 0
or one above `MAX_PAGE_SIZE` is rejected by the existing schema.

### Contract endpoints (`packages/contracts/src/app-contract.ts`)

```ts
partyInvoices:   oc.input(partyInvoicesInputSchema).output(partyInvoicesOutputSchema),
partyPayments:   oc.input(partyPaymentsInputSchema).output(partyPaymentsOutputSchema),
supplierEntries: oc.input(supplierEntriesInputSchema).output(supplierEntriesOutputSchema),
```

Role-parameterized (one endpoint each) rather than two role-prefixed pairs, so
the web tab has a single query key per list.

### Store port (`apps/api/src/store/port.ts`)

New paginated reads beside the untouched `partyDetail` / `listSupplierEntries`:

```ts
partyInvoices(role, partyId, filters: { unpaidOnly?: boolean }, pagination?)
  -> Promise<{ items: Invoice[]; total: number }>;
partyPayments(role, partyId, pagination?)
  -> Promise<{ items: PartyPayment[]; total: number }>;
supplierEntries(supplierId, pagination?)
  -> Promise<{ items: SupplierAccountEntry[]; total: number }>;
```

`supplierEntries` is a **new** method. `listSupplierEntries` (full array) stays
exactly as it is because the money paths (`suppliersPay`, returns, opening
balances, `partyDetail`) read it to derive the signed balance.

### Store (`apps/api/src/store/drizzle-store.ts`)

Three shared query builders, used by both `partyDetail` (full) and the new
page reads (sliced), so the two can never disagree:

- `partyInvoiceWhere(role, id, unpaidOnly?)` — the one predicate
  (`counterpartyId = id AND kind = partyInvoiceKind[role]`, plus
  `remainingAmount > 0` when `unpaidOnly`).
- `partyInvoiceSelect(...)` — orders `invoiceDate DESC, createdAt DESC,
  invoices.rowid DESC`. The rowid tie-break is added so pages never repeat or
  skip a row when two invoices share a date and second. It does not touch the
  money path: the settle distribution re-sorts deterministically in
  `distributePayment`.
- `partyPaymentSelect(...)` / `partyPaymentCount(...)` — same invoice scope,
  `paidAt DESC, createdAt DESC, payments.rowid DESC`.

`partyDetail` switches its two inline selects to these builders (same data,
same order, now deterministic). `supplierEntryRows(supplierId)` is extracted
from `listEntries` so `listSupplierEntries` (full) and `supplierEntries`
(paged) share one select.

`total` is a SQL count independent of the page (`db.$count` on `invoices`;
an explicit `COUNT(*)` join for payments, which needs the invoice scope).

### Router (`apps/api/src/rpc/router.ts`)

Three `guardedInput` handlers. Each resolves pagination with
`resolvePagination` and delegates to the store. A missing/foreign party
returns an empty page (total 0), matching the list-read precedent
(`returnsList`); the page never calls these for a party the detail read
already failed on.

### Web (`apps/web/src/pages/party-detail.tsx`)

- Two `usePagination()` instances: `invoicePager` and `paymentPager` (the
  page size is the shared `ui.pageSize` preference; offsets are independent).
- `partyInvoices` query feeds the invoices tab
  (`input: { role, id: partyId, unpaidOnly: showUnpaidOnly, ...invoicePager.pagination }`).
  The filter checkbox calls `invoicePager.reset()` so a filter change snaps
  back to page 1.
- `partyPayments` (customer) / `supplierEntries` (supplier) feed the payments
  tab; both role-gated by `enabled`, sharing `paymentPager`.
- Each tab renders the shared `<Pager>` with a distinct `testId`
  (`party-invoices-pager`, `party-payments-pager`, `supplier-entries-pager`),
  hidden by the component while `total <= pageSize`.
- The stats strip, unpaid total, settle cap, supplier balance, delete guard,
  and all panels still read the full `detail.data` / `account`.
- After a panel `onDone`, the page invalidates the three tab query families
  through the `PARTY_INVOICES_QUERY_KEY` / `PARTY_PAYMENTS_QUERY_KEY` /
  `SUPPLIER_ENTRIES_QUERY_KEY` constants in `lib/query-keys.ts` (the
  double-nested oRPC path prefix `[["partyInvoices"]]`, not the string-first
  form that is a silent no-op). The shared panels only invalidate
  `customersGet`/`suppliersGet`, so this is what keeps the tabs fresh after
  money moves without editing the shared supplier components.

## Dependencies

None new. Contracts first, then store, then router, then web.

## Planned tests

- **Store** (`apps/api/src/store/pagination-store.test.ts`): page
  `partyInvoices` (first/second/past-the-end), `total` independent of the page,
  `unpaidOnly` filter narrows both rows and `total`, `partyPayments` pages with
  a stable total, `supplierEntries` pages with a stable total, and a no-page
  full read. Non-overlap of pages (rowid tie-break).
- **Router** (`apps/api/src/rpc/router.test.ts`): `partyInvoices`,
  `partyPayments`, `supplierEntries` return `{ items, total }` over the wire;
  a `limit` of 0 and above `MAX_PAGE_SIZE` are rejected; **`partyDetail` still
  returns every invoice** for a party with more rows than one page; a
  supplier's full `account.entries` and `account.balance` are unchanged by the
  paged read. The existing settle/pay store + web money tests stay green.
- **Web** (`apps/web/src/pages/party-detail.test.tsx`,
  `apps/web/src/pages/parties.test.tsx`): the tab rows come from the paginated
  read, the unpaid-filter toggle resets to page 1, and the pager appears once
  the total exceeds the page size. Router/orpc mocks extended with the three
  new procedures.
- **Playwright** (`tests/e2e/pagination.spec.ts`): seed a supplier with > 10
  purchase invoices, open its detail page, assert the invoices-tab pager and
  page-2 rows; switch to the payments tab and assert the supplier-entries
  pager; seed a customer with > 10 sale invoices and assert the unpaid-only
  filter resets to page 1. Page size asserted from 10 (the shared `signIn`
  preamble opens lists wide, so the spec sets `ui.pageSize` back to 10).

## Implementation risks

- **Money path regression.** Mitigated by leaving `partyDetail`,
  `listSupplierEntries`, and every write path untouched in shape; the new reads
  are additive. Router tests pin the full detail set.
- **Page overlap on ties.** `invoiceDate`/`createdAt` have second precision;
  the rowid tie-break makes pages deterministic.
- **Stale tabs after a payment.** The page invalidates the tab keys on
  `onDone`; the panels' own invalidations are unchanged.
- **`$count` with a join.** Payments cannot use `db.$count` (no join in the
  generated count), so the payment count is an explicit `COUNT(*)` join query.
- **Selects/dropdowns.** The pay/return/adjust panels keep reading the full
  `detail.data.invoices`; no paginated read feeds a `<select>`.

## Deferred (not silently dropped)

`partyDetail` still returns full `payments` and `account.entries` beside the
full invoices; only the tabs page. Trimming the detail payload to the money
fields would be a follow-up contract change; out of scope here.
