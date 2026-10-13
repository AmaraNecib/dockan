# Supplier adjustments: a sign change is a schema-version change; never clamp a signed balance

**Date:** 2026-10-13 · **Ticket:** 176 · **Area:** apps/api/src/store/drizzle-store.ts, apps/api/src/lib/supplier-ledger.ts, packages/contracts/src/core.ts

Issue #176 added a manual signed adjustment (تسوية) to the supplier account:
kind `ADJUSTMENT` with a `WE_OWE` / `THEY_OWE` direction. Lessons worth carrying:

1. **A new kind that changes a sign is a forward format change.** A version-2
   build's sign SQL (`kind IN ('PURCHASE','REFUND') ? + : -`) would read a
   «نسالوه» adjustment as a decrement and show a wrong balance with no error.
   `CURRENT_SCHEMA_VERSION` moved 2 → 3 so an older build refuses instead. The
   migration is additive (`ALTER TABLE … ADD COLUMN direction`) and the test
   proves the full sequence: old DB opens, column lands, rows are preserved,
   version stamps 3, an older build refuses, re-open is idempotent. Write that
   test as one ordered `it` with a numbered comment per step.

2. **Keep one sign expression and prove the SQL matches the pure signer.** The
   SQL CASE (`supplierSignedAmountSql`) feeds `debtSummaries` and `listParties`;
   `supplierBalance`/`supplierEntrySign` are the pure version. A store test
   asserts `debtSummaries().accountBalance === supplierBalance(entries)` for
   BOTH directions — a WE_OWE-only test hides a wrong ELSE branch.

3. **Never run a signed aggregate through a non-negative clamp.** `safeWhole`
   (used for invoice remaining) clamps to ≥ 0; applying it to the supplier
   `accountBalance` erased credits — the list showed 0 while the detail and
   /debts showed −300. A signed aggregate needs its own coercion
   (`safeSignedWhole`, clamps only to ±`MAX_SAFE_INTEGER`). The reviewer caught
   this; the list-agreement test now pins the sign.

4. **Refuse, don't reclassify, an over-linked discount.** A payment or return
   that exceeds an invoice's remaining legitimately spills to supplier credit
   (`splitAgainstRemaining`). A linked adjustment must NOT: an oversized
   write-off is a data-entry error, so it is refused
   (`ADJUSTMENT_EXCEEDS_REMAINING`) and the conditional UPDATE
   (`remaining >= amount`) is the final race guard inside `BEGIN IMMEDIATE`.

5. **When ALTER cannot add a table-level CHECK, validate at the store seam.**
   `ALTER TABLE ADD COLUMN` cannot add `CHECK (kind <> 'ADJUSTMENT' OR direction
   IS NOT NULL)`, so fresh DDL carries it and `insertSupplierEntry` asserts the
   pairing for migrated databases. Otherwise the SQL signs a null-direction
   ADJUSTMENT negative while the pure signer throws — two answers for one row.

6. **A `finally` that resets a state set in `catch` silently kills the fix.**
   The bulk screen's stale-expectation confirmation set `confirming = true` in
   the catch and `finally { setConfirming(false) }` wiped it. Clear dialog state
   on the success path, not in `finally`.

7. **A flat `["someQuery"]` is NOT a valid invalidation key for oRPC.**
   `@orpc/tanstack-query` generates `[path, { input?, type }]` where `path` is an
   array, so the real key starts with `[["someQuery"], …]`. Invalidating
   `["debtsData"]` (or even `["invoicesList"]`) marks nothing stale. Use the
   generated `orpc.x.queryKey()` for no-input procedures, and a
   `[["path"]]` prefix for a family with a required input. Keep those constants
   in a module tests do not `mock.module` wholesale. (This bug was live in
   several panels long before #176; the fix moved the two touched files.)

8. **Bun's `mock.module` is process-global, so a shared export must not live in
   a module that tests mock wholesale.** Adding `DEBTS_BY_PARTY_QUERY_KEY` to
   `@/lib/rpc` broke any run where `debts.test.tsx` (which mocks `@/lib/rpc`
   without it) loaded first — the export vanished. Move cross-cutting constants
   out of the mocked module, or re-export them from every mock.

9. **A tolerant amount reader stops a silent money drop; blocking beats
   guessing.** `parseWholeAmount` rejects `"1,000"`, so a bulk row was filtered
   out and the batch saved one amount short. Read grouping separators and
   Arabic-Indic digits, and BLOCK an invalid/incomplete row with a visible error
   rather than dropping it.
