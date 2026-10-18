# Issue #9 — Debts screen (design)

**Tier:** High-assurance (debt direction — who owes whom).
**Base SHA:** af0c7a3 (`origin/develop`).
**Spec:** `.scratch/dokan-mvp/issues/07-debts-screen.md` (GitHub #9).

## Gap analysis vs. existing store

`StorePort.debtSummaries()` already implements the acceptance-critical grouping:

- groups unpaid invoices (`remaining_amount > 0`) by `kind` and
  `COALESCE(counterparty_id, counterparty_name)` — known parties group by id,
  typed-only names group by name, an id-backed party never merges with a
  same-named typed-only party (covered by existing store tests), and an
  invoice with neither id nor name is excluded (no party to owe).
- per group: `remainingTotal`, `invoiceCount`, oldest/latest invoice dates.

**Verified against acceptance:** totals = SUM(remaining), counts = per-party
invoice count, typed-only names preserved. No change needed to `debtSummaries`.

**Real gap:** the drill-down — "clicking a group opens its unpaid invoices".
`listInvoices` cannot filter by party (kind/status/date only), its `UNPAID`
status excludes PARTIAL invoices (remaining < total), and it caps at 200 rows.
A party's unpaid set is `remaining > 0` matched by the same grouping key, so a
small store method is the honest seam (one query, no client-side merge).

## Public API

### Store (apps/api/src/store/port.ts + drizzle-store.ts)

```ts
listUnpaidInvoicesByParty(
  kind: Invoice["kind"],            // SALE | PURCHASE
  counterpartyId: string | null,    // known party → match by id
  counterpartyName: string | null,  // otherwise match by typed name
): Promise<Invoice[]>;
```

Where `kind = ? AND remaining_amount > 0 AND (counterparty_id = ? | counterparty_name = ?)`
matching `debtSummaries`' grouping key exactly, so the two seams agree on
identity. Ordered invoiceDate DESC, createdAt DESC (same as listInvoices).

### Contracts (packages/contracts)

- `debtsByPartyInputSchema` (core.ts): `{ kind, counterpartyId: id|null,
  counterpartyName: string|null }`, refine: at least one of id/name non-null
  (a group always has one).
- `debtsByParty: oc.input(debtsByPartyInputSchema).output(invoiceListOutputSchema)`
  (app-contract.ts).
- `reportsDebts` already exists in the contract with the exact debts output
  (`{ owedToUs, weOwe }: DebtSummary[]`); it is the debts screen's RPC seam and
  is currently a `notImplemented` stub. This lane implements it.

### RPC (apps/api/src/rpc/router.ts)

- `reportsDebts`: guarded → `store.debtSummaries()` split by kind into
  `{ owedToUs: SALE, weOwe: PURCHASE }`.
- `debtsByParty`: guardedInput → `store.listUnpaidInvoicesByParty(...)` wrapped
  in the invoice-list output shape.

### Web

- New page `apps/web/src/pages/debts.tsx`, route `/debts`, nav link "الديون".
- Two groups (owedToUs, weOwe), each listing per-person rows with name,
  remaining total (دج), and invoice count plus a group total. Empty state per
  group. Clicking a person row expands that person's unpaid invoices
  (invoice number, date, total, remaining), lazily fetched via `debtsByParty`.
- i18n strings added to `apps/web/src/lib/i18n.ts` (Arabic; page is RTL via
  `<html dir="rtl">`).

## Planned tests

- **Store (`drizzle-store.test.ts`)**: typed-only name party returns exactly
  its unpaid invoices (excludes paid-off); id-backed party matched by id with
  same-named typed-only party not mixed; kind isolation (SALE vs PURCHASE);
  party total equals the debtSummaries remainingTotal (acceptance: totals
  match the sum of remaining amounts); fully-paid party → empty.
- **RPC (`router.test.ts`)**: `reportsDebts` splits SALE→owedToUs and
  PURCHASE→weOwe with correct totals/counts; `debtsByParty` returns that
  party's unpaid invoices; `debtsByParty` rejects missing session.
- **E2E (`tests/e2e/ticket09.spec.ts`)**: create a sale with a customer-typed
  name and partial payment (customer owes), create a purchase with a
  supplier-typed name and partial payment (we owe); open `/debts`; assert both
  groups render names, totals, invoice counts; click a group → its unpaid
  invoice appears.

## Risks

- `reportsDebts` lives under the "reports" section header in the contract; the
  #31 expenses/reports lane owns reports pages but no other debts-shaped RPC
  exists — implementing the stub is the debts screen's RPC, additive to the
  shared files both lanes expect to touch.
- Two lanes touching `router.ts`/`router.test.ts`/`i18n.ts`/`router.tsx` —
  keep all changes additive; parent owns merge.
- `.dokan-port` tracked file is rewritten by e2e runs (DOKAN_PORT=4326); must
  restore the original 4317 bytes after the e2e gate.