# Test audit — issue #181

Reviewed head: `333e870` · Base: `8bf2a81` · Tier: **High-assurance**
Method: `test-audit` skill — edge-case hunter, coverage analyst, and quality
reviewer in parallel (`reviewer` agents) over the changed tests and source.
The audit first ran against `5afd42d`; the fixes below are committed as `333e870`
and the affected suites were re-run green.

## Requirement coverage (analyst)

Every acceptance criterion maps to a test: R1 contract bounds; R2 changed-timestamp
retry refused (unit + store + router); R3 key is the request identity across fields;
R4 the key cannot weaken the signature; R5 key scoped per supplier; R7 canonical
`dedup_key` written + partial unique index shape; R8 raw duplicate INSERT refused by
the DB; R9 raw seam keyed; R10 v3→v4 additive backfill + legacy-duplicate exemption;
R11 v3 build refuses the v4 DB; R12 reopen idempotent; R14 legacy duplicate preserved.
Coverage is multi-layered across four seams (pure unit, store integration, seeded-DB
migration, RPC end-to-end) and asserts behaviour (balances, entry counts, exact stored
keys, PRAGMA shape), not "does not throw".

## Findings and decisions

| Finding | Risk | Decision |
|---------|------|----------|
| No test pins the canonical key **format**; a silent format change would keep every test green while migrated rows and new rows diverge (quality reviewer) | ORANGE | **Fix** — golden-string assertions for the `sig:` (explicit and stamped) and `key:` forms. |
| No adversarial encoding test for the "caller text cannot forge a separator" claim | YELLOW | **Fix** — a crafted reason and a key equal to a signature stay distinct. |
| Contract max boundary (`200`) only tested negatively; trim-induced canonicalisation not tested end-to-end | YELLOW | **Fix** — accept exactly 200 chars, then a padded identical key is `DUPLICATE_ADJUSTMENT`. |
| Migration test never proves the guard still catches the **unkeyed legacy duplicate** via the signature arm | YELLOW | **Fix** — `hasSupplierAdjustment` for the duplicate's signature is asserted after `setup()`. |
| Raw-seam test asserted `dedupKey` non-null only, not its shape | YELLOW | **Fix** — assert the exact time-inclusive canonical key. |
| No store/migration test stores a **server-stamped** adjustment's timestamp-free key, nor proves the index/guard catches a stamped duplicate at a fresh clock | ORANGE | **Fix** — stamp the stored key and assert a second stamped write at a different time is `DUPLICATE`. |
| Thin balance assertions in two router tests; one vacuous `?? []` assertion | YELLOW | **Fix** — assert the user-visible balance and the real entry list. |
| Duplicated `setupSupplier` helper across two describes | YELLOW | **Fix** — hoisted one module-level helper reused by both. |
| Migration **interruption** (ALTER + backfill atomicity) is claimed but not fault-injected | ORANGE | **Defer** — atomicity is by construction (one `BEGIN IMMEDIATE` around the `ALTER` + backfill with `ROLLBACK` on throw); there is no seam to inject a mid-backfill failure. Documented residual. |
| Concurrent migration race (`ensureSupplierAdjustmentDedupKeyColumn` reads `PRAGMA` outside the write lock) | ORANGE | **Defer** — the same shape as every pre-existing `ensure*` migration helper; a transient "duplicate column" boot failure self-heals on restart. Out of scope. |
| The `isUniqueViolation → DUPLICATE` catch is unreachable single-threaded (the guard catches first), so the linked-invoice rollback on an index race is untested | ORANGE | **Defer** — needs concurrency or a guard stub; the linked path's rollback is already covered by the existing `EXCEEDS_REMAINING` test. Documented residual. |
| A primary-key `id` collision would also map to `DUPLICATE` | YELLOW | **Dismiss** — `id()` is a `randomUUID`; negligible, and narrowing the match risks under-matching a driver reword. |
| `dedup_key = ''` (never emitted by the key function) is index-visible; non-finite raw amounts | YELLOW | **Dismiss** — unreachable through the guarded path; the guard re-validates the amount. |

## Verification

- `bun test src/lib/supplier-ledger.test.ts src/store/supplier-account-store.test.ts src/store/supplier-adjustment-migration.test.ts` → 63 pass, 0 fail.
- `bun test src/rpc/router.test.ts` → 207 pass, 0 fail (the hoisted helper did not disturb the issue-176 block).
- `bun run lint` → 0 errors; `bun run typecheck` → 0 errors.
