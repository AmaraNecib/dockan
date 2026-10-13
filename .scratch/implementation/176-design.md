# #176 — Supplier adjustments (تسوية) and a bulk opening-balance screen (رصيد افتتاحي)

Base: `origin/develop` @ `1840a3a`. Tier: **High-assurance** (account money + a
schema version bump). Orchestrator: `.agents/skills/feature-implement/SKILL.md`.

## Goal

A supplier account today only gains debt through a `PURCHASE` invoice. The first
real shop has old / standalone debts with **no invoice**. #176 adds one signed
manual adjustment — **تسوية** — plus a bulk **رصيد افتتاحي** screen. Terms are the
owner's, verbatim: **نسالوه** = we owe him (increases the balance), **يسالنا** =
he owes us (decreases it / moves toward credit).

## Model

### One new entry kind, one new direction

`supplierEntryKinds` gains `"ADJUSTMENT"` (additive). An adjustment carries a
`direction`:

| direction | owner word | sign | meaning |
|---|---|---|---|
| `WE_OWE`   | نسالوه | + | the shop owes the supplier more |
| `THEY_OWE` | يسالنا | − | the shop owes less / moves toward credit |

`direction` is a new **nullable** column on `supplier_account_entries`
(`ALTER TABLE ... ADD COLUMN direction TEXT`). It is null for every pre-existing
kind; only `ADJUSTMENT` requires it. The account stays **append-only** — a
mistake is another تسوية with a reason, never a delete.

`supplierEntrySign(kind, direction)` and `supplierBalance(entries)` learn the
ADJUSTMENT sign. Every SQL aggregate of the balance must use the same case
expression — one helper `supplierSignedAmountSql(alias)` in `drizzle-store.ts`
feeds `debtSummaries` (both the invoice aggregate and the credit-only query) and
the new `listParties` balance, so the /debts screen, the supplier detail, and the
list can never disagree.

### Optional invoice link (owner decision)

- **account-only** (`invoiceId` absent): moves the account balance; must never
  touch any invoice's `paid`/`remaining`.
- **invoice-linked** (`invoiceId` present): a real discount/write-off. It reduces
  **that invoice's remaining without cash**, using the same derived-remaining
  mechanism returns use. The linked entry is written with the same conditional
  UPDATE (`applyDebtOffsetToInvoice`: `remaining >= amount`) inside the
  `BEGIN IMMEDIATE` unit, so the DB is the authority. The remaining is clamped
  at ≥ 0 and a linked amount may not exceed it — the excess is **refused**
  (`ADJUSTMENT_EXCEEDS_REMAINING`), never silently moved to credit.
- A linked adjustment is only meaningful in the reduction direction, so
  `direction` MUST be `THEY_OWE` when `invoiceId` is present; the contract
  superRefine and the router both refuse `WE_OWE` + link.
- `getInvoiceDetail.returnCreditAmount` gains the sum of the invoice-linked
  `ADJUSTMENT` entries, so the printed header reconciles as
  `total − paid − returnCredit = remaining` exactly as it does after a return.
  `deriveInvoicePaid` ignores adjustments (they are not money paid).

### Bulk opening balance

One account-only تسوية per filled row. The screen lists every supplier with its
**current balance** and entry count, allows an amount + direction per row, an
inline **new** supplier name, and one shared date + reason. Rows whose supplier
already carries an account entry require an explicit **confirmation**
(`confirmExisting`); the router re-checks inside the transaction and rolls the
whole batch back when an unconfirmed row has entries
(`OPENING_BALANCE_EXISTS`). No invoice link exists in the bulk screen.

## Schema + migration (BLOCKING)

- `CURRENT_SCHEMA_VERSION` 2 → **3**. Version 3 (issue 176): the ADJUSTMENT kind
  and the `supplier_account_entries.direction` column. A version-2 build accepts
  version-3 data but would read a `WE_OWE` adjustment as a decrement (its sign
  case has no ADJUSTMENT branch) and show a wrong balance, so it MUST refuse
  (ADR-0008 §4.5).
