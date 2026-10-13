# A dedup index backstops a key, not a request shape (supplier adjustments #181)

**Date:** 2026-10-14 · **Tickets:** 181 (follow-up to 177/180) · **Area:** apps/api/src/store/drizzle-store.ts, apps/api/src/lib/{supplier-ledger,schema-version}.ts, packages/contracts

0. **An explicit idempotency key must be additive to the existing signature guard,
   never a replacement.** The tempting design ("when a key is present, it is the
   whole identity") disables the accidental-double-post backstop exactly when a
   caller opts in, so a client that mints a fresh key on every retry double-posts.
   Implement the keyed predicate as `or(keyed, bySignature)` — a strict superset
   of the old refusals. State the one boundary honestly: a retry that drops the
   key **and** changes the timestamp is re-shaping its request, not retrying it,
   and is outside the contract. Do not claim "the key can never weaken the guard"
   without that precondition.

1. **A stored dedup key is a property of the row; a query-side wildcard is not
   indexable.** #177's server-stamped rule drops `occurredAt` from the *query*
   when the caller omitted it, but the row still stored a concrete timestamp. A
   partial unique index can only enforce a value derived from the row, so the
   canonical key must be written at insert time from the same pure function the
   guard uses. Consequence: the index backstops two writers that compute the
   **same key** (the identical concurrent request); a same-shape duplicate under
   a different key or through the signature path is still the guard's job. Scope
   that claim in the ADR or a reviewer will read "DB is the authority" as total.

2. **Verify the schema-refusal rationale against the migration code.** The v4
   comment first claimed a v3 build "would insert the duplicate the index
   forbids" — false, because a v3 build writes `NULL` keys and the partial index
   exempts them. The real reason to refuse v4 is the opposite: those `NULL` rows
   escape the new dedup. A blocker-class review finding was purely this text.

3. **A self-healing backfill closes the ALTER↔stamp crash window.** An additive
   migration commits the `ALTER` before `stampSchemaVersionLocked` runs, so a
   boot that dies in between leaves the column present with an old
   `user_version`; a downgraded writer then adds `NULL`-keyed rows. Re-key every
   `NULL` `ADJUSTMENT` row on boot (skipping keys already taken, so a pre-#177
   duplicate stays exempt) instead of early-returning on "column exists". Gate
   the scan on `readSchemaVersion < CURRENT_SCHEMA_VERSION` so steady-state boots
   are free while the crash window is still repaired.

4. **Closing a bypass seam means keying it too.** The raw `insertSupplierEntry`
   path could still write an account-only ADJUSTMENT with no key, invisible to
   the partial index — the exact hole the index exists to close. Compute the
   canonical key there as well (time-inclusive, since a raw caller has no
   server-stamped flag) and map the unique violation to the same `DUPLICATE`.

5. **This repo's anti-slop lint:** every type assertion needs a `SAFETY:` comment
   immediately before it, and a function parameter may not be typed `unknown`.
   Narrow `unknown` at the catch-site (`error instanceof Error`) rather than
   accepting an unparsed value.

6. **A partial unique index makes the duplicate the store's problem, not a 500.**
   `isUniqueViolation` must map the constraint to the same typed refusal the guard
   throws, scoped to the index's own column (`supplier_account_entries.dedup_key`)
   so a primary-key collision is not mislabeled. The caller must let that refusal
   roll the whole `BEGIN IMMEDIATE` unit back — never treat it as "already
   applied".

7. **The full Playwright suite is environment-flaky here; isolate the cause
   before blaming your diff.** Orphaned API/web servers from an interrupted run
   keep serving stale in-memory data on the expected port even after the DB file
   is wiped (`wipe-e2e.mjs` deletes `.e2e-data`, but the old process answers the
   health check). Symptom: cross-spec contamination (`duplicate item` strict-mode
   violations, an activity log whose newest row is another spec's customer).
   Before a full run, kill listeners on the API/web ports and wipe `.e2e-data`;
   to prove flakiness is pre-existing, run the same suite on the base commit
   (it failed 10 specs there while the clean branch run passed 53).
