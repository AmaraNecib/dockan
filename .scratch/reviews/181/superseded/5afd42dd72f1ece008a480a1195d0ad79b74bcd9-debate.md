# Debate — issue #181

Base: `8bf2a81` (origin/develop) · Reviewed head: `5afd42d` · Tier: **High-assurance**
Method: `debate` skill — one harsh critic (`reviewer`) and one charitable defender
(`oracle`) in parallel over `git diff 8bf2a81...5afd42d`, plus the full changed files,
`.scratch/implementation/181-design.md`, and `docs/adr/0011-...`.

The debate initially ran against `b6078e8`; the fixes below were committed as `5afd42d`
and the affected tests were re-run green before this file was pinned.

## Critic findings (verbatim severities)

1. **[6] The explicit key does not fully take precedence** — the keyed guard ORs the
   #177 signature, so two keyed requests with an identical signature are refused.
   Contradicts the design's stale TDD line. `drizzle-store.ts` keyed arm.
2. **[5] The DB backstop has a hole at the raw seam** — `insertSupplierEntry` writes an
   account-only ADJUSTMENT with `dedup_key = NULL`, invisible to the partial index.
3. **[5] The index does not backstop server-stamped duplicates** — claimed the stored key
   keeps the timestamp for a stamped row.
4. **[4] Backfill is not self-healing** — NULL-keyed rows created after the column
   exists are never re-keyed.
5. **[4] Cross-shape double-post window** — a retry that changes *both* the key and the
   timestamp misses both arms.
6. **[3] `isUniqueViolation`'s lowercase clause is dead** and the mapping is unverified.
7. **[3] The keyed arm omits the `kind = 'ADJUSTMENT'` predicate.**
8. **[2] Version-refusal rationale is factually wrong** — a v3 build writes NULL keys
   that the partial index exempts, so it cannot trip the index.
9. **[2] Design doc plan and implementation disagree on precedence** (documentation).
10. **[2] The canonical key is computed twice** in one request.

## Defender

Verdict approve. All eight defenses scored 8–10, including: the gap-1 fix is real and
proven end-to-end (`router.test.ts` changed-timestamp retry); the key cannot weaken the
#177 guard (the keyed path is a strict superset of the old refusals); the partial index
is correctly wired and only the guarded path passes a key; a cross-process race maps to
the same stable `DUPLICATE_ADJUSTMENT`; the linked path stays atomic; the migration is
additive, atomic, duplicate-tolerant, and idempotent; the encoding is NULL-safe.

## Synthesis and decisions

| # | Decision | Action |
|---|----------|--------|
| 1 | **Dismiss (deliberate).** The brief's money rule is "an identical repeat is refused"; the key must not disable the signature backstop (a fresh-key-per-retry client would then double-post). The union is the money-safe reading. | Fixed the stale design line (#9). |
| 2 | **Fix.** The raw seam is exactly the bypass the index defends; key it and map the violation. | `insertSupplierEntry` now computes the canonical key for an account-only ADJUSTMENT and maps a unique violation to `DUPLICATE`; new test. |
| 3 | **Dismiss (false alarm).** `adjustmentDedupKey` drops the timestamp from the **stored** key when `serverStamped` is true (not only from the query), so two stamped writes compute the same key and the index does catch the loser. | Verified in code; no change. |
| 4 | **Dismiss (by design).** A NULL-keyed row is only a pre-#177 legacy duplicate now (#2 fixed the live seam); re-keying it would collide and fail the index. Documented. | No change. |
| 5 | **Dismiss (out of contract).** A true retry resends the same shape; a client that changes both key and timestamp is outside idempotency-key semantics. Documented. | No change. |
| 6 | **Fix.** | `isUniqueViolation` now matches the exact `UNIQUE constraint failed` text plus the driver's `SQLITE_CONSTRAINT_UNIQUE` code; dead clause removed. |
| 7 | **Fix.** | The keyed arm is wrapped with `kind = 'ADJUSTMENT'`. |
| 8 | **Fix.** | Corrected the v4 rationale in `schema-version.ts` and ADR-0011: a v3 build writes NULL `dedup_key` rows that escape the new dedup. |
| 9 | **Fix.** | Design doc's TDD list now states a same-signature/different-key insert is refused. |
| 10 | **Dismiss (minor).** A pure function computed twice for one request; harmless and keeps the guard reusable. | No change. |

## Post-fix verification

- `apps/api/src/lib/supplier-ledger.test.ts`, `store/supplier-account-store.test.ts`,
  `store/supplier-adjustment-migration.test.ts` → 60 pass, 0 fail.
- `apps/api/src/rpc/router.test.ts -t 181` → 5 pass, 0 fail.
- `bun run lint` → 0 errors (the two new assertions carry `SAFETY:` comments).
