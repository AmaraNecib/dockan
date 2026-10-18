# Issue #120 — Customers & suppliers: finish the half-built feature (design)

Tier: **High-assurance** (invoice/debt money, identity). Base: `origin/develop` @
`8579fcf8f5d2197ec74d7fc01331530aef917957`. Branch: `feat/120-customers`.

## Problem

`customers` / `suppliers` tables, store methods and two contract declarations exist
but are unreachable: no router handlers, no web calls. Every invoice stores only the
free-text `counterparty_name` with `counterparty_id` null, so the debts page groups by
typed name («علي علي» and «على علي» are two debtors). Decisions: `docs/adr/0007`,
`CONTEXT.md`, grilling notes 2026-10-01.

## Product decisions (from the ADR + issue)

- Phone is the identity **when present**, unique across records (optional: walk-ins
  still save). Names may repeat.
- Same code path for customers and suppliers.
- Customers page = list + create/edit/delete; clicking a party opens a **full page**
  detail (header + stats strip + «الفواتير» / «الدفعات» / «المعلومات» tabs).
- **Hard delete only at zero invoices**; the button is disabled otherwise.
- Arabic canonical: «زبون» / «مورّد»; «الطرف» retired from the UI. Internal column
  stays `counterparty_name`.
- Picker in sale/purchase: filter by name or phone; pick a match; create inline when
  neither matches; warn on a duplicate name with a different phone.
- One-time backfill: one party record per distinct typed name, matching invoices
  pointed at it.

## Interfaces

### `packages/contracts/src/core.ts`

Customers and suppliers are one record shape; the role picks the table. Define one
`partySchema` and keep the two named aliases so existing call sites do not move:

```ts
export const partyRoleSchema = z.enum(["customer", "supplier"]);
export const partySchema = z.object({ id, name, phone: nullable, createdAt });
export const customerSchema = partySchema;
export const supplierSchema = partySchema;

export const partyStatsSchema = z.object({
  invoiceCount: z.number().int().min(0),
  totalAmount: dinarsSchema,   // sum of invoice totals
  paidAmount: dinarsSchema,    // sum of paid
  remainingAmount: dinarsSchema, // sum of remaining
});

/** list seam: joined aggregates, never on the entity schema (wisdom 67) */
export const partyListItemSchema = partySchema.extend({ stats: partyStatsSchema });
export const partyListOutputSchema = z.object({ items: z.array(partyListItemSchema) });

/** payments tab needs the invoice number, joined at the detail seam */
export const partyPaymentSchema = paymentSchema.extend({ invoiceNumber: z.string().min(1) });

export const partyDetailOutputSchema = z.object({
  party: partySchema,
  stats: partyStatsSchema,
  invoices: z.array(invoiceSchema),
  payments: z.array(partyPaymentSchema),
});

export const partyUpdateInputSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).optional(),
  phone: z.string().trim().nullable().optional(),
});
export const partyDeleteOutputSchema = z.object({ deleted: z.boolean() });

/** cleaned/canonical phone key; shared by api store and web picker */
export function normalizePartyPhone(raw: string | null | undefined): string | null;
```

`normalizePartyPhone` lives in `packages/contracts/src/phone.ts`: empty/absent → null;
an Algerian mobile normalizes through `normalizeAlgerianPhone` to `+213…`; anything
else is cleaned of `space . ( ) -` and kept verbatim (landlines stay possible).

### `packages/contracts/src/app-contract.ts`

Wire/extend the party procedures:

```ts
customersList:  oc.output(partyListOutputSchema),
customersGet:   oc.input(z.object({ id: idSchema })).output(partyDetailOutputSchema),
customersCreate: oc.input(partyCreateInputSchema).output(partySchema),
customersUpdate: oc.input(partyUpdateInputSchema).output(partySchema),
customersDelete: oc.input(z.object({ id: idSchema })).output(partyDeleteOutputSchema),
suppliersList / suppliersGet / suppliersCreate / suppliersUpdate / suppliersDelete // same
```

### `apps/api/src/db/schema.ts`

