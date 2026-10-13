# #183 — Names-only supplier lookup for the opening-balance conflict check

Tier: **Standard** (read-path change that feeds a money screen).
Base: `origin/develop` @ `da44b502d39c79a1368e9848542d9a25fac301fc` (== HEAD, no local commits).

## Problem

`apps/web/src/pages/supplier-opening-balance.tsx` calls `orpc.suppliersList`
(`store.listParties("supplier")`) unconditionally. That read is the *list seam*
(ADR/issue-120 comment in `port.ts`): it LEFT JOINs every invoice for the party
and GROUP BYs, then adds the signed account balance + entry count. The page uses
it for two different jobs:

1. **The name-conflict check** — `newOpeningRowStatus({ existingNames })` and
   `matchByNormalizedName` compare typed text against supplier names. This needs
   only `{ id, name }`.
2. **The balance table** — render each supplier's current signed balance and
   whether it already carries an account entry (`accountEntryCount`).

Job 1 pays for the whole invoice aggregate. Job 2 needs the supplier account
summary but *not* the invoice aggregate, phone, or createdAt.

## Boundary with #184 (not merged at branch time)

`origin/feat-184-server-name-resolution` adds `suppliersResolveName`, which
resolves **one** typed name to **one** destination (`{ id, name, accountEntryCount }`)
and returns no list. It does **not** satisfy this issue: the duplicate-name guard
("two outgoing rows folding to one name") needs the **list**. #184 has not merged
into `develop` (`git grep suppliersResolveName origin/develop` is empty), so this
branch is built on `develop` and does not duplicate the fold rule — it keeps the
existing `matchByNormalizedName`, which #184 will delete. No fold rule is added
here.

## Decision

Split the page's one heavy read into two lean ones, and give the name-conflict
check a **names-only** seam:

### Store (`apps/api/src/store/`)

- `port.ts`
  - `export type PartyName = { id: string; name: string }`
  - `export type SupplierAccountSummary = { id: string; accountBalance: number; accountEntryCount: number }`
  - `listPartyNames(role: PartyRole): Promise<PartyName[]>` — `SELECT id, name
    FROM <party table> ORDER BY name`. No invoices, no aggregates, no phone.
  - `listSupplierAccountSummaries(): Promise<SupplierAccountSummary[]>` —
    `SELECT supplier_id AS id, SUM(<signed>) AS accountBalance, COUNT(*) AS
    accountEntryCount FROM supplier_account_entries GROUP BY supplier_id`. Only
    suppliers that carry an entry; the page defaults a missing id to 0/0. Reuses
    the one `supplierSignedAmountSql` sign expression, so it cannot disagree with
    `listParties`/`supplierBalance`.
- `drizzle-store.ts` implements both. `listParties` is untouched (other screens
  still use it).

### Contracts (`packages/contracts/`)

- `core.ts`: `partyNameSchema`, `partyNamesOutputSchema`,
  `supplierAccountSummarySchema`, `supplierAccountSummariesOutputSchema`.
- `app-contract.ts`: `suppliersListNames` (names-only, for the conflict check),
  `suppliersAccountSummaries` (the balance table's columns).

### Router (`apps/api/src/rpc/router.ts`)

Two read-only handlers (`guarded`), next to `suppliersList`.

### Page (`apps/web/src/pages/supplier-opening-balance.tsx`)

- Load `suppliersListNames` (names-only) and `suppliersAccountSummaries`.
- Merge by id into the `suppliers` rows the table renders:
  `{ id, name, accountBalance, accountEntryCount }` (missing summary → 0/0).
- **All name comparison** (`newOpeningRowStatus` `existingNames`,
  `matchByNormalizedName`, the folded-name `typedNameConflict`) reads the
  names-only list. The table's balance/entry columns read the account summary.
- Loading/error state is the OR of the two reads. A refusal/refresh invalidates
  both keys instead of `suppliersList`.
- `suppliersList` is **removed** from the page: no unconditional full-party load.

## Planned tests

- **Store** (`drizzle-store.test.ts`): `listPartyNames` returns only `{id, name}`
  for the role, ordered by name, and does not expose an invoice aggregate;
  `listSupplierAccountSummaries` carries the signed balance + entry count and
  agrees with `listParties`' `accountBalance`/`accountEntryCount`.
- **Router** (`router.test.ts`): `suppliersListNames` returns the supplier names;
  `suppliersAccountSummaries` returns the signed summary.
- **Web** (`supplier-opening-balance.test.tsx`): the mock moves to the two new
  reads; every existing conflict/confirm test stays green, plus the two
  acceptance cases — a typed name folding onto an existing supplier is detected,
  and two outgoing rows folding to one name are blocked.
- **E2E** (`tests/e2e/supplier-adjustment.spec.ts`): the existing bulk-flow test
  exercises the screen; no test change needed unless the merge changes behavior.

## Risks

- **Losing the conflict warnings the full list powered.** The names-only list
  still carries every supplier name, and the merge preserves `accountEntryCount`
  for the confirmation gate. A test asserts the fold conflict still blocks.
- **Two reads instead of one.** Both are strictly cheaper than the invoice join;
  they run in parallel through React Query.
- **#184 rebase.** #184 edits the same page and still references `suppliersList`;
  it will need to rebase onto this. Out of scope here (parent owns landing).
- **Sign drift.** The account summary reuses `supplierSignedAmountSql`, and a
  store test pins it against `listParties`.