- Forward migration: `ensureSupplierAdjustmentDirectionColumn()` (the barcode
  pattern) adds the column when `PRAGMA table_info` shows it missing. It is
  idempotent by construction; a fresh database gets the column from `SCHEMA_DDL`.
  No data backfill is needed — a version-2 database has no ADJUSTMENT rows, and
  every existing kind keeps `direction = NULL`.
- The blocking test (`.scratch` acceptance): create a version-2 DB with the
  version-2 shape + rows → open with the new build → `setup()` adds the column,
  preserves the rows, and stamps 3 → `assertSchemaVersionSupported(raw, 2)`
  refuses → close, re-open → `setup()` is idempotent (version stays 3, no
  duplicate/no error) → a new ADJUSTMENT row round-trips with its direction.
- **Customer extension (B) path**: the customer half will add its own account
  table (or a generic party ledger) and its own additive kind set. It is
  additive: new tables/columns and a further `user_version` bump, never a
  reuse or re-sign of an existing kind. A build that predates the bump refuses
  the newer database instead of mis-signing it — the same rule that keeps this
  change safe. Recorded in ADR-0010.

## Contracts (`packages/contracts/src/core.ts` + `app-contract.ts`)

- `supplierEntryKinds += "ADJUSTMENT"`.
- `supplierAdjustmentDirections = ["WE_OWE","THEY_OWE"]`; `supplierAdjustmentDirectionSchema`.
- `supplierAccountEntrySchema += direction: supplierAdjustmentDirectionSchema.nullable()`.
- `supplierAdjustInputSchema` `{ supplierId, direction, amount>0, reason?, occurredAt?, invoiceId? }`
  + superRefine: an `invoiceId` requires `direction === "THEY_OWE"`.
- `supplierOpeningBalanceRowInputSchema` `{ supplierId? xor newSupplierName?, direction, amount>0, confirmExisting? }`;
  `supplierOpeningBalancesInputSchema` `{ occurredAt, reason?, rows: 1..200 }`;
  `supplierOpeningBalancesOutputSchema` `{ created, accounts: { supplierId, name, balance }[] }`.
- `partyListItemSchema += accountBalance: int|null, accountEntryCount: int|null`
  (suppliers only; null for customers and for typed-only rows). The list seam is
  where joined aggregates live (issue 120 comment), and the bulk screen needs
  both the balance and a reliable "already has entries" signal.
- `activityTypes += "ADJUSTMENT_RECORDED"`.
- `invoiceDetailSchema.returnCreditAmount` doc comment mentions adjustments.
- App contract: `suppliersAdjust`, `suppliersOpeningBalances`.

## Store (`apps/api/src/store/`)

- `schema.ts`: `supplierAccountEntries.direction`; `SCHEMA_DDL` column + a
  `direction TEXT CHECK (direction IN ('WE_OWE','THEY_OWE') OR direction IS NULL)`
  column constraint on the fresh DDL. (The ALTER path adds the same nullable
  column; validation of the kind/direction pairing stays at the router + pure
  module, because a table-level CHECK cannot be added by ALTER.)
- `drizzle-store.ts`: `SupplierEntryRow`/`toSupplierEntry` carry `direction`;
  `listEntries` selects it; `insertSupplierEntry` writes it;
  `supplierSignedAmountSql` helper; `debtSummaries` uses it; `listParties`
  computes `accountBalance`/`accountEntryCount` for suppliers;
  `getInvoiceDetail` adds the adjustment sum to `returnCreditAmount`;
  `ensureSupplierAdjustmentDirectionColumn()` runs in `setup()`.
- `port.ts`: `SupplierEntryInsert += direction?: SupplierAdjustmentDirection | null`.

## Pure module (`apps/api/src/lib/supplier-ledger.ts`)

- `SupplierEntryKind += "ADJUSTMENT"`.
- `supplierEntrySign(kind, direction = null)`: ADJUSTMENT → `+1` for `WE_OWE`,
  `−1` for `THEY_OWE`; throws when direction is missing (a corrupt ADJUSTMENT
  row must not be silently signed).