Backstops for the store rule (SQLite NULLs are distinct, so a partial index only
constrains present phones):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone) WHERE phone IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_phone ON suppliers(phone) WHERE phone IS NOT NULL
CREATE INDEX IF NOT EXISTS idx_invoices_counterparty ON invoices(counterparty_id)
```

### `apps/api/src/store/port.ts`

One role-parameterized seam (the ADR's "same code path" made structural). The four
legacy `listCustomers` / `createCustomer` / `listSuppliers` / `createSupplier`
members are replaced:

```ts
export type PartyDeleteResult = "DELETED" | "HAS_INVOICES" | "NOT_FOUND";
export class PartyError extends Error { constructor(public readonly code: "PHONE_EXISTS") }

listParties(role: PartyRole): Promise<PartyListItem[]>;
getParty(role: PartyRole, partyId: string): Promise<Party | undefined>;
createParty(role: PartyRole, input: PartyCreate): Promise<Party>;
updateParty(role: PartyRole, partyId: string, patch: PartyUpdate): Promise<Party | undefined>;
deleteParty(role: PartyRole, partyId: string): Promise<PartyDeleteResult>;
partyDetail(role: PartyRole, partyId: string): Promise<PartyDetail | undefined>;
```

Rules inside the adapter (not the router):

- phone uniqueness on create/update (excluding self), `PartyError("PHONE_EXISTS")`
  on a hit; a concurrent race still lands on the partial unique index.
- delete counts `invoices.counterparty_id` first; `HAS_INVOICES` when nonzero.
- `partyDetail` returns the party, one SQL aggregate for the stats strip, that
  party's invoices (kind-scoped) and payments joined to `invoice_number`.
- `listParties` LEFT JOINs invoices by id and kind so zero-invoice parties still
  list with zero stats.

### Backfill (one-time, `apps/api/src/store/drizzle-store.ts`)

`backfillCounterparties(conn)` runs from `setup()` after the DDL. Marker-gated on
`settings.key = 'migration.counterpartyBackfillV1'`, all inside `BEGIN IMMEDIATE`
so two booting processes converge. For each kind (`SALE` → customers,
`PURCHASE` → suppliers):

1. distinct `TRIM(counterparty_name)` where `counterparty_id IS NULL` and the name
   is non-empty;
2. reuse an existing party with the same trimmed name when present (idempotent even
   without the marker), else insert one with `phone = NULL` (phones are unknown);
3. `UPDATE invoices SET counterparty_id = ?` for the matching kind + trimmed name,
   only where the id is still null;
4. write the marker.

The invoice's `counterparty_name` is never rewritten (display/history unchanged).

### `apps/api/src/rpc/router.ts`

Handlers for the ten procedures, each session-guarded, each write in
`store.withTransaction`, each writing an activity row:

- create → `PARTY_CREATED <CUSTOMER|SUPPLIER> <name>`
- update → `PARTY_UPDATED <CUSTOMER|SUPPLIER> <name>`
- delete → `PARTY_DELETED <CUSTOMER|SUPPLIER> <name>`

Error mapping: `PartyError("PHONE_EXISTS")` → CONFLICT `CUSTOMER_PHONE_EXISTS` /
`SUPPLIER_PHONE_EXISTS`; a UNIQUE-index race maps to the same key; delete
`HAS_INVOICES` → CONFLICT `PARTY_HAS_INVOICES`; missing → NOT_FOUND `PARTY_NOT_FOUND`.
`PARTY_UPDATED` / `PARTY_DELETED` are added to `activityTypes`.

### Web

- `apps/web/src/components/parties/party-match.ts` (pure): `filterParties`,
  `partyQueryLooksLikePhone`, `duplicateNameParty`, `phoneMatchParty`.
- `apps/web/src/components/parties/party-picker.tsx` (new, controlled):
  `{ role, value: { id, name }, onChange, disabled, testId }`. Input role=combobox
  with an ARIA listbox; filters the loaded list by name or phone; picking fills
  `{ id, name }`; typing clears the id; a create panel appears when nothing
  matches (name prefilled; a phone-looking query prefilfils the phone field
  instead); it warns when the name matches an existing party with a different
  phone and blocks create when the typed phone already belongs to a record.
  Create calls `customersCreate` / `suppliersCreate` then picks the result.
- `apps/web/src/pages/parties.tsx` (new): one `PartiesPage({ role })` for
  `/customers` and `/suppliers`; role tabs, search, «+ زبون جديد», table
  (name, phone, invoice count, remaining), create/edit dialog, delete with
  confirm + disabled when `stats.invoiceCount > 0`, remaining sum footer.
- `apps/web/src/pages/party-detail.tsx` (new): one `PartyDetailPage({ role })` for
  `/customers/$partyId` and `/suppliers/$partyId`; back link, header (name, phone,
  تعديل / حذف), stats strip, tabs الفواتير / الدفعات / المعلومات (edit form).
  Dates render as today's raw values with `TODO(dates): swap to lib/dates.ts once
  #119 lands`.
