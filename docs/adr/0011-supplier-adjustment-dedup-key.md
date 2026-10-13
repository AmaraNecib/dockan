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
  refused when *either* matches. The key cannot weaken the #177 money-safe rule
  that an identical repeat is refused; the escape hatch for a genuinely-wanted
  identical entry stays "separate the signature by reason/date/ref", not a
  weakened guard.
- The key is written by the one guarded write path and enforced by a partial
  unique index, so a second process that races the identical request loses at
  the database, and the unique violation is mapped back to the same stable
  `DUPLICATE_ADJUSTMENT` refusal.

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
- A version-3 build has no `dedup_key` and would write the duplicates the index
  forbids, so it MUST refuse the version-4 database (ADR-0008 §4.5).
- A stamped request and an explicit request are now different requests (the key
  encodes the request shape); this narrows, not widens, what is refused, and no
  caller that retries changes shape between attempts.
