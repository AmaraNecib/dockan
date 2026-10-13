# A تسوية carries one dedup key: the client's key when sent, else the signature

Issue #177 made every manual adjustment go through one guarded store path that
refused a duplicate **request signature** `(supplierId, direction, amount, note,
invoiceId, occurredAt)`. Two holes survived:

- a caller that sends its own `occurredAt` and retries with a **changed**
  timestamp looks like a new request and posts a second row;
- the refusal lives only in the store, so a second writer that bypassed the
  guard had no database-level backstop.

We gave the adjustment one canonical **dedup key**, stored on the row as
`supplier_account_entries.dedup_key` and covered by a partial unique index.

- **When the caller sends an `idempotencyKey`**, that key is the identity of the
  request: a stored row with the same key (scoped to the supplier) is the same
  logical request, whatever its other fields. A changed timestamp therefore no
  longer defeats the retry guard.
- **When no key is sent** the #177 signature remains the key, unchanged, so the
  server-stamped-timestamp rule still protects omitted-date retries.
- The key is **additive to** the signature, never a replacement: a duplicate is
  refused when *either* arm matches.
  - the **key arm** matches `supplierId` + the client key and ignores every other
    field, so the same key is refused whatever else changed;
  - the **signature arm** matches `supplierId`, `direction`, `amount`, `reason`,
    `invoiceId`, and — **only when the incoming request carries its own
    `occurredAt`** — that `occurredAt`. A request that omits the date
    (`serverStamped`) drops the time and matches any stored time.
  `ref` is in neither arm, so changing it never releases an entry.
- **Recording a genuinely distinct entry** therefore means changing the
  signature: at least one of `direction`, `amount`, `reason`, `invoiceId` — or
  `occurredAt` when the request carries an explicit date (a request that omits
  the date is time-insensitive and cannot be released by the date). A request
  that carries a client key must *also* send a **new key**; a new key alone is
  not enough while the signature is unchanged, and dropping the key is not enough
  either because the signature arm stays active. `supplierId` differs only across
  accounts. Neither path weakens the guard.
- The key is written by the one guarded write path and enforced by a partial
  unique index, so a second process that races the identical request loses at
  the database, and the unique violation is mapped back to the same stable
  `DUPLICATE_ADJUSTMENT` refusal. The index covers identical **keys** (a `key:`
  value for a keyed row, a `sig:` value otherwise); a same-shape duplicate
  written under a different key, or through the signature path, is caught by the
  guard's signature arm, not by the index.

**Considered options**

- **(A) Key *replaces* the signature when present.** Rejected: a client that
  mints a fresh key on every retry would then double-post, because the signature
  backstop would be switched off exactly when a caller opted into a key.
- **(B) Keep the guard in the store only.** Rejected by the issue: no
  cross-process backstop.
- **(C) A partial unique index over the signature columns.** Rejected: it cannot
  express the server-stamped wildcard (the timestamp is dropped from the key at
  query time, not stored per row), and SQLite treats `NULL` note/invoice columns
  as distinct in a plain multi-column unique index. A single canonical key column
  makes the guard and the index read the same value.

**Consequences**

- `supplier_account_entries` gains a nullable `dedup_key TEXT`, a partial unique
  index `idx_supplier_entries_dedup` on it, and `CURRENT_SCHEMA_VERSION` moves
  3 → 4. The migration is additive: `ALTER TABLE … ADD COLUMN dedup_key`,
  existing `ADJUSTMENT` rows are backfilled with the time-inclusive signature key,
  and a pre-#177 duplicate (two rows with one signature) keeps a `NULL` key so the
  index stays creatable and the duplicate is preserved. Re-opening is idempotent.
- A version-3 build does not know the column, so it writes each new ADJUSTMENT
  with a NULL `dedup_key` — exempt from the partial index until the next v4 boot
  re-keys it (the backfill self-heals whenever the stored version is below 4, so
  a crash between the `ALTER` and the version stamp is repaired). Those rows would
  otherwise escape the new dedup, so a version-3 build MUST refuse the version-4
  database (ADR-0008 §4.5).
- The `serverStamped` rule is time-insensitive **in the matching direction**: a
  request that omits `occurredAt` is refused by any existing `ADJUSTMENT` with
  the same `(supplierId, direction, amount, reason, invoiceId)`, at any stored
  time — an explicit row included. An explicit request is time-sensitive and
  matches only a row with the same `occurredAt`. The *stored* key differs between
  a stamped row (`sig:[…, null]`) and an explicit one (`sig:[…, timestamp]`),
  which is what the index compares; the guard's column arm remains the authority
  for a stamped incoming request.