- `apps/web/src/pages/sale.tsx`, `purchase.tsx`: the free-text counterparty input
  becomes the picker; the invoice input now carries `counterpartyId` when a record
  was picked/created.
- `apps/web/src/router.tsx`: four routes. `navigation.tsx`: «الزبائن» and
  «الموردون» in the main group. `i18n.ts`: one contiguous block of new keys.

## Dependencies

None new. Reuses `Amount`, `Button`, `Dialog`, `Table`, `EmptyState`, `Skeleton`,
lucide icons, `orpc`/react-query.

## Planned tests

Store seam (`apps/api/src/store/drizzle-store.test.ts`, file sqlite):

- create/list/update round-trip; phone optional; NULL phones never collide.
- phone uniqueness on create and update, self-update allowed, canonical
  `0550…` vs `+213…` compare equal.
- delete: zero invoices → DELETED; one invoice → HAS_INVOICES (row survives);
  unknown id → NOT_FOUND.
- `partyDetail`: stats sums, invoices kind-scoped, payments carry `invoiceNumber`.
- backfill: the five live names across SALE/PURCHASE, two invoices of one name
  share one record, rerun creates nothing, existing party is reused, marker
  short-circuits.

Router seam (`apps/api/src/rpc/router.test.ts`):

- ten handlers reachable + auth-guarded; create→list; update; delete rules map
  to CONFLICT; duplicate phone maps to `CUSTOMER_PHONE_EXISTS`;
  `customersGet` returns the detail shape; unknown id → NOT_FOUND.

Web unit (`apps/web`, happy-dom):

- `party-match.test.ts`: name substring, phone substring + canonical match,
  empty query returns all, phone-looking detection, duplicate-name warning
  (same phone → no warning), phone-owner detection.
- `party-picker.test.tsx`: renders matches while typing, pick reports the id,
  edit clears it, inline create calls the mutation and picks the result,
  duplicate warning visible, phone-owner blocks create.
- page tests: list renders stats and disables delete at invoiceCount > 0;
  detail renders stats + three tabs.

Playwright (`tests/e2e/customers.spec.ts`):

1. create category + item;
2. customer inline from the sale picker (type a new name → create → pick a match
   → set once assigned);
3. save a partial-payment sale → debts page groups it under the chosen name with
   the remaining;
4. customers page shows invoice count + remaining; row opens the detail page;
   tabs render invoice/payment rows; delete is disabled (has an invoice);
5. create a second customer with zero invoices → delete succeeds.

## Implementation risks

- **SQLite NULL uniqueness**: handled by the store check + partial unique indexes.
- **Backfill races**: `BEGIN IMMEDIATE` + marker + reuse-by-name.
- **Wire stripping**: list/detail output schemas must declare the joined fields
  (wisdom 67) — covered by router-seam tests.
- **Existing sale/purchase tests** mock `@/lib/rpc`: the picker adds
  `customersList` / `suppliersList` / `customersCreate` / `suppliersCreate` to
  those mocks; the `sale-customer` / `purchase-supplier` test ids move onto the
  picker input so the scripts keep driving the same field.
- **Parallel lanes**: `dates.ts` (119) and print pages (121) are untouched;
  i18n additions stay in one block.

## Definition of done

Store + router + picker + pages + backfill, unit tests at the store/router/pure
seams, the Playwright flow, guard Phase 1/2 green, debate + test-audit +
code-review evidence under `.scratch/reviews/120/<head-sha>-*.md`, one commit on
`feat/120-customers`.
