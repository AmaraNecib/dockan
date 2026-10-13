# Design — #181 supplier adjustments: explicit client idempotency key + DB-level unique index

Base: `origin/develop` @ `8bf2a81` (contains #177/#180).
Branch: `feat-181-adjustment-idempotency`. Tier: **High-assurance** (invoice/debt money math + a schema-version bump).

## Problem

#177 added one guarded write path for a manual تسوية and deduped on the request
signature `(supplierId, direction, amount, note, invoiceId, occurredAt)`, dropping
`occurredAt` from the key when the caller omits it (`serverStamped`). Two gaps remain:

1. **No explicit idempotency key.** A caller that supplies its own `occurredAt` and
   retries with a *changed* timestamp computes a different signature and posts a
   second row. The server has no way to recognise the retry.
2. **Dedup lives only in the store.** A second process (or a future adapter) that
   bypasses the in-process guard could insert a duplicate signature. There is no
   database-level backstop.

## Decision

### D1 — one canonical dedup key per adjustment

Add a nullable `dedup_key TEXT` column to `supplier_account_entries`. For an
`ADJUSTMENT` row the store writes the value of one pure function,
`adjustmentDedupKey(input)`; for every other kind it writes `NULL` (the partial
index ignores those rows).

One pure function in `apps/api/src/lib/supplier-ledger.ts`:

```ts
export type AdjustmentDedupInput = {
  supplierId: string;
  direction: SupplierAdjustmentDirection;
  amount: number;
  reason: string | null;
  occurredAt: string;
  invoiceId: string | null;
  /** #177 — the caller omitted occurredAt; the server stamped it */
  serverStamped?: boolean;
  /** #181 — an explicit client key; when present it is the primary identity */
  idempotencyKey?: string | null;
};

export function adjustmentDedupKey(input: AdjustmentDedupInput): string {
  if (hasExplicitIdempotencyKey(input)) {
    // hasExplicitIdempotencyKey proved a trimmed non-empty value exists
    return `key:${JSON.stringify([input.supplierId, (input.idempotencyKey ?? "").trim()])}`;
  }
  return `sig:${JSON.stringify([
    input.supplierId,
    input.direction,
    input.amount,
    input.reason,
    input.invoiceId,
    input.serverStamped === true ? null : input.occurredAt,
  ])}`;
}

export function hasExplicitIdempotencyKey(input: { idempotencyKey?: string | null }): boolean {
  const idempotencyKey = input.idempotencyKey?.trim();
  return idempotencyKey !== undefined && idempotencyKey !== "";
}
```

`ref` is part of neither form: changing it never changes the key.

`JSON.stringify` gives NULL-safe, delimiter-safe, deterministic encoding, so a
caller's note or key can never smuggle a separator. The `key:` / `sig:` prefixes
keep the two namespaces apart.

### D2 — precedence: the explicit key wins, the signature is not weakened

When `idempotencyKey` is present it is the **primary** identity of the request:
a stored row with the same key is the same logical request, **whatever** its
other fields are. So a retry that changes `occurredAt` (or any field) but keeps
the key is refused.

The #177 signature stays in force as an independent backstop: a duplicate is
refused when **either** the key or the signature matches. The key can therefore
never weaken the existing guard *for a request that keeps its shape*: a buggy
client that mints a fresh key on a retry still hits the signature as long as the
timestamp is unchanged, and an identical repeat is still refused (the brief's
money-safe rule). The key is scoped by `supplierId`, matching the
supplier-scoped signature.

When the key is absent the signature alone decides, exactly as #177 defined it.
`serverStamped` still drops `occurredAt` from the signature, so an omitted-date
retry (fresh server clock) is still caught.

**Boundary.** The union is exact while a retry resends the same shape. A caller
that drops the key *and* changes the timestamp (or mints a fresh key *and* a
fresh timestamp) between attempts sends two different requests by every key the
store holds; that is outside the idempotency-key contract (a retry resends the
request, it does not re-shape it). The in-store guard still serializes writers,
so the index backstop remains the same-shape cross-process net.

### D3 — guard and index share the key

`hasSupplierAdjustment` keeps the #177 column predicate as the no-key path and
adds one branch:

```
if (idempotencyKey) {
  kind = 'ADJUSTMENT' AND (dedup_key = adjustmentDedupKey(input)
                           OR <the #177 column conditions>)
} else {
  kind = 'ADJUSTMENT' AND <the #177 column conditions>   // unchanged
}
```

Why both arms of the keyed branch:

- `dedup_key = key:` matches the same key at **any** shape, which is the gap-1
  fix — a changed `occurredAt` (or any field) is still the same logical request.
- the signature arm refuses a keyed retry of a request whose first attempt was
  sent **without** a key, so a same-signature retry that drops the key cannot
  double-post (only a retry that also changes the timestamp escapes; see the D2
  boundary).

The no-key path is the exact #177 predicate, so every existing behaviour
(including the `serverStamped` wildcard) is preserved for unkeyed callers and
for reading a legacy row's columns.

New rows store `dedup_key` (the key when present, else the signature). The
partial unique index is on `dedup_key`, so two processes that race the identical
request compute the identical key and the index refuses the loser.
`insertSupplierAdjustment` catches the unique violation and throws
`SupplierAdjustmentError("DUPLICATE")`, so the DB backstop surfaces as the same
stable ORPC `DUPLICATE_ADJUSTMENT` the guard produces. Cross-shape requests (a
stamped retry against an explicit row) are still caught by the column predicate
before the index is reached.

The index covers identical **keys** (a `key:` value for a keyed row, a `sig:`
value otherwise), not identical *requests* in every shape: a same-shape logical
duplicate written under a different key, or a keyed row duplicated through the
signature path, is caught by the guard's signature arm, not by the index. The
index is the cross-process net for two writers that compute the **same** key.

### D4 — DB backstop

New DDL, in `SCHEMA_DDL` (fresh DBs get it directly, upgraded DBs after the
migration):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_entries_dedup
  ON supplier_account_entries(dedup_key) WHERE dedup_key IS NOT NULL
```

The `WHERE dedup_key IS NOT NULL` clause is the "partial" that exempts every
non-adjustment row and any legacy duplicate deliberately left unkeyed.

### D5 — migration v3 → v4, additive

`CURRENT_SCHEMA_VERSION` moves 3 → 4. `setup()` calls a new
`ensureSupplierAdjustmentDedupKeyColumn()` before the DDL loop (the same place
`ensureSupplierAdjustmentDirectionColumn` sits), following the barcode pattern:

1. If `supplier_account_entries` exists and has no `dedup_key`, one
   `BEGIN IMMEDIATE` unit does `ALTER TABLE ... ADD COLUMN dedup_key TEXT` and the
   backfill.
2. Backfill: every existing `ADJUSTMENT` row with a NULL key gets the
   **time-inclusive** signature key (`serverStamped: false`) computed from its
   stored columns, in `rowid` order. A key already used by an earlier row is left
   `NULL` — a pre-#177 duplicate is preserved and exempt from the index; the
   guard's signature arm still matches it. A row created by #177's weaker guard is
   keyed like any other. The backfill is **self-healing**: it runs whenever the
   stored version is below 4, not only when the column is missing, so a boot that
   died between the `ALTER` and the version stamp is repaired on the next open.
3. Opening the DB stamps version 4 (`stampSchemaVersionLocked`). A version-3 build
   refuses it (`assertSchemaVersionSupported`), because it has no `dedup_key` and
   would write NULL-keyed adjustments that escape the new dedup. On a
   current-version database the backfill scan is skipped and every row keeps its
   key, so re-opening is idempotent. An older build refusing the new DB is the
   required behaviour (ADR-0008 §4.5).

### D6 — the deliberate bulk-vs-manual overlap stays

The bulk `رصيد افتتاحي` and the manual panel produce the same signature for the
same logical entry, so a repeat through either is refused. That is money-safe and
unchanged. A genuinely distinct re-entry must change the **signature** —
`direction`, `amount`, `reason`, `invoiceId`, or `occurredAt` when the request
carries an explicit date (a request that omits the date is time-insensitive and
cannot be released by the date). `ref` is not in the signature or the key, so
changing it never releases an entry. A request that carries a client key must
*also* send a **new key**; a new key alone is not enough while the signature is
unchanged, and dropping the key is not enough either because the signature arm
stays active. Neither path weakens the guard.

### D7 — not user-facing

The web client already sends its form date, so the UI retry path is covered by the
existing signature. The new key is for scripted/import callers. No web change and
no new Playwright flow; the full existing suite still runs as a gate.

## Interfaces

- `packages/contracts/src/core.ts`: `supplierAdjustInputSchema` gains
  `idempotencyKey: z.string().trim().min(1).max(200).optional()`.
- `apps/api/src/lib/supplier-ledger.ts`: `AdjustmentDedupInput`, `adjustmentDedupKey`.
- `apps/api/src/store/port.ts`: `SupplierAdjustmentInsert.idempotencyKey`,
  `SupplierAdjustmentSignature` picks it up; `insertEntryRow` takes the key.
- `apps/api/src/db/schema.ts`: `supplierAccountEntries.dedupKey` + DDL + index.
- `apps/api/src/lib/schema-version.ts`: `CURRENT_SCHEMA_VERSION = 4`.
- `apps/api/src/store/drizzle-store.ts`: migration, key write, key guard, constraint mapping.
- `apps/api/src/rpc/router.ts`: forwards `idempotencyKey`.

## Planned tests (TDD)

- `lib/supplier-ledger.test.ts`: `adjustmentDedupKey` — explicit key wins over
  signature and over `serverStamped`; key is trimmed; two suppliers with the same
  key differ; signature is time-sensitive for an explicit date and
  time-insensitive for a server-stamped one; distinct amount/direction/reason/
  invoice differ; NULL-safe (null note vs note "" differ).
- `store/supplier-account-store.test.ts`: a keyed insert then a same-key insert
  with a **different** `occurredAt` is `DUPLICATE`; a same-signature different-key
  insert is still `DUPLICATE` (the key cannot weaken the signature); a different
  key with a different signature is allowed; the `dedup_key` column is written;
  the unique index exists and a raw duplicate `dedup_key` INSERT is refused at
  the DB level; the raw `insertSupplierEntry` seam keys an account-only
  adjustment too.
- `store/supplier-adjustment-migration.test.ts`: the blocking v3→v4 test (add
  column, preserve + key rows, leave a duplicate unkeyed, stamp 4, v3 build
  refuses, reopen idempotent) plus the index rejecting a duplicate.
- `rpc/router.test.ts`: the gap-1 flow — explicit date + key, retry with a changed
  date is `DUPLICATE_ADJUSTMENT` and posts once; no key still allows two distinct
  dates; empty key is an input-validation error; a key change with the same
  signature is allowed.

## Risks

- **Time-insensitive matching for omitted-date requests.** A request that omits
  `occurredAt` drops the time from the signature and is refused by any existing
  ADJUSTMENT with the same `(supplierId, direction, amount, reason, invoiceId)`,
  whether the stored row was explicit or stamped. An explicit request only
  matches the same `occurredAt`. This is #177's existing rule, unchanged by the
  key; the key only adds a match.
- **Duplicate legacy rows.** Handled by leaving the later rows' `dedup_key` NULL
  (index creation cannot fail on existing data) and keeping the column fallback in
  the guard.
- **Index-name collision.** None — `idx_supplier_entries_dedup` is new.