- `supplierBalance(entries)` passes each entry's direction through.

## Router (`apps/api/src/rpc/router.ts`)

- `suppliersAdjust`: `BEGIN IMMEDIATE`. Resolve supplier. Account-only: one
  ADJUSTMENT entry. Invoice-linked: require `THEY_OWE`, resolve a PURCHASE
  invoice of this supplier, refuse `amount > remaining`
  (`ADJUSTMENT_EXCEEDS_REMAINING`), append the entry, then
  `applyDebtOffsetToInvoice` (refuse `ADJUSTMENT_DEBT_OFFSET_REFUSED` if the
  conditional UPDATE loses a race). Activity `ADJUSTMENT_RECORDED`. Returns
  `supplierAccountSchema` like `suppliersPay`.
- `suppliersOpeningBalances`: `BEGIN IMMEDIATE`. For each row: resolve/create the
  supplier, refuse an unconfirmed existing account (`OPENING_BALANCE_EXISTS`),
  append one account-only ADJUSTMENT entry (`ref = "OPENING_BALANCE"`, shared
  reason in `note`). Activity per row. Returns `{ created, accounts }`.

## Web (`apps/web/src/`)

- `components/parties/supplier-adjust-panel.tsx`: direction toggle
  (نسالوه/يسالنا), whole-amount input, reason + presets (رصيد افتتاحي / تصحيح /
  دين قديم / خصم), backdatable date (default today), optional «تخصّ فاتورة؟»
  picker over the supplier's open purchase invoices, a before/after balance
  preview, and confirm/cancel. Linking forces يسالنا and blocks an amount above
  the invoice remaining client-side; the api re-checks.
- `party-detail.tsx`: a «تسوية» button beside pay/return/refund; the account
  rows sign an ADJUSTMENT by its direction and show the direction label.
- `pages/supplier-opening-balance.tsx` + route `/suppliers/opening-balance`
  (`router.tsx`; `App.tsx` untouched): shared date + reason, one row per
  supplier (name + current balance + direction + amount), an inline new-supplier
  row, and a confirmation dialog for filled rows whose supplier already carries
  an entry. Save → `suppliersOpeningBalances` → notice + back to /suppliers.
- `pages/parties.tsx`: a «رصيد افتتاحي» link on the supplier tab only.
- i18n: Arabic keys for every new string; `supplierEntry_ADJUSTMENT` = «تسوية».

## Tests

- Unit (`supplier-ledger.test.ts`): ADJUSTMENT sign for both directions; balance
  with a mixed account; missing direction throws.
- Store (`supplier-account-store.test.ts`): account-only adjustment moves the
  balance and leaves every invoice unchanged; linked adjustment drops the
  invoice remaining and is reflected in `returnCreditAmount`; the debts/list
  balance agrees with `supplierBalance`; a bulk-style batch writes one entry per
  row.
- Router (`router.test.ts`): account-only vs linked; excess refused and nothing
  written; `WE_OWE` + link refused; bulk writes one entry per filled row and
  refuses an unconfirmed existing account atomically.
- Migration (`schema-version.test.ts` or a new `supplier-adjustment-migration.test.ts`):
  the full v2 → v3 sequence above — **blocking**.
- Playwright (`tests/e2e/supplier-adjustment.spec.ts`): record a رصيد افتتاحي
  from the bulk screen, then a linked خصم, and see the balance and the invoice
  agree.

## Risks

- A second balance aggregate that forgets ADJUSTMENT → the /debts screen and the
  supplier detail disagree. Mitigation: one `supplierSignedAmountSql` helper +
  an agreement test.
- An unconfirmed duplicate opening balance. Mitigation: server-side
  `OPENING_BALANCE_EXISTS` inside `BEGIN IMMEDIATE`, not client-only.
- Signing a linked adjustment the wrong way. Mitigation: refuse the excess and
  the non-reducing direction at the contract and the router; conditional UPDATE
  is the final guard.
- Widening `partyListItemSchema` rippling. It is the list seam; only the store
  constructs it, and customers get explicit `null`s.
